import { auditsStore, DEFAULT_WORKSPACE_ID, skillRunsStore, type Tier } from "./store";
import { cheerioSiteConnector, githubMdxConnector } from "./connectors";
import type { ExternalWriteStatus, SeoFixVerificationInput } from "./connectors";
import {
  runAuditChecks,
  scoreFromFindings,
} from "./tools/seo/audit-checks";
import { addAltText, type AddAltTextInput } from "./tools/seo/add-alt-text";
import {
  scanAltTextGaps,
  type ScanAltTextGapsInput,
} from "./tools/seo/scan-alt-text-gaps";

// Internal tier registry. The tier gate (lib/agent/tier-gate.ts) reads this
// before dispatching any tool. Gemini never sees it — tiers are our control
// plane, not the agent's prompt surface.
//
// A `tier` can be a static value or a function of the input (auto-escalation).
// Add an entry here every time a new tool is added to `toolDeclarations` below.
type ToolMeta = {
  tier: Tier | ((input: Record<string, unknown>) => Tier);
};

export const toolMeta: Record<string, ToolMeta> = {
  // Reads only — safe to auto-execute.
  web_search: { tier: "GREEN" },
  read_url: { tier: "GREEN" },
  crawl_site: { tier: "GREEN" },
  crawl_competitor: { tier: "GREEN" },
  audit_seo: { tier: "GREEN" },
  scan_repo_for_alt_text_gaps: { tier: "GREEN" },

  // Persists a draft into the workspace. Reversible (drafts are just text),
  // so YELLOW — auto-execute but log as a notify event.
  write_draft: { tier: "YELLOW" },

  // Step 5 — first real PR-based write. YELLOW because rollback is built in
  // (close/revert the PR). Tool call records are persisted with the rollback
  // payload so /api/tool-calls/:id/rollback can undo it later.
  add_alt_text: { tier: "YELLOW" },

  // Orchestrated SEO write: one PR containing safe source-level fixes
  // like alt text and page metadata. It is not exposed directly to Gemini;
  // the seo orchestrator calls it after audit + source scan.
  apply_seo_fixes: {
    tier: (input) => (input.requiresApproval === true ? "RED" : "YELLOW"),
  },

  // `finish` is loop termination, not a real tool. The gate is not called for it.
};

// Tool definitions sent to Gemini so it knows what tools are available.
// The agent does ALL research, drafting, and reasoning autonomously.
// It only asks the human at the end via the proposedActions field of finish().
export const toolDeclarations = {
  functionDeclarations: [
    {
      name: "web_search",
      description:
        "Search the web for competitor information, marketing trends, keyword data, or any research needed for the marketing task.",
      parameters: {
        type: "OBJECT",
        properties: {
          query: {
            type: "STRING",
            description: "The search query",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "read_url",
      description:
        "Read and extract text content from a URL — competitor sites, landing pages, blog posts, or any public webpage.",
      parameters: {
        type: "OBJECT",
        properties: {
          url: {
            type: "STRING",
            description: "The full URL to read, must start with https://",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "crawl_site",
      description:
        "Fetch a public webpage and return STRUCTURED SEO data: title, meta description, headings, image alt-text gaps, link counts, JSON-LD schema, canonical, language, viewport. Use this for any SEO-related task instead of read_url — read_url returns raw text, crawl_site returns parsed fields.",
      parameters: {
        type: "OBJECT",
        properties: {
          url: {
            type: "STRING",
            description: "The full URL to crawl, must start with https://",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "crawl_competitor",
      description:
        "Read a competitor (or comparable) marketing page and return STRUCTURED facts tuned for competitive research: brand name, hero headline + subhead, top-level nav, visible CTAs, pricing signals, social proof snippets, footer links, and meta/OG descriptions. Use this instead of read_url for competitor profiling — read_url returns lossy text, crawl_competitor returns parsed fields the agent can compare against the user's product.",
      parameters: {
        type: "OBJECT",
        properties: {
          url: {
            type: "STRING",
            description: "The full URL to read, must start with https://",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "audit_seo",
      description:
        "Run a full SEO audit on a public URL: crawls the page, applies ~10 SEO checks (title, meta, headings, alt text, word count, canonical, schema, language, viewport, status), saves a persistent audit report, and returns findings + a health score 0-100.",
      parameters: {
        type: "OBJECT",
        properties: {
          url: {
            type: "STRING",
            description: "The full URL to audit, must start with https://",
          },
          scopeLabel: {
            type: "STRING",
            description:
              "Optional short label describing what part of the site this audit covers (e.g. 'pricing-page', 'blog-index').",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "add_alt_text",
      description:
        "Open a Pull Request that adds alt-text to images on the user's GitHub-MDX site. Use this AFTER audit_seo flags 'images-missing-alt' findings. PR-based — the user can close the PR to reject. Provide one patch per image: { filepath, imageSrc, altText }. Choose alt-text that's descriptive (8-15 words), uses keywords naturally, and accurately describes the image content.",
      parameters: {
        type: "OBJECT",
        properties: {
          patches: {
            type: "ARRAY",
            description: "One patch per image to fix.",
            items: {
              type: "OBJECT",
              properties: {
                filepath: {
                  type: "STRING",
                  description: "Path to the MDX/markdown file containing the image, e.g. 'content/blog/launch.mdx'.",
                },
                imageSrc: {
                  type: "STRING",
                  description: "The image src/url that identifies which <img> to update (must match what audit_seo found).",
                },
                altText: {
                  type: "STRING",
                  description: "The new alt text (8-15 words, descriptive).",
                },
              },
              required: ["filepath", "imageSrc", "altText"],
            },
          },
          reason: {
            type: "STRING",
            description: "Short explanation of why these alt-texts were chosen (saved in the PR body).",
          },
        },
        required: ["patches"],
      },
    },
    {
      name: "scan_repo_for_alt_text_gaps",
      description:
        "Scan the connected GitHub repository source files for <img> tags missing alt text. Returns exact filepath, imageSrc, and line values. Use this after audit_seo finds image alt-text issues and before add_alt_text, so you do not guess source file paths.",
      parameters: {
        type: "OBJECT",
        properties: {
          paths: {
            type: "ARRAY",
            description:
              "Optional repo folders/files to scan, such as ['content', 'app', 'pages']. Omit to scan common source folders.",
            items: { type: "STRING" },
          },
          maxFiles: {
            type: "NUMBER",
            description:
              "Optional maximum source files to inspect. Defaults to 80.",
          },
        },
      },
    },
    {
      name: "write_draft",
      description:
        "Save a finished piece of marketing content as a draft output. Use this freely — drafts are deliverables the user can copy or edit. Examples: ad copy, email body, social post, blog outline, strategy doc.",
      parameters: {
        type: "OBJECT",
        properties: {
          title: {
            type: "STRING",
            description: "A short, descriptive title for this draft",
          },
          content: {
            type: "STRING",
            description: "The full content of the draft",
          },
          type: {
            type: "STRING",
            enum: [
              "email",
              "social_post",
              "ad_copy",
              "blog_outline",
              "strategy_doc",
              "seo_recommendations",
              "competitor_report",
            ],
            description: "The type of content",
          },
        },
        required: ["title", "content", "type"],
      },
    },
    {
      name: "finish",
      description:
        "Deliver the final results. Call this when you've finished all research and drafting. Include proposedActions only for real executable work the user can approve to execute (post a social ad, send an email, allocate budget, publish content). Use an empty array for research/reporting outputs.",
      parameters: {
        type: "OBJECT",
        properties: {
          executiveSummary: {
            type: "STRING",
            description:
              "A clear 2-3 sentence summary of what you did and what the user is getting.",
          },
          findings: {
            type: "ARRAY",
            items: { type: "STRING" },
            description:
              "Key facts and insights discovered during research. Be specific — reference real data points.",
          },
          recommendations: {
            type: "ARRAY",
            items: { type: "STRING" },
            description:
              "Strategic recommendations the user should consider. Different from proposedActions — these are guidance, not executable.",
          },
          nextSteps: {
            type: "ARRAY",
            items: { type: "STRING" },
            description: "General next steps beyond the proposed actions.",
          },
          proposedActions: {
            type: "ARRAY",
            description:
              "Real-world executable actions the user can approve. Use [] when the skill is only producing research, strategy, or a draft. Examples: 'Post LinkedIn carousel about feature launch', 'Send 200 USD ad budget to Meta promotion', 'Email 50 beta users with feedback request', 'Publish the blog draft to website'.",
            items: {
              type: "OBJECT",
              properties: {
                type: {
                  type: "STRING",
                  enum: [
                    "social_post",
                    "email",
                    "budget_allocation",
                    "content_publish",
                    "ad_campaign",
                    "outreach",
                    "seo_update",
                  ],
                  description: "Category of the action",
                },
                title: {
                  type: "STRING",
                  description: "Short action title shown on the button card",
                },
                description: {
                  type: "STRING",
                  description:
                    "Full explanation of what will happen if the user approves",
                },
              },
              required: ["type", "title", "description"],
            },
          },
        },
        required: [
          "executiveSummary",
          "findings",
          "recommendations",
          "nextSteps",
          "proposedActions",
        ],
      },
    },
  ],
};

// Execute a tool call and return a result string back to the agent.
export type ToolResult = {
  result: string;
  // Only populated by rollbackable write tools — the loop persists these into
  // the tool-calls store so /api/tool-calls/:id/rollback can undo them later.
  changeId?: string;
  rollbackPayload?: unknown;
};

export async function executeTool(
  taskId: string,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const workspaceId = skillRunsStore.get(taskId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;

  switch (toolName) {
    case "web_search":
      return webSearch(args.query as string);

    case "read_url":
      return readUrl(args.url as string);

    case "crawl_site":
      return crawlSite(args.url as string);

    case "crawl_competitor":
      return crawlCompetitor(args.url as string);

    case "audit_seo":
      return auditSeo(args.url as string, workspaceId, args.scopeLabel as string | undefined);

    case "scan_repo_for_alt_text_gaps":
      return scanAltTextGapsDispatch(args as ScanAltTextGapsInput);

    case "add_alt_text":
      return addAltTextDispatch(args as unknown as AddAltTextInput);

    case "write_draft":
      skillRunsStore.addDraft(taskId, {
        title: args.title as string,
        content: args.content as string,
        type: args.type as string,
      });
      return { result: `Draft saved: "${args.title}" (${args.type})` };

    default:
      return { result: `Unknown tool: ${toolName}` };
  }
}

async function webSearch(query: string): Promise<{ result: string }> {
  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;

    const response = await fetch(url, {
      headers: { "User-Agent": "MarketPilotAI/1.0" },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return { result: `Search failed with HTTP ${response.status}` };
    }

    const data = (await response.json()) as Record<string, unknown>;
    const parts: string[] = [];

    if (typeof data.Abstract === "string" && data.Abstract.length > 0) {
      parts.push(`Summary: ${data.Abstract}`);
      if (data.AbstractURL) parts.push(`Source: ${data.AbstractURL}`);
    }

    if (Array.isArray(data.RelatedTopics)) {
      const topics = (data.RelatedTopics as Record<string, unknown>[])
        .filter((t) => typeof t.Text === "string")
        .slice(0, 5)
        .map(
          (t) =>
            `- ${t.Text as string}${t.FirstURL ? ` (${t.FirstURL as string})` : ""}`,
        );
      if (topics.length > 0) {
        parts.push("Related:", ...topics);
      }
    }

    if (parts.length === 0) {
      return {
        result: `No instant results for "${query}". Try read_url on a specific site instead.`,
      };
    }

    return { result: parts.join("\n") };
  } catch (err) {
    return {
      result: `Search error: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

async function readUrl(url: string): Promise<{ result: string }> {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return { result: "URL must start with http:// or https://" };
  }

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; MarketPilotAI/1.0)",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!response.ok) {
      return { result: `Could not read URL: HTTP ${response.status}` };
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (
      !contentType.includes("text/html") &&
      !contentType.includes("text/plain")
    ) {
      return {
        result: `URL returned non-text content (${contentType}). Only HTML pages can be read.`,
      };
    }

    const html = await response.text();

    const text = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
      .slice(0, 3000);

    return { result: `Content from ${url}:\n\n${text}` };
  } catch (err) {
    return {
      result: `Could not read URL: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

async function crawlSite(url: string): Promise<{ result: string }> {
  try {
    const page = await cheerioSiteConnector.crawl(url);
    // Keep the tool_result text-shaped (Gemini consumes it as a string).
    // We compress the JSON so the model can reason over it directly.
    return { result: JSON.stringify(page) };
  } catch (err) {
    return {
      result: `crawl_site error: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

async function crawlCompetitor(url: string): Promise<{ result: string }> {
  // Capability check per framework rule §5.5: tools verify the connector
  // supports the read before calling. Future site connectors (Playwright,
  // WordPress) may not implement crawlCompetitor — fail soft if so.
  if (!cheerioSiteConnector.capabilities.canReadCompetitor || !cheerioSiteConnector.crawlCompetitor) {
    return {
      result: "crawl_competitor error: site connector does not support competitor reads.",
    };
  }

  try {
    const facts = await cheerioSiteConnector.crawlCompetitor(url);
    return { result: JSON.stringify(facts) };
  } catch (err) {
    return {
      result: `crawl_competitor error: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

async function auditSeo(
  url: string,
  workspaceId: string,
  scopeLabel?: string,
): Promise<{ result: string }> {
  try {
    const page = await cheerioSiteConnector.crawl(url);
    const findings = runAuditChecks(page);
    const score = scoreFromFindings(findings);

    // Persist the audit so the Audits screen (future) and future runs can
    // read it as memory. Framework rule §5.10 — also gets logged via events
    // when the tier gate fires for this call.
    const audit = auditsStore.create({
      workspaceId,
      type: "seo",
      scopeJson: { url, scopeLabel: scopeLabel ?? null },
      findingsJson: { score, findings, page },
      triagedActionsJson: triage(findings),
    });

    const summary = {
      auditId: audit.id,
      url,
      score,
      counts: {
        critical: findings.filter((f) => f.severity === "critical").length,
        warning: findings.filter((f) => f.severity === "warning").length,
        info: findings.filter((f) => f.severity === "info").length,
      },
      findings,
    };

    return { result: JSON.stringify(summary) };
  } catch (err) {
    return {
      result: `audit_seo error: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

// Sort findings into rough action lanes. Green = info, Yellow = warning,
// Red = critical. The real triage logic gets fancier as we add more checks.
function triage(findings: { severity: string; id: string; message: string }[]) {
  const lanes: Record<"green" | "yellow" | "red", typeof findings> = {
    green: [],
    yellow: [],
    red: [],
  };
  for (const f of findings) {
    if (f.severity === "critical") lanes.red.push(f);
    else if (f.severity === "warning") lanes.yellow.push(f);
    else lanes.green.push(f);
  }
  return lanes;
}

// Adapter — the loop calls executeTool which returns `{ result }`. For
// rollbackable tools, we also surface the rollback payload + changeId so the
// loop can persist a ToolCall record. Keeps the existing return shape backwards
// compatible by tucking extras on the same object.
async function addAltTextDispatch(
  input: AddAltTextInput,
): Promise<{ result: string; changeId?: string; rollbackPayload?: unknown }> {
  const out = await addAltText(input);
  return {
    result: out.result,
    changeId: out.changeId,
    rollbackPayload: out.rollbackPayload,
  };
}

async function scanAltTextGapsDispatch(
  input: ScanAltTextGapsInput,
): Promise<{ result: string }> {
  try {
    const out = await scanAltTextGaps(input ?? {});
    return {
      result: JSON.stringify({
        success: out.success,
        gaps: out.gaps,
        summary: out.result,
      }),
    };
  } catch (err) {
    return {
      result: `scan_repo_for_alt_text_gaps error: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

// Rollback dispatcher. Given a tool name + the rollback payload that was saved
// when the tool ran, call the right connector to undo it. Used by
// /api/tool-calls/:id/rollback.
export async function rollbackToolCall(
  toolName: string,
  rollbackPayload: unknown,
): Promise<{ success: boolean; result: string }> {
  switch (toolName) {
    case "add_alt_text": {
      if (!githubMdxConnector.rollback) {
        return { success: false, result: "Connector has no rollback method." };
      }
      const r = await githubMdxConnector.rollback("alt-text", rollbackPayload);
      return {
        success: r.success,
        result: r.success
          ? `Rolled back: ${r.changeId}`
          : "Rollback failed (see backend logs).",
      };
    }
    case "apply_seo_fixes": {
      if (!githubMdxConnector.rollback) {
        return { success: false, result: "Connector has no rollback method." };
      }
      const r = await githubMdxConnector.rollback("seo-fixes", rollbackPayload);
      return {
        success: r.success,
        result: r.success
          ? `Rolled back: ${r.changeId}`
          : "Rollback failed (see backend logs).",
      };
    }
    default:
      return {
        success: false,
        result: `No rollback registered for tool "${toolName}".`,
      };
  }
}

export async function verifyToolCall(
  toolName: string,
  inputJson: unknown,
): Promise<{ success: boolean; result: string; details?: unknown }> {
  switch (toolName) {
    case "apply_seo_fixes": {
      return verifySeoFixToolCall(asSeoFixVerificationInput(inputJson));
    }
    case "add_alt_text": {
      const input = asRecord(inputJson);
      const patches = Array.isArray(input?.patches) ? input.patches : [];
      return verifySeoFixToolCall({ altText: patches as SeoFixVerificationInput["altText"] });
    }
    default:
      return {
        success: false,
        result: `No verification registered for tool "${toolName}".`,
      };
  }
}

async function verifySeoFixToolCall(
  input: SeoFixVerificationInput,
): Promise<{ success: boolean; result: string; details?: unknown }> {
  if (!githubMdxConnector.verifySeoFixes) {
    return {
      success: false,
      result: "GitHub connector has no SEO verification method.",
    };
  }

  try {
    const repoVerification = await githubMdxConnector.verifySeoFixes(input);
    const liveAudit = await verifyLiveAudit(input);
    const impact = buildSeoImpactSummary(repoVerification.ok, liveAudit);
    const result = [repoVerification.summary, impact.summary]
      .filter(Boolean)
      .join(" ");

    return {
      success: repoVerification.ok,
      result,
      details: {
        repoVerification,
        liveAudit,
        impact,
      },
    };
  } catch (err) {
    return {
      success: false,
      result: `Verification failed: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}

async function verifyLiveAudit(
  input: SeoFixVerificationInput,
): Promise<{
  ok: boolean;
  status: "improved" | "unchanged" | "regressed" | "unavailable";
  summary: string;
  beforeScore?: number;
  currentScore?: number;
  scoreDelta?: number;
  beforeFindingCount?: number;
  findingCount?: number;
  currentFindingCount?: number;
  findingDelta?: number;
  remainingCriticalCount?: number;
  remainingWarningCount?: number;
}> {
  const url = input.plan?.auditUrl;
  if (!url) {
    return {
      ok: true,
      status: "unavailable",
      summary: "No live audit URL was saved for this write.",
    };
  }

  try {
    const page = await cheerioSiteConnector.crawl(url);
    const findings = runAuditChecks(page);
    const currentScore = scoreFromFindings(findings);
    const beforeScore = input.plan?.healthScore;
    const beforeFindingCount = input.plan?.auditFindingCount;
    const currentFindingCount = findings.length;
    const scoreDelta =
      beforeScore === undefined ? undefined : currentScore - beforeScore;
    const findingDelta =
      beforeFindingCount === undefined ? undefined : currentFindingCount - beforeFindingCount;
    const improved =
      scoreDelta === undefined ? undefined : scoreDelta > 0 || (scoreDelta === 0 && (findingDelta ?? 0) < 0);
    const regressed =
      scoreDelta === undefined ? false : scoreDelta < 0 || (scoreDelta === 0 && (findingDelta ?? 0) > 0);
    const status =
      improved === true
        ? "improved"
        : regressed
          ? "regressed"
          : "unchanged";

    return {
      ok: status !== "regressed",
      status,
      summary:
        beforeScore === undefined
          ? `Live audit now scores ${currentScore}/100.`
          : `Live audit moved from ${beforeScore}/100 to ${currentScore}/100 (${formatSigned(scoreDelta ?? 0)} point(s)).`,
      beforeScore,
      currentScore,
      scoreDelta,
      beforeFindingCount,
      findingCount: findings.length,
      currentFindingCount,
      findingDelta,
      remainingCriticalCount: findings.filter((finding) => finding.severity === "critical").length,
      remainingWarningCount: findings.filter((finding) => finding.severity === "warning").length,
    };
  } catch (err) {
    return {
      ok: false,
      status: "unavailable",
      summary: `Live audit could not run: ${err instanceof Error ? err.message : "unknown"}. Repo checks can still pass if the PR was merged.`,
    };
  }
}

export function buildSeoImpactSummary(
  repoChecksPassed: boolean,
  liveAudit: {
    ok: boolean;
    status: "improved" | "unchanged" | "regressed" | "unavailable";
    summary: string;
    scoreDelta?: number;
    findingDelta?: number;
  },
): {
  verdict:
    | "verified_improvement"
    | "merged_no_improvement"
    | "needs_review"
    | "unavailable";
  label: string;
  summary: string;
  scoreDelta?: number;
  findingDelta?: number;
  repoChecksPassed: boolean;
  checkedAt: string;
} {
  if (!repoChecksPassed) {
    return {
      verdict: "needs_review",
      label: "Needs review",
      summary: `Expected source changes were not fully verified. ${liveAudit.summary}`,
      scoreDelta: liveAudit.scoreDelta,
      findingDelta: liveAudit.findingDelta,
      repoChecksPassed,
      checkedAt: new Date().toISOString(),
    };
  }

  if (liveAudit.status === "unavailable") {
    return {
      verdict: "unavailable",
      label: "Impact unavailable",
      summary: liveAudit.summary,
      scoreDelta: liveAudit.scoreDelta,
      findingDelta: liveAudit.findingDelta,
      repoChecksPassed,
      checkedAt: new Date().toISOString(),
    };
  }

  if (liveAudit.status === "regressed") {
    return {
      verdict: "needs_review",
      label: "Needs review",
      summary: `The PR merged, but the live audit regressed. ${liveAudit.summary}`,
      scoreDelta: liveAudit.scoreDelta,
      findingDelta: liveAudit.findingDelta,
      repoChecksPassed,
      checkedAt: new Date().toISOString(),
    };
  }

  if (liveAudit.status === "improved") {
    return {
      verdict: "verified_improvement",
      label: "Verified improvement",
      summary: `The merged PR improved the live audit. ${liveAudit.summary}`,
      scoreDelta: liveAudit.scoreDelta,
      findingDelta: liveAudit.findingDelta,
      repoChecksPassed,
      checkedAt: new Date().toISOString(),
    };
  }

  return {
    verdict: "merged_no_improvement",
    label: "Merged, no audit improvement",
    summary: `The source changes landed, but the live audit score did not improve. ${liveAudit.summary}`,
    scoreDelta: liveAudit.scoreDelta,
    findingDelta: liveAudit.findingDelta,
    repoChecksPassed,
    checkedAt: new Date().toISOString(),
  };
}

function formatSigned(value: number): string {
  if (value > 0) return `+${value}`;
  return `${value}`;
}

function asSeoFixVerificationInput(input: unknown): SeoFixVerificationInput {
  const record = asRecord(input);
  if (!record) return {};
  return record as SeoFixVerificationInput;
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  return input as Record<string, unknown>;
}

export async function inspectToolCallWriteStatus(
  toolName: string,
  rollbackPayload: unknown,
): Promise<ExternalWriteStatus> {
  switch (toolName) {
    case "add_alt_text":
    case "apply_seo_fixes": {
      if (!githubMdxConnector.inspectWriteStatus) {
        return unknownWriteStatus("GitHub connector has no write-status method.");
      }
      return githubMdxConnector.inspectWriteStatus(rollbackPayload);
    }
    default:
      return unknownWriteStatus(`No write-status check registered for tool "${toolName}".`);
  }
}

function unknownWriteStatus(summary: string): ExternalWriteStatus {
  return {
    provider: "unknown",
    kind: "unknown",
    state: "unknown",
    checkedAt: new Date().toISOString(),
    summary,
  };
}
