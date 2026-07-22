// Memory loader. Pure function that gathers everything the agent should know
// about the workspace before it runs.
//
// Framework rule §6 step 1: "load memory" comes before plan/execute. Today
// it's still inline (the loop calls this), but when we split agent-loop.ts
// into agent/core.ts, this becomes the first step of the core orchestrator.

import {
  DEFAULT_WORKSPACE_ID,
  auditsStore,
  performanceStore,
  productProfileStore,
  skillRunsStore,
  type Audit,
  type PerformanceSnapshot,
  type ProductProfile,
  type StructuredOutput,
} from "../store";

// One compact summary of a past competitor-profiling run, suitable to render
// into a future run's prompt. Intentionally minimal — full run details bloat
// the context window for little gain.
export type RecentCompetitorRunSummary = {
  createdAt: string;
  competitorUrls: string[];
  executiveSummary: string;
  gaps: string[]; // pulled from the last run's CompetitorProfileOutput.yourGaps
};

export type MemoryBundle = {
  profile: ProductProfile | null;
  recentAudits: Audit[];     // newest first, capped
  recentPerformance: PerformanceSnapshot[]; // newest first, capped
  recentCompetitorRuns: RecentCompetitorRunSummary[]; // newest first, capped
};

const RECENT_AUDITS_LIMIT = 5;
const RECENT_PERFORMANCE_DAYS = 7;
const RECENT_COMPETITOR_RUNS_LIMIT = 5;

export function loadMemory(
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): MemoryBundle {
  return {
    profile: productProfileStore.get(workspaceId) ?? null,
    recentAudits: auditsStore.list(workspaceId).slice(0, RECENT_AUDITS_LIMIT),
    recentPerformance: performanceStore.recent(
      RECENT_PERFORMANCE_DAYS,
      workspaceId,
    ),
    recentCompetitorRuns: loadRecentCompetitorRuns(workspaceId),
  };
}

// Read the last few completed competitor-profiling runs for this workspace
// and summarize them down to (urls + summary + gaps). The full run JSON is
// available via skillRunsStore.get(taskId) when the prompt actually needs it.
function loadRecentCompetitorRuns(
  workspaceId: string,
): RecentCompetitorRunSummary[] {
  const runs = skillRunsStore.recentSkillRuns(
    workspaceId,
    "competitor-profiling",
    RECENT_COMPETITOR_RUNS_LIMIT,
  );

  return runs.map((run) => {
    const competitorUrls = extractCompetitorUrls(run.inputContext.competitorUrls);
    const profile = firstCompetitorProfile(run.finalReport?.structuredOutputs);
    const gaps = profile
      ? profile.competitors.flatMap((c) => c.yourGaps ?? []).slice(0, 4)
      : [];

    return {
      createdAt: run.createdAt,
      competitorUrls,
      executiveSummary: run.finalReport?.executiveSummary ?? "",
      gaps,
    };
  });
}

function extractCompetitorUrls(rawValue: string | undefined): string[] {
  if (!rawValue) return [];
  const matches = rawValue.match(/https?:\/\/[^\s,]+/g) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const match of matches) {
    const cleanUrl = match.replace(/[).;,]+$/, "");
    if (seen.has(cleanUrl)) continue;
    seen.add(cleanUrl);
    urls.push(cleanUrl);
  }
  return urls;
}

function firstCompetitorProfile(
  outputs: StructuredOutput[] | undefined,
):
  | Extract<StructuredOutput, { type: "competitorProfile" }>["data"]
  | undefined {
  if (!outputs) return undefined;
  const hit = outputs.find((o) => o.type === "competitorProfile");
  return hit?.type === "competitorProfile" ? hit.data : undefined;
}

// Render the memory bundle as a string for the agent prompt. Empty sections
// are skipped so we don't waste tokens telling Gemini "you have 0 audits."
//
// `currentSkillId` is optional — when provided, sections that only matter
// for a specific skill (e.g. recent competitor runs) are only rendered for
// that skill. When omitted, all available sections are rendered.
export function renderMemoryForPrompt(
  bundle: MemoryBundle,
  options: { currentSkillId?: string } = {},
): string {
  const parts: string[] = ["=== WORKSPACE MEMORY ==="];

  if (bundle.profile) {
    const p = bundle.profile;
    parts.push(
      "",
      "PRODUCT PROFILE:",
      `- Name: ${p.productName} — ${p.tagline}`,
      `- Industry: ${p.industry} · Stage: ${p.stage}`,
      `- Site URL: ${p.siteUrl}`,
      `- Positioning: ${p.positioning}`,
      `- Features: ${p.features.join(", ") || "(none)"}`,
      `- Differentiators: ${p.differentiators.join(", ") || "(none)"}`,
      `- ICP: ${p.icp}`,
      `- Voice & tone: ${p.voiceTone.join(", ") || "(none)"}`,
      `- MRR: $${p.mrr} · Monthly traffic: ${p.monthlyTraffic}`,
      `- 3-month north star: ${p.northStar}`,
      `- Brand guidelines: ${p.brandGuidelines}`,
    );
  }

  if (bundle.recentAudits.length > 0) {
    parts.push("", `RECENT AUDITS (last ${bundle.recentAudits.length}):`);
    for (const a of bundle.recentAudits) {
      const findings = (a.findingsJson as { score?: number; findings?: { severity: string }[] }) ?? {};
      const score = findings.score ?? "?";
      const counts = (findings.findings ?? []).reduce(
        (acc, f) => {
          acc[f.severity as "critical" | "warning" | "info"] =
            (acc[f.severity as "critical" | "warning" | "info"] ?? 0) + 1;
          return acc;
        },
        {} as Record<"critical" | "warning" | "info", number>,
      );
      const url = (a.scopeJson as { url?: string })?.url ?? "?";
      parts.push(
        `- [${a.createdAt.slice(0, 10)}] ${a.type} on ${url} — score ${score}, ${counts.critical ?? 0} crit / ${counts.warning ?? 0} warn / ${counts.info ?? 0} info`,
      );
    }
    parts.push(
      "Do NOT re-audit pages whose audit is less than 24 hours old. Reference findings from these audits where relevant.",
    );
  }

  if (bundle.recentPerformance.length > 0) {
    parts.push("", `RECENT PERFORMANCE (last ${bundle.recentPerformance.length} days):`);
    for (const s of bundle.recentPerformance) {
      parts.push(
        `- ${s.date}: org=${s.trafficOrganic} paid=${s.trafficPaid} conv=${s.conversions} mrr=$${s.mrr} churn=${(s.churnRate * 100).toFixed(1)}%`,
      );
    }
  }

  // Only render past competitor runs for the competitor-profiling skill.
  // Other skills don't benefit from this context and it just burns tokens.
  if (
    options.currentSkillId === "competitor-profiling" &&
    bundle.recentCompetitorRuns.length > 0
  ) {
    parts.push(
      "",
      `RECENT COMPETITOR INTELLIGENCE (last ${bundle.recentCompetitorRuns.length} run${bundle.recentCompetitorRuns.length === 1 ? "" : "s"}):`,
    );
    for (const r of bundle.recentCompetitorRuns) {
      const urls = r.competitorUrls.length > 0 ? r.competitorUrls.join(", ") : "(no URLs)";
      parts.push(`- [${r.createdAt.slice(0, 10)}] ${urls}`);
      if (r.executiveSummary) {
        parts.push(`    Summary: ${truncate(r.executiveSummary, 220)}`);
      }
      if (r.gaps.length > 0) {
        parts.push(`    Previously flagged gaps:`);
        for (const gap of r.gaps) {
          parts.push(`      - ${truncate(gap, 160)}`);
        }
      }
    }
    parts.push(
      "Use this history to flag follow-up changes (e.g. 'pricing is now visible', 'a previously-flagged gap is still open') instead of starting from a blank slate.",
    );
  }

  parts.push("=== END MEMORY ===");
  return parts.join("\n");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}
