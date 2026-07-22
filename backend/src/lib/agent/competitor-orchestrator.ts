// Deterministic competitor-profiling orchestrator.
//
// Why this exists:
//   The generic LLM loop (lib/agent-loop.ts) was used for competitor profiling
//   until now. Two problems showed up in real runs:
//     1. Output structure was fragile — the loop asked Gemini to save a
//        markdown draft with specific headings, then parsed that markdown back
//        with regex to build the CompetitorProfileOutput. One heading typo or
//        bold marker and the structured output filled with "No clear gap
//        captured yet." fallbacks.
//     2. The agent's only real reading tool was read_url, which truncates at
//        3000 characters of raw text. That's not enough context to compare
//        positioning, pricing, and social proof against the user's product.
//
//   This file replaces the LLM-orchestrated path for the `competitor-profiling`
//   skill with a scripted pipeline:
//     1. Resolve the SkillRun + workspace.
//     2. Parse competitorUrls from the brief. Fail fast if none.
//     3. For each competitor URL → crawl_competitor → structured facts.
//     4. (Optional) crawl_competitor on the user's product URL if it's a real
//        public URL (not localhost / 127.0.0.1 / .local).
//     5. Load memory: product profile + last N competitor profile runs.
//     6. Build the Gemini prompt — pass structured facts, ask for typed JSON.
//     7. Call Gemini ONCE with responseMimeType: "application/json".
//     8. Validate the JSON against a Zod schema. Retry once on failure.
//     9. Build a markdown draft FROM the JSON (not parsed back FROM markdown).
//    10. Save the draft to the SkillRun.
//    11. Build CompetitorProfileOutput + recommendationList structured outputs.
//    12. Finalize the run.
//
//   Same architectural pattern as seo-orchestrator.ts — LLM picks the words,
//   code controls the structure. Much shorter (~300-400 lines target vs SEO's
//   3400) because competitor profiling never writes anything.
//
// Framework rules touched:
//   §5.5  — capability check via cheerioSiteConnector.capabilities.canReadCompetitor
//   §5.6  — orchestration lives here, not in the SKILL.md
//   §5.9  — no recursive self-invocation (no agent run spawns another agent run)
//   §5.10 — every step writes an event
//   §5.12 — the agent never modifies the product profile

import { z } from "zod";
import {
  DEFAULT_WORKSPACE_ID,
  eventsStore,
  skillRunsStore,
  type ProductProfile,
  type StructuredOutput,
} from "../store";
import { cheerioSiteConnector } from "../connectors";
import type { CompetitorPageFacts } from "../connectors/types";
import { loadMemory, type MemoryBundle } from "../memory/load";

const GEMINI_SYNTHESIS_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const GEMINI_TIMEOUT_MS = 30_000;

// Hard cap on competitor URLs per run. Bounded for three reasons:
//   1. Output quality — the LLM's attention is finite. 3-5 competitors gets
//      sharp analysis; 30 gets shallow generalities.
//   2. Token budget — each crawled page contributes ~500-1500 chars to the
//      synthesis prompt. 10 stays comfortably under Gemini 2.5 Flash's window
//      even with full memory + skill content attached.
//   3. Real workflow — marketing analysts compare 3-5 competitors at a time,
//      not 50. A user with more competitors should run focused batches.
const MAX_COMPETITORS_PER_RUN = 10;

// The JSON shape we ask Gemini to return. Validated with Zod after the call so
// a malformed response fails loudly here instead of poisoning the rest of the
// pipeline. Mirrors the CompetitorProfileOutput shape used by the frontend,
// plus run-level fields (executiveSummary, recommendations, nextSteps).
const competitorSynthesisSchema = z.object({
  executiveSummary: z.string().min(1),
  competitors: z
    .array(
      z.object({
        name: z.string().min(1),
        url: z.string().min(1),
        positioning: z.string().min(1),
        strengths: z.array(z.string()).max(4),
        weaknesses: z.array(z.string()).max(4),
        yourAdvantages: z.array(z.string()).max(4),
        yourGaps: z.array(z.string()).max(4),
        quickWins: z.array(z.string()).max(4),
      }),
    )
    .min(1),
  recommendations: z.array(z.string()).max(5),
  nextSteps: z.array(z.string()).max(8),
});

export type CompetitorSynthesis = z.infer<typeof competitorSynthesisSchema>;

// ----------------------------------------------------------------------------
//  Public entrypoint — wired into agent-loop.ts in step 6.
// ----------------------------------------------------------------------------

export async function runCompetitorProfilingOrchestrator(
  taskId: string,
  // Raw SKILL.md content. Threaded into the synthesis prompt so the LLM has
  // the marketing-craft guidance the skill author wrote.
  skillContent: string,
): Promise<void> {
  const run = skillRunsStore.get(taskId);
  if (!run) return;
  const workspaceId = run.workspaceId;

  eventsStore.append(
    "competitor_orchestrator_start",
    { skillRunId: taskId },
    workspaceId,
  );
  addStep(taskId, "tool_call", "Starting competitor profiling orchestrator.");

  // ---- 2. Parse competitor URLs ----
  const { urls: competitorUrls, totalFound: totalUrlsFound } = parseCompetitorUrls(
    run.inputContext.competitorUrls,
  );
  if (competitorUrls.length === 0) {
    failRun(
      taskId,
      "No competitor URLs provided. Add at least one URL (one per line) to the Competitor URLs field.",
    );
    return;
  }
  if (totalUrlsFound > competitorUrls.length) {
    const trimmedCount = totalUrlsFound - competitorUrls.length;
    addStep(
      taskId,
      "tool_result",
      `You pasted ${totalUrlsFound} competitor URLs; profiling the first ${competitorUrls.length} for quality. Re-run with the remaining ${trimmedCount} for a focused follow-up.`,
    );
    eventsStore.append(
      "competitor_urls_trimmed",
      {
        skillRunId: taskId,
        totalFound: totalUrlsFound,
        kept: competitorUrls.length,
        trimmed: trimmedCount,
      },
      workspaceId,
    );
  }
  addStep(
    taskId,
    "tool_result",
    `Parsed ${competitorUrls.length} competitor URL(s): ${competitorUrls.join(", ")}`,
  );

  // ---- 3. Crawl each competitor ----
  // Continue on partial failure (one slow site shouldn't kill the run).
  // failRun only if ALL crawls fail.
  const competitorFacts: CompetitorPageFacts[] = [];
  const competitorErrors: Array<{ url: string; error: string }> = [];

  for (const url of competitorUrls) {
    addStep(taskId, "tool_call", `crawl_competitor: ${url}`);
    try {
      const facts = await crawlCompetitorViaConnector(url);
      competitorFacts.push(facts);
      eventsStore.append(
        "competitor_page_crawled",
        {
          skillRunId: taskId,
          url,
          brandName: facts.brandName,
          ctaCount: facts.ctas.length,
          pricingSignalCount: facts.pricingSignals.length,
        },
        workspaceId,
      );
      addStep(
        taskId,
        "tool_result",
        `Crawled ${facts.brandName ?? url}: ${facts.ctas.length} CTAs, ${facts.pricingSignals.length} pricing signals, ${facts.socialProof.length} social-proof snippets.`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      competitorErrors.push({ url, error: message });
      eventsStore.append(
        "competitor_crawl_failed",
        { skillRunId: taskId, url, error: message },
        workspaceId,
      );
      addStep(taskId, "tool_result", `Failed to crawl ${url}: ${message}`);
    }
  }

  if (competitorFacts.length === 0) {
    failRun(
      taskId,
      `Could not read any of the ${competitorUrls.length} competitor URL(s). Errors: ${competitorErrors
        .map((e) => `${e.url} (${e.error})`)
        .join("; ")}`,
    );
    return;
  }

  // ---- 4. Optional: crawl the user's product URL ----
  // If the user gave us a real public URL, read it the same way as a
  // competitor — same shape, same fields — so the synthesis step can compare
  // apples to apples. Skip silently for localhost / private IPs / .local /
  // .test / .invalid hosts. When skipped, the synthesis step relies on the
  // typed product profile from memory (loaded in step 9).
  const yourProductUrlRaw = run.inputContext.yourProductUrl?.trim();
  let yourProductFacts: CompetitorPageFacts | undefined;
  let yourProductCrawlSkippedReason: string | undefined;

  if (yourProductUrlRaw && yourProductUrlRaw.length > 0) {
    const skipReason = nonPublicUrlReason(yourProductUrlRaw);
    if (skipReason) {
      yourProductCrawlSkippedReason = skipReason;
      addStep(
        taskId,
        "tool_result",
        `Skipping product URL crawl (${skipReason}). Synthesis will use the workspace product profile instead.`,
      );
      eventsStore.append(
        "competitor_product_crawl_skipped",
        { skillRunId: taskId, url: yourProductUrlRaw, reason: skipReason },
        workspaceId,
      );
    } else {
      addStep(taskId, "tool_call", `crawl_competitor (your product): ${yourProductUrlRaw}`);
      try {
        yourProductFacts = await crawlCompetitorViaConnector(yourProductUrlRaw);
        eventsStore.append(
          "competitor_product_crawled",
          {
            skillRunId: taskId,
            url: yourProductUrlRaw,
            brandName: yourProductFacts.brandName,
          },
          workspaceId,
        );
        addStep(
          taskId,
          "tool_result",
          `Crawled your product (${yourProductFacts.brandName ?? yourProductUrlRaw}): ${yourProductFacts.ctas.length} CTAs, ${yourProductFacts.pricingSignals.length} pricing signals.`,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : "unknown error";
        yourProductCrawlSkippedReason = `crawl failed: ${message}`;
        eventsStore.append(
          "competitor_product_crawl_failed",
          { skillRunId: taskId, url: yourProductUrlRaw, error: message },
          workspaceId,
        );
        addStep(
          taskId,
          "tool_result",
          `Could not crawl your product URL (${message}). Synthesis will use the workspace product profile instead.`,
        );
      }
    }
  } else {
    yourProductCrawlSkippedReason = "no product URL provided";
  }

  // ---- 5. Load memory ----
  // Pulls product profile, recent audits, recent performance, and (the new
  // bit from step 9) the last few completed competitor-profiling runs.
  // The synthesis step uses recentCompetitorRuns to flag follow-up changes
  // instead of starting from a blank slate every time.
  const memory: MemoryBundle = loadMemory(workspaceId);
  eventsStore.append(
    "competitor_memory_loaded",
    {
      skillRunId: taskId,
      hasProfile: !!memory.profile,
      recentCompetitorRunCount: memory.recentCompetitorRuns.length,
    },
    workspaceId,
  );

  // ---- 6/7. Gemini call with typed JSON output ----
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    failRun(taskId, "GEMINI_API_KEY is not set in backend/.env");
    return;
  }

  const synthesisInput: SynthesisInput = {
    competitorFacts,
    yourProductFacts,
    yourProductCrawlSkippedReason,
    profile: memory.profile,
    memory,
    skillContent,
    brief: run.inputContext,
  };
  const prompt = buildSynthesisPrompt(synthesisInput);

  addStep(
    taskId,
    "tool_call",
    `Asking Gemini to synthesize ${competitorFacts.length} competitor profile(s) into typed JSON.`,
  );
  eventsStore.append(
    "competitor_synthesis_requested",
    {
      skillRunId: taskId,
      competitorCount: competitorFacts.length,
      hasProductCrawl: !!yourProductFacts,
      promptCharCount: prompt.length,
    },
    workspaceId,
  );

  // ---- 8. Validate + retry + fallback ----
  // Retry policy (mirrors the SEO orchestrator's draftCopy):
  //   - Attempt 1: original prompt.
  //   - Attempt 2: same prompt + a "your previous reply was invalid because X"
  //     correction suffix. We only retry if attempt 1 failed for a recoverable
  //     reason (bad JSON, schema mismatch, transient 429/503). Auth errors
  //     (401/403) and 4xx fail-fast — retrying won't help.
  //   - If both attempts fail, fall back to a minimal-honest synthesis built
  //     directly from the crawled facts. The run completes, but the report
  //     tells the user clearly that the AI step failed.
  const synthesisOutcome = await synthesizeWithRetryAndFallback({
    apiKey,
    prompt,
    competitorFacts,
    yourProductFacts,
    profile: memory.profile,
  });
  const { synthesis, source: synthesisSource, errors: synthesisErrors } = synthesisOutcome;

  if (synthesisSource === "fallback") {
    eventsStore.append(
      "competitor_synthesis_fallback_used",
      {
        skillRunId: taskId,
        attemptErrors: synthesisErrors,
      },
      workspaceId,
    );
    addStep(
      taskId,
      "tool_result",
      `Gemini synthesis failed after ${synthesisErrors.length} attempt(s). Using fallback report built from crawled facts. Errors: ${synthesisErrors.join(" | ")}`,
    );
  } else {
    eventsStore.append(
      "competitor_synthesis_completed",
      {
        skillRunId: taskId,
        competitorCount: synthesis.competitors.length,
        recommendationCount: synthesis.recommendations.length,
        source: synthesisSource,
        priorAttemptFailures: synthesisErrors,
      },
      workspaceId,
    );
    addStep(
      taskId,
      "tool_result",
      synthesisSource === "gemini-retry"
        ? `Synthesis succeeded on retry: ${synthesis.competitors.length} competitor profile(s), ${synthesis.recommendations.length} recommendation(s). Retry was needed because: ${synthesisErrors[0] ?? "unknown"}`
        : `Synthesis returned ${synthesis.competitors.length} competitor profile(s), ${synthesis.recommendations.length} recommendation(s).`,
    );
  }

  // ---- 9/10. Build markdown draft FROM the JSON ----
  // The draft is the human-readable artifact (saved in Drafts, downloadable,
  // shareable). It's generated FROM the validated JSON — not the other way
  // around — so the draft and the structured output can never drift apart.
  const draftTitle = buildDraftTitle(synthesis, run.inputContext);
  const draftBody = buildCompetitorDraftMarkdown(synthesis, {
    source: synthesisSource,
    synthesisErrors,
    failedCompetitors: competitorErrors,
  });
  skillRunsStore.addDraft(taskId, {
    title: draftTitle,
    content: draftBody,
    type: "competitor_report",
  });
  eventsStore.append(
    "competitor_draft_saved",
    {
      skillRunId: taskId,
      title: draftTitle,
      bodyCharCount: draftBody.length,
    },
    workspaceId,
  );
  addStep(taskId, "tool_result", `Saved draft: "${draftTitle}" (${draftBody.length} chars).`);

  // ---- 11/12. Finalize ----
  // Build the structured outputs the dashboard reads, plus the final report
  // the run-detail view reads. All three derive from the same validated
  // synthesis JSON — single source of truth.
  const structuredOutputs = buildStructuredOutputs(synthesis);
  const findings = collectFindings(synthesis);

  // Re-read the run so we capture the draft saved one step earlier without
  // overwriting it.
  const finalRun = skillRunsStore.get(taskId);

  // If any competitors dropped out, prepend that to the executive summary so
  // the user sees it on the dashboard tile (which only renders the summary).
  const executiveSummary = competitorErrors.length > 0
    ? `Note: ${competitorErrors.length} of ${competitorUrls.length} competitor URL(s) could not be analyzed (${competitorErrors.map((e) => safeHost(e.url)).filter(Boolean).join(", ")}). ${synthesis.executiveSummary}`
    : synthesis.executiveSummary;

  skillRunsStore.update(taskId, {
    status: "completed",
    finalReport: {
      executiveSummary,
      findings,
      recommendations: synthesis.recommendations,
      nextSteps: synthesis.nextSteps,
      drafts: finalRun?.drafts ?? [],
      // Competitor profiling is drafts-only by design (catalog entry sets
      // defaultApprovalBehavior: "drafts-only"). Never create approvals.
      proposedActions: [],
      structuredOutputs,
    },
  });

  eventsStore.append(
    "competitor_orchestrator_complete",
    {
      skillRunId: taskId,
      synthesisSource,
      competitorCount: synthesis.competitors.length,
      structuredOutputCount: structuredOutputs.length,
      findingCount: findings.length,
      recommendationCount: synthesis.recommendations.length,
    },
    workspaceId,
  );
  addStep(
    taskId,
    "tool_result",
    `Run complete. ${synthesis.competitors.length} competitor profile(s) ready in the dashboard.`,
  );
}

// ----------------------------------------------------------------------------
//  Helpers — kept local; nothing exported until something needs to import it.
// ----------------------------------------------------------------------------

function addStep(
  taskId: string,
  type: "tool_call" | "tool_result",
  content: string,
): void {
  skillRunsStore.addStep(taskId, { type, content });
}

function failRun(taskId: string, error: string): void {
  const workspaceId =
    skillRunsStore.get(taskId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  eventsStore.append(
    "competitor_orchestrator_failed",
    { skillRunId: taskId, error },
    workspaceId,
  );
  skillRunsStore.update(taskId, { status: "failed", error });
}

// Extract every http(s) URL from the competitorUrls field. Users paste them
// one-per-line, comma-separated, or mixed — we accept all of those.
// Returns BOTH the full deduped list and the capped slice so callers can tell
// the user "we trimmed your list" with real numbers.
function parseCompetitorUrls(rawValue: string | undefined): {
  urls: string[];      // capped at MAX_COMPETITORS_PER_RUN
  totalFound: number;  // how many distinct URLs the user actually pasted
} {
  if (!rawValue) return { urls: [], totalFound: 0 };
  const matches = rawValue.match(/https?:\/\/[^\s,]+/g) ?? [];
  const seen = new Set<string>();
  const allUrls: string[] = [];
  for (const match of matches) {
    // Strip trailing punctuation that often clings to URLs in pasted text.
    const cleanUrl = match.replace(/[).;,]+$/, "");
    if (seen.has(cleanUrl)) continue;
    seen.add(cleanUrl);
    allUrls.push(cleanUrl);
  }
  return {
    urls: allUrls.slice(0, MAX_COMPETITORS_PER_RUN),
    totalFound: allUrls.length,
  };
}

// Return a human-readable reason the URL should not be crawled, or undefined
// if it looks publicly reachable. We don't want the agent fetching localhost
// (it'd read MarketPilot's own dev site and confuse it with the user's
// product), private IPs, or RFC-reserved test domains.
//
// This is a lightweight check — the actual fetch can still fail (DNS, TLS,
// 5xx). That's handled by the try/catch around the connector call.
export function nonPublicUrlReason(rawUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return "not a valid URL";
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `unsupported protocol: ${parsed.protocol}`;
  }

  const host = parsed.hostname.toLowerCase();

  if (host === "localhost" || host === "0.0.0.0") return "localhost";

  // Reserved TLDs that should never reach a real server.
  // .local / .lan / .internal — mDNS and LAN conventions.
  // .test / .example / .invalid / .localhost — RFC 2606 / 6761.
  const reservedTlds = [".local", ".lan", ".internal", ".test", ".example", ".invalid", ".localhost"];
  if (reservedTlds.some((tld) => host.endsWith(tld))) {
    return `reserved hostname (${host})`;
  }

  // IPv4 private + loopback ranges.
  // 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16.
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    if (a === 127) return "loopback IP";
    if (a === 10) return "private IP (10.0.0.0/8)";
    if (a === 192 && b === 168) return "private IP (192.168.0.0/16)";
    if (a === 172 && b >= 16 && b <= 31) return "private IP (172.16.0.0/12)";
    if (a === 169 && b === 254) return "link-local IP";
  }

  // IPv6 loopback.
  if (host === "::1" || host === "[::1]") return "IPv6 loopback";

  return undefined;
}

// Wrap the connector call so the orchestrator never depends on the connector
// surface directly. If a connector swap happens (Playwright, etc.), this
// helper is the only line that changes.
async function crawlCompetitorViaConnector(
  url: string,
): Promise<CompetitorPageFacts> {
  if (
    !cheerioSiteConnector.capabilities.canReadCompetitor ||
    !cheerioSiteConnector.crawlCompetitor
  ) {
    throw new Error("Site connector does not support competitor reads.");
  }
  return cheerioSiteConnector.crawlCompetitor(url);
}

// ----------------------------------------------------------------------------
//  Synthesis (Gemini call + Zod-validated parse)
// ----------------------------------------------------------------------------

type SynthesisInput = {
  competitorFacts: CompetitorPageFacts[];
  yourProductFacts?: CompetitorPageFacts;
  yourProductCrawlSkippedReason?: string;
  profile: ProductProfile | null;
  memory: MemoryBundle;
  skillContent: string;
  brief: Record<string, string>;
};

// Build the single prompt we send to Gemini. We feed it:
//   1. Identity rules (don't confuse MarketPilot with the user's product).
//   2. The user's product — either crawled facts or the workspace profile.
//   3. Each competitor's structured facts.
//   4. Recent competitor-profiling memory (so it can flag follow-up changes).
//   5. The SKILL.md content for marketing-craft guidance.
//   6. The JSON schema it must return, with field-by-field instructions.
function buildSynthesisPrompt(input: SynthesisInput): string {
  const parts: string[] = [];

  parts.push("You are MarketPilot AI, an autonomous marketing agent.");
  parts.push(
    "Your job: produce a STRUCTURED competitor profile as JSON. Do not include any text outside the JSON object.",
  );
  parts.push("");

  parts.push("IDENTITY RULES:");
  parts.push(
    "- MarketPilot AI is the software running this analysis. It is NOT the user's product.",
  );
  parts.push(
    "- The user's product is described in YOUR PRODUCT below. The competitor(s) are in COMPETITOR FACTS.",
  );
  parts.push(
    "- Refer to the user's product by its actual name from YOUR PRODUCT. Do not call it MarketPilot AI unless that is literally its name.",
  );
  parts.push("");

  parts.push("YOUR PRODUCT:");
  parts.push(renderYourProductBlock(input));
  parts.push("");

  parts.push("COMPETITOR FACTS (one block per competitor):");
  for (const facts of input.competitorFacts) {
    parts.push(renderCompetitorFactsBlock(facts));
    parts.push("");
  }

  // Memory is rendered via the shared renderer (in load.ts) so the format
  // matches every other place memory appears. It includes recent-competitor
  // runs when the skill id is "competitor-profiling".
  parts.push("WORKSPACE MEMORY + PRIOR RUNS:");
  parts.push(renderMemoryForSynthesis(input.memory));
  parts.push("");

  if (input.skillContent.trim().length > 0) {
    parts.push("MARKETING SKILL GUIDANCE (from .agents/skills/competitor-profiling/SKILL.md):");
    parts.push(truncateForPrompt(input.skillContent, 4000));
    parts.push("");
  }

  parts.push("RETURN JSON MATCHING THIS SHAPE EXACTLY:");
  parts.push("```json");
  parts.push(
    JSON.stringify(
      {
        executiveSummary:
          "2-3 sentences summarizing what the user can take away from this analysis. Mention the user's product by name.",
        competitors: [
          {
            name: "Competitor brand name (string)",
            url: "Competitor URL (string)",
            positioning:
              "One-sentence summary of how the competitor positions itself, in their own words where possible.",
            strengths: [
              "Up to 4 short bullets. What the competitor does well — clarity, design, social proof, pricing transparency, etc.",
            ],
            weaknesses: [
              "Up to 4 short bullets. What the competitor's page lacks or does poorly.",
            ],
            yourAdvantages: [
              "Up to 4 short bullets. Where the user's product appears to be ahead of THIS competitor. Be specific — reference real facts.",
            ],
            yourGaps: [
              "Up to 4 short bullets. Where the user's product appears to be behind THIS competitor. Concrete, actionable.",
            ],
            quickWins: [
              "Up to 4 short bullets. Concrete moves the user could test this week to close a gap or amplify an advantage.",
            ],
          },
        ],
        recommendations: [
          "Up to 5 strategic recommendations across all competitors. Not the same as quickWins — these are bigger plays.",
        ],
        nextSteps: [
          "Up to 8 immediate next steps the user can take after reading this report.",
        ],
      },
      null,
      2,
    ),
  );
  parts.push("```");
  parts.push("");

  parts.push("RULES FOR THE OUTPUT:");
  parts.push("- Return ONE valid JSON object. No prose, no markdown fences in the actual response.");
  parts.push("- Every bullet must be one sentence. Short and scannable.");
  parts.push("- Tie each bullet to a real fact from COMPETITOR FACTS or YOUR PRODUCT — do not invent details.");
  parts.push("- If a section truly has nothing to say, return an empty array rather than fabricating filler.");
  parts.push("- Do not repeat the same point across strengths/weaknesses/yourAdvantages/yourGaps.");

  return parts.join("\n");
}

function renderYourProductBlock(input: SynthesisInput): string {
  if (input.yourProductFacts) {
    return renderCompetitorFactsBlock(input.yourProductFacts);
  }

  // The user explicitly provided a product URL but it could not be crawled
  // (e.g. localhost, private IP, connection refused). Do NOT substitute the
  // workspace profile — that profile describes MarketPilot AI (the agent),
  // not the user's actual product. Tell Gemini there is no product context
  // so it skips yourAdvantages/yourGaps rather than hallucinating comparisons.
  if (input.yourProductCrawlSkippedReason) {
    return [
      `(Product URL was provided but could not be crawled: ${input.yourProductCrawlSkippedReason})`,
      "(No product context is available. Leave yourAdvantages and yourGaps empty for every competitor. Focus the analysis on the competitor's own positioning, strengths, and weaknesses.)",
    ].join("\n");
  }

  // No URL was provided at all — use the workspace profile if it has been
  // filled in. Tell Gemini these are user-typed claims, not crawl-verified.
  const profile = input.profile;
  if (profile) {
    const lines: string[] = [
      "(No product URL provided. The fields below come from the user's typed product profile.)",
      `Brand: ${profile.productName}`,
    ];
    if (profile.tagline) lines.push(`Tagline: ${profile.tagline}`);
    if (profile.positioning) lines.push(`Positioning: ${profile.positioning}`);
    if (profile.features.length > 0) lines.push(`Features: ${profile.features.join(", ")}`);
    if (profile.differentiators.length > 0) {
      lines.push(`Differentiators: ${profile.differentiators.join(", ")}`);
    }
    if (profile.icp) lines.push(`ICP: ${profile.icp}`);
    return lines.join("\n");
  }

  return "(No product URL or profile provided. Leave yourAdvantages and yourGaps empty for every competitor.)";
}

function renderCompetitorFactsBlock(facts: CompetitorPageFacts): string {
  const lines: string[] = [];
  lines.push(`URL: ${facts.url}`);
  if (facts.brandName) lines.push(`Brand: ${facts.brandName}`);
  if (facts.hero.headline) lines.push(`Hero headline: ${facts.hero.headline}`);
  if (facts.hero.subhead) lines.push(`Hero subhead: ${facts.hero.subhead}`);
  if (facts.metaDescription) lines.push(`Meta description: ${facts.metaDescription}`);
  if (facts.ogDescription && facts.ogDescription !== facts.metaDescription) {
    lines.push(`OG description: ${facts.ogDescription}`);
  }
  if (facts.navItems.length > 0) lines.push(`Top nav: ${facts.navItems.join(" | ")}`);
  if (facts.ctas.length > 0) lines.push(`CTAs: ${facts.ctas.join(" | ")}`);
  if (facts.pricingSignals.length > 0) {
    lines.push("Pricing signals:");
    for (const signal of facts.pricingSignals) lines.push(`  - ${signal}`);
  }
  if (facts.socialProof.length > 0) {
    lines.push("Social proof:");
    for (const proof of facts.socialProof) lines.push(`  - ${proof}`);
  }
  if (facts.footerLinks.length > 0) {
    lines.push(`Footer links: ${facts.footerLinks.join(" | ")}`);
  }
  return lines.join("\n");
}

function renderMemoryForSynthesis(memory: MemoryBundle): string {
  const lines: string[] = [];
  if (memory.profile) {
    lines.push(
      `Workspace product: ${memory.profile.productName} (industry: ${memory.profile.industry || "unspecified"})`,
    );
  }
  if (memory.recentCompetitorRuns.length > 0) {
    lines.push(`Last ${memory.recentCompetitorRuns.length} competitor profiling run(s):`);
    for (const r of memory.recentCompetitorRuns) {
      const urls = r.competitorUrls.length > 0 ? r.competitorUrls.join(", ") : "(no URLs)";
      lines.push(`- [${r.createdAt.slice(0, 10)}] ${urls}`);
      if (r.executiveSummary) {
        lines.push(`    Summary: ${truncateForPrompt(r.executiveSummary, 220)}`);
      }
      if (r.gaps.length > 0) {
        lines.push("    Previously flagged gaps:");
        for (const gap of r.gaps) lines.push(`      - ${truncateForPrompt(gap, 160)}`);
      }
    }
    lines.push(
      "Use this history to flag follow-up changes (e.g. 'pricing is now visible', 'a previously-flagged gap is still open') instead of starting from a blank slate.",
    );
  }
  return lines.length > 0 ? lines.join("\n") : "(no prior memory)";
}

function truncateForPrompt(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

// Call Gemini once with the synthesis prompt, parse the JSON body, validate
// against the Zod schema. Throws on any failure (HTTP, parse, schema). Step
// 11 wraps this with retry + fallback.
async function callGeminiForSynthesis(
  apiKey: string,
  prompt: string,
): Promise<CompetitorSynthesis> {
  const res = await fetch(`${GEMINI_SYNTHESIS_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  const candidate = (json.candidates as Record<string, unknown>[] | undefined)?.[0];
  const content = candidate?.content as Record<string, unknown> | undefined;
  const responseParts = content?.parts as Array<{ text?: string }> | undefined;
  const text = responseParts?.[0]?.text ?? "";

  if (!text) {
    throw new Error("Gemini returned an empty response body.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown JSON parse error";
    throw new Error(`Gemini response was not valid JSON: ${message}. First 200 chars: ${text.slice(0, 200)}`);
  }

  const result = competitorSynthesisSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const issuePath = issue?.path?.join(".") ?? "(unknown)";
    throw new Error(
      `Gemini response failed schema validation at "${issuePath}": ${issue?.message ?? "no message"}.`,
    );
  }

  return result.data;
}

// ----------------------------------------------------------------------------
//  Retry + fallback driver
// ----------------------------------------------------------------------------

type SynthesisOutcome = {
  synthesis: CompetitorSynthesis;
  source: "gemini" | "gemini-retry" | "fallback";
  // Strings describing each prior failure, oldest first. Empty when attempt 1
  // succeeded with no retries.
  errors: string[];
};

async function synthesizeWithRetryAndFallback(args: {
  apiKey: string;
  prompt: string;
  competitorFacts: CompetitorPageFacts[];
  yourProductFacts?: CompetitorPageFacts;
  profile: ProductProfile | null;
}): Promise<SynthesisOutcome> {
  const errors: string[] = [];

  // Attempt 1: original prompt.
  try {
    const synthesis = await callGeminiForSynthesis(args.apiKey, args.prompt);
    return { synthesis, source: "gemini", errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    errors.push(`attempt 1: ${message}`);
    if (!isRecoverableError(message)) {
      // Auth / 4xx-config failures won't be fixed by retrying. Skip retry,
      // go straight to fallback so the user still gets something useful.
      return {
        synthesis: buildFallbackSynthesis({
          competitorFacts: args.competitorFacts,
          yourProductFacts: args.yourProductFacts,
          profile: args.profile,
          errors,
        }),
        source: "fallback",
        errors,
      };
    }
  }

  // Attempt 2: append a correction note pointing at the prior failure. The
  // model often fixes itself when told exactly what went wrong.
  const retryPrompt = `${args.prompt}\n\nIMPORTANT: A previous attempt failed because: ${errors[0]}. Return JSON only — no markdown fences, no prose outside the JSON object. Match the schema exactly.`;
  try {
    const synthesis = await callGeminiForSynthesis(args.apiKey, retryPrompt);
    return { synthesis, source: "gemini-retry", errors };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    errors.push(`attempt 2: ${message}`);
  }

  // Both attempts failed. Build a minimal honest report from facts alone so
  // the user still gets something they can act on, with a clear note that
  // the AI step did not run.
  return {
    synthesis: buildFallbackSynthesis({
      competitorFacts: args.competitorFacts,
      yourProductFacts: args.yourProductFacts,
      profile: args.profile,
      errors,
    }),
    source: "fallback",
    errors,
  };
}

// Classify a Gemini error message. Anything pointing at the response shape
// (JSON parse, schema validation) or transient infra (429, 503, timeout) is
// worth retrying with a sharper prompt. Anything pointing at config (401,
// 403, missing key) won't change between calls.
function isRecoverableError(message: string): boolean {
  const lower = message.toLowerCase();
  if (lower.startsWith("gemini 401") || lower.startsWith("gemini 403")) return false;
  if (lower.startsWith("gemini 4")) {
    // Other 4xx are usually request-shape problems — retrying with the same
    // request won't help. The exception is 429 (rate limit) which IS worth
    // retrying.
    return lower.startsWith("gemini 429");
  }
  // 5xx, network/timeout aborts, parse failures, schema failures: all worth
  // one more shot with the sharper prompt.
  return true;
}

// Build a fact-only report when Gemini is unavailable. This is intentionally
// modest — it surfaces what we crawled without trying to synthesize claims
// the LLM didn't make. The executiveSummary is upfront about the degraded
// state so users don't think this is the real analysis.
function buildFallbackSynthesis(args: {
  competitorFacts: CompetitorPageFacts[];
  yourProductFacts?: CompetitorPageFacts;
  profile: ProductProfile | null;
  errors: string[];
}): CompetitorSynthesis {
  const productLabel =
    args.yourProductFacts?.brandName ?? args.profile?.productName ?? "your product";

  return {
    executiveSummary: `AI synthesis was unavailable for this run (${args.errors.length} attempt(s) failed: ${truncateForPrompt(args.errors.join(" | "), 200)}). The competitor pages below were crawled successfully, but the comparative analysis has been skipped. Re-run when the AI service is available.`,
    competitors: args.competitorFacts.map((facts) => {
      const positioning =
        facts.ogDescription ||
        facts.metaDescription ||
        facts.hero.subhead ||
        facts.hero.headline ||
        `(No positioning text was visible on ${facts.url}.)`;
      return {
        name: facts.brandName ?? facts.url,
        url: facts.url,
        positioning,
        // We surface raw observed facts. We don't fabricate strengths/weaknesses
        // because that's exactly what the LLM was supposed to do.
        strengths: factualObservations(facts, "strengths"),
        weaknesses: [],
        yourAdvantages: [],
        yourGaps: [],
        quickWins: [],
      };
    }),
    recommendations: [
      `Re-run competitor profiling for ${productLabel} once Gemini is available — this report contains crawl data only.`,
    ],
    nextSteps: [
      "Open the run trace to see the underlying Gemini errors.",
      "Confirm GEMINI_API_KEY is set in backend/.env, then re-run.",
    ],
  };
}

// ----------------------------------------------------------------------------
//  Draft rendering — markdown built FROM the validated synthesis JSON.
// ----------------------------------------------------------------------------

// Pick a clear title for the saved draft. Single competitor → name the
// competitor. Multiple → "Competitive intelligence — N competitors". The
// title appears in the Drafts feed and in the run detail header.
function buildDraftTitle(
  synthesis: CompetitorSynthesis,
  brief: Record<string, string>,
): string {
  const angle = brief.comparisonAngle?.trim();
  const angleSuffix = angle ? ` (${angle})` : "";
  if (synthesis.competitors.length === 1) {
    const c = synthesis.competitors[0]!;
    return `Competitor profile: ${c.name}${angleSuffix}`;
  }
  return `Competitive intelligence — ${synthesis.competitors.length} competitors${angleSuffix}`;
}

// Build the markdown body. The five canonical headings come from the
// briefing — the dashboard's CompetitorProfileCard expects this exact
// structure, and downstream tools (export, share, future Notion sync) can
// rely on it. One sentence per bullet. Empty arrays render an honest
// "none captured" line so a reader doesn't wonder whether a section is
// missing or just empty.
export function buildCompetitorDraftMarkdown(
  synthesis: CompetitorSynthesis,
  meta: {
    source: "gemini" | "gemini-retry" | "fallback";
    synthesisErrors: string[];
    failedCompetitors?: Array<{ url: string; error: string }>;
  },
): string {
  const lines: string[] = [];

  // Header block — banner only when synthesis was degraded so users
  // immediately see they're looking at fallback output.
  if (meta.source === "fallback") {
    lines.push(
      "> **AI synthesis was unavailable for this run.** This report contains crawl-only observations, not comparative analysis. Re-run when Gemini is available.",
    );
    if (meta.synthesisErrors.length > 0) {
      lines.push(
        `> Errors: ${meta.synthesisErrors.map((e) => truncateForPrompt(e, 180)).join(" | ")}`,
      );
    }
    lines.push("");
  }
  // We deliberately do NOT surface a "synthesis succeeded on retry" banner
  // anymore. The retry succeeded — the user doesn't need to see the internal
  // schema-validation error from the first attempt. The retry log lives in
  // the events table for ops debugging instead.

  // If any competitor URLs failed to crawl, show that prominently up top.
  // The user needs to know which competitors are missing from this analysis —
  // silent omission is what produced the "PRIME-only report when Monster +
  // Red Bull were also requested" bug.
  const failed = meta.failedCompetitors ?? [];
  if (failed.length > 0) {
    lines.push(
      `> **${failed.length} competitor URL(s) could not be analyzed** and are not included below:`,
    );
    for (const f of failed) {
      lines.push(`> - ${f.url} — ${truncateForPrompt(f.error, 160)}`);
    }
    lines.push(
      "> If this is a site you need analyzed, try a different URL (e.g. their /about or /pricing page) or paste the page content manually.",
    );
    lines.push("");
  }

  // 1) Executive readout — top-level paragraph.
  lines.push("## Executive readout");
  lines.push(synthesis.executiveSummary.trim() || "(No executive summary captured.)");
  lines.push("");

  // 2-6) One section per competitor with the five canonical sub-headings.
  // We repeat the headings per competitor (rather than one big "Competitor is
  // ahead" section pooled across competitors) so multi-competitor reports
  // stay scannable — each competitor gets its own block.
  for (const competitor of synthesis.competitors) {
    lines.push(`### ${competitor.name}`);
    lines.push(`URL: ${competitor.url}`);
    if (competitor.positioning?.trim()) {
      lines.push("");
      lines.push(`**Positioning:** ${competitor.positioning.trim()}`);
    }
    lines.push("");

    // "Competitor is ahead" maps to the competitor's strengths — the things
    // they do that put pressure on the user's product.
    lines.push("#### Competitor is ahead");
    appendBulletList(lines, competitor.strengths, "No specific competitor strengths captured.");
    lines.push("");

    lines.push("#### Your product may be ahead");
    appendBulletList(lines, competitor.yourAdvantages, "No clear advantage captured for this competitor.");
    lines.push("");

    lines.push("#### Gaps to fix");
    appendBulletList(lines, competitor.yourGaps, "No specific gaps captured.");
    lines.push("");

    lines.push("#### Quick wins");
    appendBulletList(lines, competitor.quickWins, "No quick wins captured.");
    lines.push("");

    if (competitor.weaknesses.length > 0) {
      lines.push("#### Competitor weaknesses (for reference)");
      appendBulletList(lines, competitor.weaknesses, "");
      lines.push("");
    }
  }

  // 7) Cross-competitor recommendations + next steps.
  if (synthesis.recommendations.length > 0) {
    lines.push("## Strategic recommendations");
    appendBulletList(lines, synthesis.recommendations, "");
    lines.push("");
  }
  if (synthesis.nextSteps.length > 0) {
    lines.push("## Next steps");
    appendBulletList(lines, synthesis.nextSteps, "");
    lines.push("");
  }

  // Trim trailing blank lines so the saved draft doesn't end with empties.
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function appendBulletList(lines: string[], items: string[], fallback: string): void {
  if (items.length === 0) {
    if (fallback) lines.push(`_${fallback}_`);
    return;
  }
  for (const item of items) {
    const cleaned = item.trim();
    if (cleaned.length === 0) continue;
    lines.push(`- ${cleaned}`);
  }
}

// ----------------------------------------------------------------------------
//  Finalization — turn the validated synthesis into the wire shapes the
//  dashboard and run-detail view read.
// ----------------------------------------------------------------------------

// Build the StructuredOutput[] the frontend renders. Two entries, both derived
// directly from the synthesis JSON:
//   1. competitorProfile — the per-competitor expandable card on the dashboard
//      and inside the run detail.
//   2. recommendationList — cross-competitor strategic recommendations,
//      prioritized roughly by index (LLM ordered them by importance).
function buildStructuredOutputs(
  synthesis: CompetitorSynthesis,
): StructuredOutput[] {
  const outputs: StructuredOutput[] = [];

  outputs.push({
    type: "competitorProfile",
    data: {
      title:
        synthesis.competitors.length === 1
          ? `Competitor profile: ${synthesis.competitors[0]!.name}`
          : "Competitor profiles",
      competitors: synthesis.competitors.map((c) => ({
        name: c.name,
        url: c.url,
        positioning: c.positioning,
        strengths: c.strengths,
        weaknesses: c.weaknesses,
        yourAdvantages: c.yourAdvantages,
        yourGaps: c.yourGaps,
        quickWins: c.quickWins,
      })),
    },
  });

  if (synthesis.recommendations.length > 0) {
    outputs.push({
      type: "recommendationList",
      data: {
        title: "Competitive opportunities",
        items: synthesis.recommendations.map((recommendation, index) => ({
          title: `Opportunity ${index + 1}`,
          detail: recommendation,
          // First recommendation is "high" priority, next two are "medium",
          // rest are "low". Matches how the LLM tends to order them.
          priority: index === 0 ? "high" : index < 3 ? "medium" : "low",
        })),
      },
    });
  }

  return outputs;
}

// Flatten the synthesis into a `findings` list for the FinalReport. We pull
// from yourGaps (most actionable) and competitor strengths (the "they're
// ahead" facts) so the legacy non-structured run view still reads cleanly
// for users who scroll past the structured card.
function collectFindings(synthesis: CompetitorSynthesis): string[] {
  const findings: string[] = [];
  for (const competitor of synthesis.competitors) {
    for (const gap of competitor.yourGaps) {
      findings.push(`[gap vs ${competitor.name}] ${gap}`);
    }
    for (const strength of competitor.strengths) {
      findings.push(`[${competitor.name} strength] ${strength}`);
    }
  }
  return findings;
}

// Surface a handful of observed facts as 'strengths' in the fallback — these
// are things the competitor's page actually does, with no AI judgement
// involved. Capped at 4 to satisfy the schema.
function factualObservations(
  facts: CompetitorPageFacts,
  _kind: "strengths",
): string[] {
  const items: string[] = [];
  if (facts.hero.headline) {
    items.push(`Hero headline visible: "${truncateForPrompt(facts.hero.headline, 120)}"`);
  }
  if (facts.ctas.length > 0) {
    items.push(`Primary CTAs detected: ${facts.ctas.slice(0, 3).join(", ")}`);
  }
  if (facts.pricingSignals.length > 0) {
    items.push("Pricing signals are visible on the page.");
  }
  if (facts.socialProof.length > 0) {
    items.push(`Social proof present (${facts.socialProof.length} snippet(s)).`);
  }
  return items.slice(0, 4);
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}
