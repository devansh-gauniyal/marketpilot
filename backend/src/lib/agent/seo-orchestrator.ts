// Deterministic SEO orchestrator.
//
// Why this exists:
//   The previous flow let Gemini decide the order: audit → scan → patch → finish.
//   It was unreliable — sometimes Gemini skipped scan_repo or add_alt_text and
//   finished with text-only recommendations and no PR. That's the "sometimes
//   works, sometimes not" Devansh hit.
//
//   This file replaces the LLM-orchestrated path for the `seo-audit` skill with
//   a scripted pipeline:
//     1. Audit the live URL  → findings + health score
//     2. Scan the GitHub repo for alt-text gaps
//     3. Scan the GitHub repo for page-metadata gaps (title / description)
//     4. Ask Gemini to draft alt-text + title + description copy for each gap
//        (the LLM still picks the words — only the order is deterministic)
//     5. Open ONE PR via githubMdxConnector.applySeoFixes
//     6. Persist a rollbackable ToolCall record
//     7. Write the final report to the SkillRun
//
//   Other skills keep the existing LLM-driven loop. Only seo-audit is special.
//
// Framework rules touched:
//   §5.1 — `apply_seo_fixes` is registered with a YELLOW tier (see agent-tools)
//   §5.2 — tier gate still fires (we call it manually before applySeoFixes)
//   §5.3 — write returns rollbackPayload; we persist it in toolCallsStore
//   §5.5 — capability check via githubMdxConnector.capabilities.*
//   §5.6 — orchestration lives in the orchestrator, not in skill knowledge
//   §5.8 — PR-based write (auto rollback by closing the PR)
//   §5.10 — every step writes an event

import {
  approvalsStore,
  auditsStore,
  DEFAULT_WORKSPACE_ID,
  eventsStore,
  productProfileStore,
  skillRunsStore,
  toolCallsStore,
  type AgentDecision,
  type Approval,
  type ProposedAction,
  type StructuredOutput,
} from "../store";
import type { AuditOutput } from "../skills/output-types";
import { cheerioSiteConnector, githubMdxConnector } from "../connectors";
import type {
  AltTextGap,
  AltTextPatch,
  CopyRewriteGap,
  CopyRewritePatch,
  CtaRewriteGap,
  CtaRewritePatch,
  FaqSectionGap,
  FaqSectionPatch,
  InteractiveConversionUpgradeGap,
  InteractiveConversionUpgradePatch,
  PageMetadataGap,
  PageMetadataPatch,
  ProductionSiteUpgradeGap,
  ProductionSiteUpgradePatch,
  RepoStructureAnalysis,
  VisibleContentGap,
  VisibleContentPatch,
  VisualUpgradeGap,
  VisualUpgradePatch,
  RepoConnectionConfig,
} from "../connectors/types";
import {
  primaryWorkspaceSiteUrl,
  workspaceGithubRepo,
} from "../connections/workspace-connections";
import {
  runAuditChecks,
  scoreFromFindings,
  type Finding,
} from "../tools/seo/audit-checks";
import { tierGate } from "./tier-gate";

const GEMINI_DRAFT_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

// What the Gemini/fallback draft step returns to us. Loose shape — we validate
// fields before using them.
export type DraftedCopy = {
  altText: Array<{ filepath: string; imageSrc: string; altText: string }>;
  pageMetadata: Array<{
    filepath: string;
    title?: string;
    description?: string;
  }>;
  visibleContent: Array<{
    filepath: string;
    heading: string;
    body: string;
    bullets?: string[];
  }>;
  copyRewrite: Array<{
    filepath: string;
    targetId: string;
    tagName: "h1" | "h2" | "p";
    currentText: string;
    replacementText: string;
  }>;
  ctaRewrite: Array<{
    filepath: string;
    targetId: string;
    element: "a" | "button";
    currentText: string;
    replacementText: string;
  }>;
  faqSection: Array<{
    filepath: string;
    heading: string;
    faqs: Array<{ question: string; answer: string }>;
  }>;
  visualUpgrade: Array<{
    filepath: string;
    stylesheetPath: string;
    eyebrow: string;
    heading: string;
    body: string;
    metrics: Array<{ value: string; label: string }>;
    steps: Array<{ title: string; body: string }>;
    ctaText: string;
    ctaHref: string;
  }>;
  productionUpgrade: Array<{
    filepath: string;
    pageRole: "home" | "features" | "pricing" | "blog" | "content" | "unknown";
    stylesheetPath: string;
    fixDuplicateH1?: {
      replacementLead: string;
    };
    linkRepairs?: Array<{
      currentHref: string;
      replacementHref: string;
    }>;
    section: {
      eyebrow: string;
      heading: string;
      body: string;
      highlights: Array<{ title: string; body: string }>;
      comparisonRows?: Array<{
        feature: string;
        starter: string;
        growth: string;
        scale: string;
      }>;
      ctaText: string;
      ctaHref: string;
    };
  }>;
  interactiveConversionUpgrade: Array<{
    filepath: string;
    pageRole: "home" | "features" | "pricing" | "blog" | "content" | "unknown";
    stylesheetPath: string;
    section: {
      eyebrow: string;
      heading: string;
      body: string;
      calculatorTitle: string;
      inputLabels: {
        visitors: string;
        conversionRate: string;
        averageValue: string;
      };
      resultLabel: string;
      recommendations: Array<{ title: string; body: string }>;
      ctaText: string;
      ctaHref: string;
    };
  }>;
};

type DraftSource = "gemini" | "fallback";

type SeoFixKind =
  | "copyRewrite"
  | "ctaRewrite"
  | "faqSection"
  | "visualUpgrade"
  | "productionUpgrade"
  | "interactiveConversionUpgrade"
  | "visibleContent"
  | "pageMetadata"
  | "altText";
type SeoFixPriority = "critical" | "high" | "medium" | "low";

type SeoFixPlanItem = {
  kind: SeoFixKind;
  filepath: string;
  target: string;
  priority: SeoFixPriority;
  reason: string;
  expectedVisibleResult: string;
  score: number;
};

export type SeoFixPlan = {
  auditUrl: string;
  healthScore: number;
  auditFindingCount: number;
  criticalFindingCount: number;
  warningFindingCount: number;
  findingIds: string[];
  repoAnalysis?: RepoStructureAnalysis;
  primaryFocus: string;
  strategySummary: string;
  items: SeoFixPlanItem[];
};

export type SeoFixQualityGateResult = {
  status: "passed" | "blocked";
  score: number;
  summary: string;
  checkedAt: string;
  checks: Array<{
    id: string;
    label: string;
    status: "pass" | "warn" | "fail";
    message: string;
  }>;
};

export type SeoChangeNecessityResult = {
  status: "needed" | "not_needed";
  summary: string;
  reasons: string[];
  checkedAt: string;
  healthScore: number;
  auditFindingCount: number;
  criticalFindingCount: number;
  warningFindingCount: number;
  materialRepoIssueCount: number;
  plannedFixCount: number;
};

export type SeoFixApprovalPayload = {
  type: "seo_pr_approval";
  toolName: "apply_seo_fixes";
  requiresApproval: true;
  altText: AltTextPatch[];
  pageMetadata: PageMetadataPatch[];
  visibleContent: VisibleContentPatch[];
  copyRewrite: CopyRewritePatch[];
  ctaRewrite: CtaRewritePatch[];
  faqSection: FaqSectionPatch[];
  visualUpgrade: VisualUpgradePatch[];
  productionUpgrade: ProductionSiteUpgradePatch[];
  interactiveConversionUpgrade: InteractiveConversionUpgradePatch[];
  repo?: RepoConnectionConfig;
  plan: SeoFixPlan;
  qualityGate: SeoFixQualityGateResult;
  draftSource: DraftSource;
  fallbackReason?: string;
  reason: string;
};

export async function runSeoAuditOrchestrator(
  taskId: string,
  skillContent: string,
): Promise<void> {
  const run = skillRunsStore.get(taskId);
  if (!run) return;
  const workspaceId = run.workspaceId;

  const apiKey = process.env.GEMINI_API_KEY;
  const siteConnectionUrl = primaryWorkspaceSiteUrl(workspaceId);
  const repoConnection = workspaceGithubRepo(workspaceId);

  // ---- 1. Resolve the URL to audit ----
  const url = pickAuditUrl(run.inputContext, workspaceId, siteConnectionUrl);
  if (!url) {
    failRun(
      taskId,
      "No URL to audit. Provide a campaignGoal containing the site URL, or set Product Profile → Site URL.",
    );
    return;
  }

  eventsStore.append("seo_orchestrator_start", { skillRunId: taskId, url }, workspaceId);
  addStep(taskId, "tool_call", `Starting SEO orchestrator on ${url}`);

  // ---- 2. Live audit ----
  let pageFindings: ReturnType<typeof runAuditChecks> = [];
  let healthScore = 0;
  let auditedPageTitle = "";
  try {
    const page = await cheerioSiteConnector.crawl(url);
    auditedPageTitle = page.title ?? "";
    pageFindings = runAuditChecks(page);
    healthScore = scoreFromFindings(pageFindings);

    // Persist the audit so the Audits screen + future runs see it.
    auditsStore.create({
      workspaceId,
      type: "seo",
      scopeJson: { url, scopeLabel: "auto-orchestrated" },
      findingsJson: { score: healthScore, findings: pageFindings, page },
      triagedActionsJson: triage(pageFindings),
    });
    addStep(
      taskId,
      "tool_result",
      `audit_seo found ${pageFindings.length} findings, score ${healthScore}/100`,
    );
  } catch (err) {
    failRun(
      taskId,
      `audit_seo failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
    return;
  }

  // ---- 3. Scan repo (skip silently if GitHub is not configured) ----
  let altGaps: AltTextGap[] = [];
  let metadataGaps: PageMetadataGap[] = [];
  let visibleContentGaps: VisibleContentGap[] = [];
  let copyRewriteGaps: CopyRewriteGap[] = [];
  let ctaRewriteGaps: CtaRewriteGap[] = [];
  let faqSectionGaps: FaqSectionGap[] = [];
  let visualUpgradeGaps: VisualUpgradeGap[] = [];
  let productionUpgradeGaps: ProductionSiteUpgradeGap[] = [];
  let interactiveConversionUpgradeGaps: InteractiveConversionUpgradeGap[] = [];
  let repoAnalysis: RepoStructureAnalysis | undefined;
  const githubConfigured = isGithubConfigured(repoConnection);

  if (githubConfigured) {
    try {
      repoAnalysis = await githubMdxConnector.analyzeRepoStructure!({ repo: repoConnection });
      addStep(
        taskId,
        "tool_result",
        `Repo analysis: ${repoAnalysis.projectKind} project, ${repoAnalysis.pages.length} page(s), ${repoAnalysis.issues.length} repo issue(s). Focus: ${repoAnalysis.recommendedFocus}`,
      );
      eventsStore.append("repo_structure_analyzed", {
        skillRunId: taskId,
        analysis: repoAnalysis,
      }, workspaceId);
    } catch (err) {
      addStep(
        taskId,
        "tool_result",
        `analyze_repo_structure error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    try {
      altGaps = (await githubMdxConnector.scanAltTextGaps!({ repo: repoConnection })) ?? [];
      addStep(taskId, "tool_result", `Repo scan found ${altGaps.length} alt-text gap(s).`);
    } catch (err) {
      addStep(
        taskId,
        "tool_result",
        `scan_repo_for_alt_text_gaps error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    try {
      metadataGaps = (await githubMdxConnector.scanPageMetadata!({ repo: repoConnection })) ?? [];
      addStep(
        taskId,
        "tool_result",
        `Repo scan found ${metadataGaps.length} page-metadata gap(s).`,
      );
    } catch (err) {
      addStep(
        taskId,
        "tool_result",
        `scan_page_metadata error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    try {
      visibleContentGaps = (await githubMdxConnector.scanVisibleContentGaps!({ repo: repoConnection })) ?? [];
      addStep(
        taskId,
        "tool_result",
        `Repo scan found ${visibleContentGaps.length} visible-content opportunity/opportunities.`,
      );
    } catch (err) {
      addStep(
        taskId,
        "tool_result",
        `scan_visible_content_gaps error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    try {
      copyRewriteGaps = (await githubMdxConnector.scanCopyRewriteGaps!({ repo: repoConnection })) ?? [];
      addStep(
        taskId,
        "tool_result",
        `Repo scan found ${copyRewriteGaps.length} existing-copy rewrite opportunity/opportunities.`,
      );
    } catch (err) {
      addStep(
        taskId,
        "tool_result",
        `scan_copy_rewrite_gaps error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    try {
      ctaRewriteGaps = (await githubMdxConnector.scanCtaRewriteGaps!({ repo: repoConnection })) ?? [];
      addStep(
        taskId,
        "tool_result",
        `Repo scan found ${ctaRewriteGaps.length} CTA rewrite opportunity/opportunities.`,
      );
    } catch (err) {
      addStep(
        taskId,
        "tool_result",
        `scan_cta_rewrite_gaps error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    try {
      faqSectionGaps = (await githubMdxConnector.scanFaqSectionGaps!({ repo: repoConnection })) ?? [];
      addStep(
        taskId,
        "tool_result",
        `Repo scan found ${faqSectionGaps.length} FAQ section opportunity/opportunities.`,
      );
    } catch (err) {
      addStep(
        taskId,
        "tool_result",
        `scan_faq_section_gaps error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    try {
      visualUpgradeGaps = (await githubMdxConnector.scanVisualUpgradeGaps!({ repo: repoConnection })) ?? [];
      addStep(
        taskId,
        "tool_result",
        `Repo scan found ${visualUpgradeGaps.length} visual upgrade opportunity/opportunities.`,
      );
    } catch (err) {
      addStep(
        taskId,
        "tool_result",
        `scan_visual_upgrade_gaps error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    try {
      productionUpgradeGaps = (await githubMdxConnector.scanProductionSiteUpgradeGaps!(
        { analysis: repoAnalysis, repo: repoConnection },
      )) ?? [];
      addStep(
        taskId,
        "tool_result",
        `Repo scan found ${productionUpgradeGaps.length} production site upgrade opportunity/opportunities.`,
      );
    } catch (err) {
      addStep(
        taskId,
        "tool_result",
        `scan_production_site_upgrade_gaps error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }

    try {
      interactiveConversionUpgradeGaps = (await githubMdxConnector.scanInteractiveConversionUpgradeGaps!(
        { analysis: repoAnalysis, repo: repoConnection },
      )) ?? [];
      addStep(
        taskId,
        "tool_result",
        `Repo scan found ${interactiveConversionUpgradeGaps.length} interactive conversion upgrade opportunity/opportunities.`,
      );
    } catch (err) {
      addStep(
        taskId,
        "tool_result",
        `scan_interactive_conversion_upgrade_gaps error: ${err instanceof Error ? err.message : "unknown"}`,
      );
    }
  } else {
    addStep(
      taskId,
      "tool_result",
      "GitHub not configured — skipping source scan. Connect GitHub in Integrations or keep GITHUB_TOKEN in backend/.env for local development.",
    );
  }

  // ---- 4. If nothing fixable, finalize honestly ----
  if (
    altGaps.length === 0 &&
    metadataGaps.length === 0 &&
    visibleContentGaps.length === 0 &&
    copyRewriteGaps.length === 0 &&
    ctaRewriteGaps.length === 0 &&
    faqSectionGaps.length === 0 &&
    visualUpgradeGaps.length === 0 &&
    productionUpgradeGaps.length === 0 &&
    interactiveConversionUpgradeGaps.length === 0
  ) {
    finalizeRun(taskId, {
      executiveSummary: githubConfigured
        ? `Audited ${url} (score ${healthScore}/100). No source-level fixes the agent can auto-PR — the repo's images have alt text and pages have acceptable title/description metadata.`
        : `Audited ${url} (score ${healthScore}/100). Connect a GitHub repo in Integrations to let the agent open auto-fix PRs.`,
      findings: pageFindings.map((f) => `[${f.severity}] ${f.message}`),
      recommendations: recommendationsFromFindings(pageFindings),
      nextSteps: [],
      proposedActions: [],
      auditInput: { url, score: healthScore, pageFindings },
      decision: githubConfigured
        ? makeAgentDecision({
            kind: "pr_skipped",
            label: "No PR needed",
            summary: "The audit finished, but the repo scan did not find source-level fixes worth opening as a PR.",
            reason: "Images and page metadata already look acceptable for the current auto-fix scope.",
            nextStep: "Use this run as a health check and re-run after the site changes.",
            severity: "success",
          })
        : makeAgentDecision({
            kind: "setup_needed",
            label: "GitHub not connected",
            summary: "The audit finished, but the agent cannot open PRs until GitHub is configured.",
            reason: "PR-based writes need a workspace GitHub repo plus a connected GitHub token.",
            nextStep: "Add the repo in Integrations, keep the token in backend/.env, then run the audit again.",
            severity: "warning",
          }),
    });
    return;
  }

  const fixPlan = buildSeoFixPlan({
    siteUrl: url,
    healthScore,
    repoAnalysis,
    findings: pageFindings,
    altGaps,
    metadataGaps,
    visibleContentGaps,
    copyRewriteGaps,
    ctaRewriteGaps,
    faqSectionGaps,
    visualUpgradeGaps,
    productionUpgradeGaps,
    interactiveConversionUpgradeGaps,
  });

  const necessityGate = evaluateSeoChangeNecessity({
    plan: fixPlan,
    findings: pageFindings,
    repoAnalysis,
  });
  addStep(
    taskId,
    "tool_result",
    `Necessity gate ${necessityGate.status}: ${necessityGate.summary}`,
  );
  eventsStore.append("seo_change_necessity_checked", {
    skillRunId: taskId,
    necessityGate,
  }, workspaceId);

  if (necessityGate.status === "not_needed") {
    finalizeRun(taskId, {
      executiveSummary: `Audited ${url} (score ${healthScore}/100). No GitHub PR was prepared. ${necessityGate.summary}`,
      findings:
        pageFindings.length > 0
          ? pageFindings.map((f) => `[${f.severity}] ${f.message}`)
          : ["[healthy] No material SEO issues were found."],
      recommendations: [
        "Do not create a PR for this run. Keep the site as-is unless a future audit finds critical, warning, or material repo issues.",
        "Re-run the audit after a meaningful site update, before a launch, or when the SEO score drops below the healthy range.",
      ],
      auditInput: { url, score: healthScore, pageFindings },
      nextSteps: [
        "No approval is needed.",
        "Use the SEO report as a health check, not as a reason to change the site.",
      ],
      proposedActions: [],
      decision: makeAgentDecision({
        kind: "pr_skipped",
        label: "No PR needed",
        summary: necessityGate.summary,
        reason: necessityGate.reasons.join(" "),
        nextStep: "Keep the site unchanged for now and re-run after a meaningful site update.",
        severity: "success",
      }),
    });
    return;
  }

  const selectedAltGaps = selectAltGaps(altGaps, fixPlan);
  const selectedMetadataGaps = selectMetadataGaps(metadataGaps, fixPlan);
  const selectedVisibleContentGaps = selectVisibleContentGaps(visibleContentGaps, fixPlan);
  const selectedCopyRewriteGaps = selectCopyRewriteGaps(copyRewriteGaps, fixPlan);
  const selectedCtaRewriteGaps = selectCtaRewriteGaps(ctaRewriteGaps, fixPlan);
  const selectedFaqSectionGaps = selectFaqSectionGaps(faqSectionGaps, fixPlan);
  const selectedVisualUpgradeGaps = selectVisualUpgradeGaps(visualUpgradeGaps, fixPlan);
  const selectedProductionUpgradeGaps = selectProductionUpgradeGaps(productionUpgradeGaps, fixPlan);
  const selectedInteractiveConversionUpgradeGaps = selectInteractiveConversionUpgradeGaps(
    interactiveConversionUpgradeGaps,
    fixPlan,
  );

  addStep(
    taskId,
    "tool_result",
    `Fix plan: ${fixPlan.primaryFocus}. Selected ${fixPlan.items.length} highest-impact change(s).`,
  );
  eventsStore.append("seo_fix_plan_created", {
    skillRunId: taskId,
    plan: fixPlan,
  }, workspaceId);

  // ---- 5. Ask Gemini to draft the copy ----
  addStep(
    taskId,
    "tool_call",
    `Drafting prioritized copy for ${selectedAltGaps.length} image(s), ${selectedMetadataGaps.length} metadata gap(s), ${selectedCopyRewriteGaps.length} copy rewrite(s), ${selectedCtaRewriteGaps.length} CTA rewrite(s), ${selectedVisibleContentGaps.length} visible section(s), ${selectedFaqSectionGaps.length} FAQ section(s), ${selectedVisualUpgradeGaps.length} visual upgrade(s), ${selectedProductionUpgradeGaps.length} production upgrade(s), and ${selectedInteractiveConversionUpgradeGaps.length} interactive upgrade(s) with Gemini.`,
  );

  // The hint is anything the user typed in the New Run form that isn't the
  // URL: campaign goal text, brand tone, target audience, etc. The agent
  // still decides what to fix — the hint just shapes the copy.
  const userHint = renderUserHint(run.inputContext, url);

  // Retry policy:
  //   - Up to 3 attempts.
  //   - Empty drafts → retry once (Gemini occasionally returns {} despite
  //     responseMimeType: "application/json").
  //   - HTTP 429/503 → exponential backoff (2s, 4s) before retry.
  //   - If Gemini still fails, fallback templates create conservative copy.
  let drafts: DraftedCopy = {
    altText: [],
    pageMetadata: [],
    visibleContent: [],
    copyRewrite: [],
    ctaRewrite: [],
    faqSection: [],
    visualUpgrade: [],
    productionUpgrade: [],
    interactiveConversionUpgrade: [],
  };
  let draftSource: DraftSource = "gemini";
  let fallbackReason: string | undefined;
  let lastErr: unknown = null;

  if (apiKey) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        drafts = await draftCopy(apiKey, {
          siteUrl: url,
          auditedPageTitle,
          productProfileText: renderProductProfile(workspaceId),
          userHint,
          fixPlan,
          altGaps: selectedAltGaps,
          metadataGaps: selectedMetadataGaps,
          visibleContentGaps: selectedVisibleContentGaps,
          copyRewriteGaps: selectedCopyRewriteGaps,
          ctaRewriteGaps: selectedCtaRewriteGaps,
          faqSectionGaps: selectedFaqSectionGaps,
          visualUpgradeGaps: selectedVisualUpgradeGaps,
          productionUpgradeGaps: selectedProductionUpgradeGaps,
          interactiveConversionUpgradeGaps: selectedInteractiveConversionUpgradeGaps,
          repoAnalysis,
          skillContent,
        });
        lastErr = null;
        if (countDraftPatches(drafts) > 0) break;
      } catch (err) {
        lastErr = err;
        if (attempt === 3) break; // last attempt, don't wait
        const message = err instanceof Error ? err.message : "";
        if (message.startsWith("Gemini 429") || message.startsWith("Gemini 503")) {
          const waitMs = 2000 * attempt;
          addStep(
            taskId,
            "tool_result",
            `Gemini is temporarily unavailable. Waiting ${waitMs}ms before retry ${attempt + 1}.`,
          );
          await new Promise((resolve) => setTimeout(resolve, waitMs));
        }
      }
    }
  } else {
    fallbackReason = "GEMINI_API_KEY is not set.";
  }

  if (countDraftPatches(drafts) === 0) {
    draftSource = "fallback";
    fallbackReason =
      fallbackReason ??
      (lastErr instanceof Error
        ? lastErr.message
        : "Gemini returned no usable patches after 3 attempts.");
    addStep(
      taskId,
      "tool_result",
      `Gemini draft unavailable; using fallback copy templates. Reason: ${fallbackReason}`,
    );
    eventsStore.append("seo_fallback_draft_used", {
      skillRunId: taskId,
      reason: fallbackReason,
    }, workspaceId);
    drafts = draftFallbackCopy({
      workspaceId,
      siteUrl: url,
      inputContext: run.inputContext,
      altGaps: selectedAltGaps,
      metadataGaps: selectedMetadataGaps,
      visibleContentGaps: selectedVisibleContentGaps,
      copyRewriteGaps: selectedCopyRewriteGaps,
      ctaRewriteGaps: selectedCtaRewriteGaps,
      faqSectionGaps: selectedFaqSectionGaps,
      visualUpgradeGaps: selectedVisualUpgradeGaps,
      productionUpgradeGaps: selectedProductionUpgradeGaps,
      interactiveConversionUpgradeGaps: selectedInteractiveConversionUpgradeGaps,
      repoAnalysis,
    });
  }

  if (countDraftPatches(drafts) === 0) {
    failRun(
      taskId,
      "Gemini and fallback drafting both returned no usable patches.",
    );
    return;
  }

  // ---- 6. Apply tier gate (manual — we know it's YELLOW) and open the PR ----
  const altPatches: AltTextPatch[] = drafts.altText
    .filter((d) => d.filepath && d.imageSrc && d.altText)
    .map((d) => ({
      filepath: d.filepath,
      imageSrc: d.imageSrc,
      altText: d.altText,
    }));

  const metaPatches: PageMetadataPatch[] = drafts.pageMetadata
    .filter((d) => d.filepath && (d.title || d.description))
    .map((d) => {
      // Look up the gap to recover the style — Gemini doesn't pick it.
      const gap = selectedMetadataGaps.find((g) => g.filepath === d.filepath);
      return {
        filepath: d.filepath,
        style: gap?.style ?? "html-head",
        title: d.title,
        description: d.description,
      } satisfies PageMetadataPatch;
    });

  const contentPatches: VisibleContentPatch[] = drafts.visibleContent
    .filter((d) => d.filepath && d.heading && d.body)
    .map((d) => {
      const gap = selectedVisibleContentGaps.find((g) => g.filepath === d.filepath);
      return {
        filepath: d.filepath,
        style: gap?.style ?? "html-main",
        heading: d.heading,
        body: d.body,
        bullets: d.bullets,
      } satisfies VisibleContentPatch;
    });

  const copyPatches: CopyRewritePatch[] = drafts.copyRewrite
    .filter((d) => d.filepath && d.targetId && d.currentText && d.replacementText)
    .map((d) => {
      const gap = selectedCopyRewriteGaps.find(
        (g) => g.filepath === d.filepath && g.targetId === d.targetId,
      );
      return {
        filepath: d.filepath,
        style: "html-text",
        targetId: d.targetId,
        tagName: gap?.tagName ?? d.tagName,
        currentText: gap?.currentText ?? d.currentText,
        replacementText: d.replacementText,
      } satisfies CopyRewritePatch;
    });

  const ctaPatches: CtaRewritePatch[] = drafts.ctaRewrite
    .filter((d) => d.filepath && d.targetId && d.currentText && d.replacementText)
    .map((d) => {
      const gap = selectedCtaRewriteGaps.find(
        (g) => g.filepath === d.filepath && g.targetId === d.targetId,
      );
      return {
        filepath: d.filepath,
        style: "html-cta",
        targetId: d.targetId,
        element: gap?.element ?? d.element,
        currentText: gap?.currentText ?? d.currentText,
        replacementText: d.replacementText,
      } satisfies CtaRewritePatch;
    });

  const faqPatches: FaqSectionPatch[] = drafts.faqSection
    .filter((d) => d.filepath && d.heading && Array.isArray(d.faqs) && d.faqs.length > 0)
    .map((d) => {
      const gap = selectedFaqSectionGaps.find((g) => g.filepath === d.filepath);
      return {
        filepath: d.filepath,
        style: gap?.style ?? "html-main",
        heading: d.heading,
        faqs: d.faqs,
      } satisfies FaqSectionPatch;
    });

  const visualPatches: VisualUpgradePatch[] = drafts.visualUpgrade
    .filter(
      (d) =>
        d.filepath &&
        d.stylesheetPath &&
        d.eyebrow &&
        d.heading &&
        d.body &&
        Array.isArray(d.metrics) &&
        d.metrics.length > 0 &&
        Array.isArray(d.steps) &&
        d.steps.length > 0 &&
        d.ctaText &&
        d.ctaHref,
    )
    .map((d) => {
      const gap = selectedVisualUpgradeGaps.find((g) => g.filepath === d.filepath);
      return {
        filepath: d.filepath,
        style: "html-main-css",
        stylesheetPath: gap?.stylesheetPath ?? d.stylesheetPath,
        eyebrow: d.eyebrow,
        heading: d.heading,
        body: d.body,
        metrics: d.metrics,
        steps: d.steps,
        ctaText: d.ctaText,
        ctaHref: d.ctaHref,
      } satisfies VisualUpgradePatch;
    });

  const productionPatches: ProductionSiteUpgradePatch[] = drafts.productionUpgrade
    .filter(
      (d) =>
        d.filepath &&
        d.stylesheetPath &&
        d.section &&
        d.section.heading &&
        d.section.body &&
        Array.isArray(d.section.highlights) &&
        d.section.highlights.length > 0 &&
        d.section.ctaText &&
        d.section.ctaHref,
    )
    .map((d) => {
      const gap = selectedProductionUpgradeGaps.find((g) => g.filepath === d.filepath);
      return {
        filepath: d.filepath,
        style: "static-html-page-css",
        pageRole: gap?.pageRole ?? d.pageRole,
        stylesheetPath: gap?.stylesheetPath ?? d.stylesheetPath,
        fixDuplicateH1: d.fixDuplicateH1,
        linkRepairs: d.linkRepairs,
        section: d.section,
      } satisfies ProductionSiteUpgradePatch;
    });

  const interactivePatches: InteractiveConversionUpgradePatch[] = drafts.interactiveConversionUpgrade
    .filter(
      (d) =>
        d.filepath &&
        d.stylesheetPath &&
        d.section &&
        d.section.heading &&
        d.section.body &&
        d.section.calculatorTitle &&
        d.section.inputLabels &&
        d.section.inputLabels.visitors &&
        d.section.inputLabels.conversionRate &&
        d.section.inputLabels.averageValue &&
        d.section.resultLabel &&
        Array.isArray(d.section.recommendations) &&
        d.section.recommendations.length > 0 &&
        d.section.ctaText &&
        d.section.ctaHref,
    )
    .map((d) => {
      const gap = selectedInteractiveConversionUpgradeGaps.find((g) => g.filepath === d.filepath);
      return {
        filepath: d.filepath,
        style: "static-html-interactive-css",
        pageRole: gap?.pageRole ?? d.pageRole,
        stylesheetPath: gap?.stylesheetPath ?? d.stylesheetPath,
        section: d.section,
      } satisfies InteractiveConversionUpgradePatch;
    });

  if (
    altPatches.length === 0 &&
    metaPatches.length === 0 &&
    contentPatches.length === 0 &&
    copyPatches.length === 0 &&
    ctaPatches.length === 0 &&
    faqPatches.length === 0 &&
    visualPatches.length === 0 &&
    productionPatches.length === 0 &&
    interactivePatches.length === 0
  ) {
    finalizeRun(taskId, {
      executiveSummary: `Audited ${url} (score ${healthScore}/100). Gemini returned no usable patches — the underlying gaps are present but the LLM did not produce well-formed fixes.`,
      findings: pageFindings.map((f) => `[${f.severity}] ${f.message}`),
      recommendations: recommendationsFromFindings(pageFindings),
      nextSteps: [
        "Re-run the audit. Most of the time a retry produces a clean draft.",
      ],
      proposedActions: [],
      auditInput: { url, score: healthScore, pageFindings },
      decision: makeAgentDecision({
        kind: "pr_failed",
        label: "No PR created",
        summary: "The agent found possible fixes, but the draft step did not return usable patches.",
        reason: "The generated patch payload was empty or malformed.",
        nextStep: "Re-run the audit or improve the product profile context.",
        severity: "warning",
      }),
    });
    return;
  }

  const qualityGate = runSeoFixQualityGate({
    plan: fixPlan,
    draftSource,
    altText: altPatches,
    pageMetadata: metaPatches,
    visibleContent: contentPatches,
    copyRewrite: copyPatches,
    ctaRewrite: ctaPatches,
    faqSection: faqPatches,
    visualUpgrade: visualPatches,
    productionUpgrade: productionPatches,
    interactiveConversionUpgrade: interactivePatches,
  });
  addStep(
    taskId,
    "tool_result",
    `Quality gate ${qualityGate.status}: score ${qualityGate.score}/100. ${qualityGate.summary}`,
  );
  eventsStore.append("seo_quality_gate_checked", {
    skillRunId: taskId,
    qualityGate,
  }, workspaceId);

  if (qualityGate.status === "blocked") {
    finalizeRun(taskId, {
      executiveSummary: `Audited ${url} (score ${healthScore}/100). The agent drafted changes, but the internal quality gate blocked the PR plan before approval.`,
      findings: [
        ...pageFindings.map((f) => `[${f.severity}] ${f.message}`),
        ...qualityGate.checks
          .filter((check) => check.status === "fail")
          .map((check) => `[quality] ${check.message}`),
      ],
      recommendations: [
        "Re-run with a clearer instruction, or improve the product profile so the agent has better context.",
        "No GitHub PR was created because the proposed change did not pass the quality bar.",
      ],
      nextSteps: [
        "Review the failed quality checks in the run trace.",
        "Run another SEO audit when you want the agent to draft a cleaner proposal.",
      ],
      proposedActions: [],
      auditInput: { url, score: healthScore, pageFindings },
      decision: makeAgentDecision({
        kind: "quality_blocked",
        label: "PR blocked by quality gate",
        summary: qualityGate.summary,
        reason: "The proposed PR did not meet the internal quality bar.",
        nextStep: "Review the failed quality checks, then re-run with clearer context if needed.",
        severity: "warning",
      }),
    });
    return;
  }

  const approvalPayload = buildSeoFixApprovalPayload({
    altText: altPatches,
    pageMetadata: metaPatches,
    visibleContent: contentPatches,
    copyRewrite: copyPatches,
    ctaRewrite: ctaPatches,
    faqSection: faqPatches,
    visualUpgrade: visualPatches,
    productionUpgrade: productionPatches,
    interactiveConversionUpgrade: interactivePatches,
    repo: repoConnection,
    plan: fixPlan,
    qualityGate,
    draftSource,
    fallbackReason,
  });

  const gateDecision = tierGate({
    skillRunId: taskId,
    toolName: "apply_seo_fixes",
    input: {
      requiresApproval: true,
      approvalTitle: "Approve SEO improvement PR",
      approvalSummary: approvalSummaryForPayload(approvalPayload),
      approvalReasoning:
        "MarketPilot prepared the PR but is waiting for human approval before touching GitHub.",
      expectedImpact: approvalPayload.plan.primaryFocus,
      rollbackPlan:
        "Rejecting creates no PR. If approved, the resulting PR can still be rolled back from Settings.",
      proposedActionJson: approvalPayload,
    },
  });

  if (gateDecision.kind === "blocked") {
    addStep(
      taskId,
      "tool_result",
      `Approval required before creating PR. Approval ${gateDecision.approvalId} is waiting in Proposed Actions.`,
    );
    finalizeRun(taskId, {
      executiveSummary: `Audited ${url} (score ${healthScore}/100). Prepared a prioritized SEO PR plan and paused before GitHub. Approval ${gateDecision.approvalId} is waiting in Proposed Actions.`,
      findings: pageFindings.map((f) => `[${f.severity}] ${f.message}`),
      recommendations: recommendationsFromFindings(pageFindings),
      nextSteps: [
        "Open Proposed Actions.",
        `Approve ${gateDecision.approvalId} to create the GitHub PR, or reject it to discard the plan.`,
      ],
      proposedActions: [
        {
          actionId: gateDecision.approvalId,
          type: "seo_pr_approval",
          title: "Approve SEO improvement PR",
          description: approvalSummaryForPayload(approvalPayload),
          status: "pending",
        },
      ],
      auditInput: { url, score: healthScore, pageFindings },
      decision: makeAgentDecision({
        kind: "approval_waiting",
        label: "Approval needed",
        summary: approvalPayload.plan.primaryFocus,
        reason: approvalSummaryForPayload(approvalPayload),
        nextStep: `Approve ${gateDecision.approvalId} in Proposed Actions to create the GitHub PR.`,
        severity: "warning",
      }),
    });
    return;
  }

  failRun(taskId, "Expected apply_seo_fixes to require approval, but the tier gate allowed execution.");
}

// ----------------------------------------------------------------------------
//  Helpers
// ----------------------------------------------------------------------------

function pickAuditUrl(
  inputContext: Record<string, string>,
  workspaceId: string,
  siteConnectionUrl?: string,
): string | undefined {
  // Priority: explicit siteUrl > URL inside campaignGoal > primary workspace site > profile.siteUrl.
  if (inputContext.siteUrl && /^https?:\/\//.test(inputContext.siteUrl)) {
    return inputContext.siteUrl;
  }
  const goal = inputContext.campaignGoal ?? "";
  const m = goal.match(/https?:\/\/[^\s)"']+/);
  if (m) return m[0];
  if (siteConnectionUrl && /^https?:\/\//.test(siteConnectionUrl)) {
    return siteConnectionUrl;
  }
  const profile = productProfileStore.get(workspaceId);
  if (profile?.siteUrl && /^https?:\/\//.test(profile.siteUrl)) {
    return profile.siteUrl;
  }
  return undefined;
}

function isGithubConfigured(
  repo: RepoConnectionConfig | undefined,
): repo is RepoConnectionConfig {
  return !!(repo?.accessToken || process.env.GITHUB_TOKEN) && !!repo?.owner && !!repo?.repo;
}

function addStep(taskId: string, type: "tool_call" | "tool_result", content: string) {
  skillRunsStore.addStep(taskId, { type, content });
}

function failRun(taskId: string, error: string): void {
  const workspaceId = skillRunsStore.get(taskId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;
  eventsStore.append("seo_orchestrator_failed", { skillRunId: taskId, error }, workspaceId);
  skillRunsStore.update(taskId, { status: "failed", error });
}

function finalizeRun(
  taskId: string,
  report: {
    executiveSummary: string;
    findings: string[];
    recommendations: string[];
    nextSteps: string[];
    proposedActions: ProposedAction[];
    decision?: AgentDecision;
    // Optional structured audit. When the caller passes the raw page findings
    // + url + score, we build a typed AuditOutput so the frontend can render
    // it as a real audit card instead of plain bullets.
    auditInput?: {
      url: string;
      score: number;
      pageFindings: Array<{ severity: string; id: string; message: string }>;
    };
  },
): void {
  const run = skillRunsStore.get(taskId);
  const structuredOutputs = report.auditInput
    ? [buildAuditStructuredOutput(report.auditInput, report.executiveSummary)]
    : undefined;
  skillRunsStore.update(taskId, {
    status: "completed",
    finalReport: {
      executiveSummary: report.executiveSummary,
      findings: report.findings,
      recommendations: report.recommendations,
      nextSteps: report.nextSteps,
      drafts: run?.drafts ?? [],
      proposedActions: report.proposedActions,
      decision: report.decision,
      structuredOutputs,
    },
  });
  eventsStore.append("seo_orchestrator_complete", {
    skillRunId: taskId,
    proposedActionCount: report.proposedActions.length,
  }, run?.workspaceId ?? DEFAULT_WORKSPACE_ID);
}

// Convert raw audit findings into the structured AuditOutput shape the
// frontend renderer understands. Groups findings by severity into sections.
function buildAuditStructuredOutput(
  input: {
    url: string;
    score: number;
    pageFindings: Array<{ severity: string; id: string; message: string }>;
  },
  summary: string,
): StructuredOutput {
  const byBucket: Record<"fail" | "warn" | "ok", typeof input.pageFindings> = {
    fail: [],
    warn: [],
    ok: [],
  };
  for (const f of input.pageFindings) {
    const sev = f.severity.toLowerCase();
    if (sev === "error" || sev === "fail" || sev === "high") byBucket.fail.push(f);
    else if (sev === "warning" || sev === "warn" || sev === "medium") byBucket.warn.push(f);
    else byBucket.ok.push(f);
  }
  const sections: AuditOutput["sections"] = [];
  if (byBucket.fail.length > 0) {
    sections.push({
      label: "Critical issues",
      severity: "fail",
      findings: byBucket.fail.map((f) => ({ title: f.id, detail: f.message })),
    });
  }
  if (byBucket.warn.length > 0) {
    sections.push({
      label: "Warnings",
      severity: "warn",
      findings: byBucket.warn.map((f) => ({ title: f.id, detail: f.message })),
    });
  }
  if (byBucket.ok.length > 0) {
    sections.push({
      label: "Passing checks",
      severity: "ok",
      findings: byBucket.ok.map((f) => ({ title: f.id, detail: f.message })),
    });
  }
  return {
    type: "audit",
    data: {
      title: `SEO Audit — ${input.url}`,
      url: input.url,
      score: input.score,
      summary,
      sections,
    },
  };
}

function makeAgentDecision(input: Omit<AgentDecision, "createdAt">): AgentDecision {
  return {
    ...input,
    createdAt: new Date().toISOString(),
  };
}

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

function recommendationsFromFindings(
  findings: { severity: string; id: string; message: string }[],
): string[] {
  const out: string[] = [];
  for (const f of findings) {
    if (f.severity === "critical") out.push(`Fix critical: ${f.message}`);
    else if (f.severity === "warning") out.push(`Improve: ${f.message}`);
  }
  return out;
}

function buildProposedActions(
  prUrl: string,
  altCount: number,
  metaCount: number,
  contentCount: number,
  copyCount: number,
): ProposedAction[] {
  return [
    {
      actionId: crypto.randomUUID(),
      type: "seo_update",
      title: "Merge the SEO fixes PR",
      description: `Review and merge ${prUrl} (${altCount} alt-text + ${metaCount} page-metadata + ${copyCount} existing-copy + ${contentCount} visible-content patches).`,
      status: "pending",
    },
  ];
}

const SEO_CHANGE_HEALTHY_SCORE = 90;

export function evaluateSeoChangeNecessity(input: {
  plan: SeoFixPlan;
  findings: Finding[];
  repoAnalysis?: RepoStructureAnalysis;
}): SeoChangeNecessityResult {
  const criticalFindings = input.findings.filter((finding) => finding.severity === "critical");
  const warningFindings = input.findings.filter((finding) => finding.severity === "warning");
  const materialRepoIssues =
    input.repoAnalysis?.issues.filter((issue) => issue.severity === "critical" || issue.severity === "warning") ?? [];

  const materialReasons: string[] = [];
  const informationalReasons: string[] = [];
  if (input.plan.healthScore < SEO_CHANGE_HEALTHY_SCORE) {
    informationalReasons.push(
      `SEO score is ${input.plan.healthScore}/100, below the healthy ${SEO_CHANGE_HEALTHY_SCORE}/100 bar.`,
    );
  }
  if (criticalFindings.length > 0) {
    materialReasons.push(`${criticalFindings.length} critical audit issue(s) need attention.`);
  }
  if (warningFindings.length > 0) {
    materialReasons.push(`${warningFindings.length} warning audit issue(s) need attention.`);
  }
  if (materialRepoIssues.length > 0) {
    materialReasons.push(`${materialRepoIssues.length} repo issue(s) can affect real page quality.`);
  }
  if (input.plan.items.length === 0) {
    informationalReasons.push("No source-level fix was selected.");
  }

  const hasMaterialReason = materialReasons.length > 0;
  const hasPlannedFix = input.plan.items.length > 0;
  const status: SeoChangeNecessityResult["status"] =
    hasMaterialReason && hasPlannedFix ? "needed" : "not_needed";
  const reasons = [...materialReasons, ...informationalReasons];

  return {
    status,
    summary: necessitySummary(status, materialReasons, informationalReasons, hasPlannedFix),
    reasons:
      reasons.length > 0
        ? reasons
        : ["SEO score is healthy and there are no critical, warning, or material repo issues."],
    checkedAt: new Date().toISOString(),
    healthScore: input.plan.healthScore,
    auditFindingCount: input.findings.length,
    criticalFindingCount: criticalFindings.length,
    warningFindingCount: warningFindings.length,
    materialRepoIssueCount: materialRepoIssues.length,
    plannedFixCount: input.plan.items.length,
  };
}

function necessitySummary(
  status: SeoChangeNecessityResult["status"],
  materialReasons: string[],
  informationalReasons: string[],
  hasPlannedFix: boolean,
): string {
  if (status === "needed") {
    return `A PR is justified because ${materialReasons[0] ?? "the audit found material work."}`;
  }
  if (!hasPlannedFix) {
    return "No PR is justified because no source-level fix was selected.";
  }
  if (materialReasons.length === 0 && informationalReasons.length > 0) {
    return "No PR is justified because only informational or nice-to-have issues remain.";
  }
  return "No PR is justified because the audit is healthy.";
}

export function runSeoFixQualityGate(input: {
  plan: SeoFixPlan;
  draftSource: DraftSource;
  altText: AltTextPatch[];
  pageMetadata: PageMetadataPatch[];
  visibleContent: VisibleContentPatch[];
  copyRewrite: CopyRewritePatch[];
  ctaRewrite: CtaRewritePatch[];
  faqSection: FaqSectionPatch[];
  visualUpgrade: VisualUpgradePatch[];
  productionUpgrade: ProductionSiteUpgradePatch[];
  interactiveConversionUpgrade: InteractiveConversionUpgradePatch[];
}): SeoFixQualityGateResult {
  const checks: SeoFixQualityGateResult["checks"] = [];
  const allPatchCount =
    input.altText.length +
    input.pageMetadata.length +
    input.visibleContent.length +
    input.copyRewrite.length +
    input.ctaRewrite.length +
    input.faqSection.length +
    input.visualUpgrade.length +
    input.productionUpgrade.length +
    input.interactiveConversionUpgrade.length;
  const visiblePatchCount =
    input.visibleContent.length +
    input.copyRewrite.length +
    input.ctaRewrite.length +
    input.faqSection.length +
    input.visualUpgrade.length +
    input.productionUpgrade.length +
    input.interactiveConversionUpgrade.length;

  addQualityCheck(checks, {
    id: "has-patches",
    label: "Has usable changes",
    status: allPatchCount > 0 ? "pass" : "fail",
    message:
      allPatchCount > 0
        ? `The draft contains ${allPatchCount} usable change(s).`
        : "The draft did not contain any usable changes.",
  });

  const plannedVisible = input.plan.items.some((item) => isVisibleFixKind(item.kind));
  addQualityCheck(checks, {
    id: "visible-impact",
    label: "Visible impact",
    status: visiblePatchCount > 0 || !plannedVisible ? "pass" : "fail",
    message:
      visiblePatchCount > 0
        ? `The draft includes ${visiblePatchCount} visitor-facing change(s).`
        : plannedVisible
          ? "The plan promised a visible improvement, but the draft only produced hidden fixes."
          : "No visible fix was planned, so hidden SEO fixes are acceptable for this run.",
  });

  const topItem = input.plan.items[0];
  addQualityCheck(checks, {
    id: "top-priority-present",
    label: "Top priority preserved",
    status: !topItem || hasPatchForPlanItem(input, topItem) ? "pass" : "fail",
    message:
      !topItem
        ? "No prioritized fix was selected."
        : hasPatchForPlanItem(input, topItem)
          ? `The draft includes the top priority ${labelFixKind(topItem.kind)} in ${topItem.filepath}.`
          : `The draft missed the top priority ${labelFixKind(topItem.kind)} in ${topItem.filepath}.`,
  });

  const duplicateTargets = duplicatePatchTargets(input);
  addQualityCheck(checks, {
    id: "no-duplicates",
    label: "No duplicate generated sections",
    status: duplicateTargets.length === 0 ? "pass" : "fail",
    message:
      duplicateTargets.length === 0
        ? "No duplicate patch targets were generated."
        : `Duplicate patch targets found: ${duplicateTargets.slice(0, 4).join(", ")}.`,
  });

  const standaloneHtmlBlocks = [
    ...input.visibleContent.filter((patch) => patch.style === "html-main").map((patch) => patch.filepath),
    ...input.faqSection.filter((patch) => patch.style === "html-main").map((patch) => patch.filepath),
  ];
  addQualityCheck(checks, {
    id: "no-standalone-html-blocks",
    label: "No standalone HTML text blocks",
    status: standaloneHtmlBlocks.length === 0 ? "pass" : "fail",
    message:
      standaloneHtmlBlocks.length === 0
        ? "HTML page changes use structured production, visual, or interactive sections instead of bare text blocks."
        : `Standalone HTML content/FAQ blocks are not allowed in ${standaloneHtmlBlocks.slice(0, 3).join(", ")}.`,
  });

  const unsafeCopy = userFacingPatchText(input).filter(isUnsafeQualityText);
  addQualityCheck(checks, {
    id: "copy-safety",
    label: "Copy safety",
    status: unsafeCopy.length === 0 ? "pass" : "fail",
    message:
      unsafeCopy.length === 0
        ? "Generated copy avoids HTML injection, unsupported legal claims, and unsafe price claims."
        : `Unsafe generated copy found: "${unsafeCopy[0]?.slice(0, 120)}".`,
  });

  const structuredProblems = structuredQualityProblems(input);
  addQualityCheck(checks, {
    id: "structured-usefulness",
    label: "Structured usefulness",
    status: structuredProblems.failures.length > 0 ? "fail" : structuredProblems.warnings.length > 0 ? "warn" : "pass",
    message:
      structuredProblems.failures[0] ??
      structuredProblems.warnings[0] ??
      "Structured sections include useful headings, supporting details, and clear next steps.",
  });

  const metadataWarnings = metadataQualityWarnings(input.pageMetadata);
  addQualityCheck(checks, {
    id: "metadata-quality",
    label: "Metadata quality",
    status: metadataWarnings.failures.length > 0 ? "fail" : metadataWarnings.warnings.length > 0 ? "warn" : "pass",
    message:
      metadataWarnings.failures[0] ??
      metadataWarnings.warnings[0] ??
      "Metadata drafts are within practical title and description length ranges.",
  });

  const genericCopyWarnings = userFacingPatchText(input).filter(isClearlyPlaceholderCopy);
  addQualityCheck(checks, {
    id: "no-placeholder-copy",
    label: "No placeholder copy",
    status: genericCopyWarnings.length > 0 ? "fail" : "pass",
    message:
      genericCopyWarnings.length === 0
        ? "Generated copy does not look like placeholder or filler text."
        : `Placeholder-like generated copy found: "${genericCopyWarnings[0]?.slice(0, 120)}".`,
  });

  addQualityCheck(checks, {
    id: "draft-source",
    label: "Draft source transparency",
    status: input.draftSource === "fallback" ? "warn" : "pass",
    message:
      input.draftSource === "fallback"
        ? "Gemini was unavailable, so conservative fallback copy was used."
        : "Gemini drafted the proposed copy and the deterministic gate validated it.",
  });

  const failCount = checks.filter((check) => check.status === "fail").length;
  const warnCount = checks.filter((check) => check.status === "warn").length;
  const score = Math.max(0, Math.min(100, 100 - failCount * 25 - warnCount * 8));
  const status: SeoFixQualityGateResult["status"] =
    failCount > 0 || score < 70 ? "blocked" : "passed";

  return {
    status,
    score,
    checkedAt: new Date().toISOString(),
    summary:
      status === "passed"
        ? `Passed ${checks.length - failCount - warnCount}/${checks.length} checks with ${warnCount} warning(s).`
        : `Blocked because ${failCount} quality check(s) failed.`,
    checks,
  };
}

function addQualityCheck(
  checks: SeoFixQualityGateResult["checks"],
  check: SeoFixQualityGateResult["checks"][number],
): void {
  checks.push(check);
}

type SeoFixQualityGateInput = Parameters<typeof runSeoFixQualityGate>[0];

function isVisibleFixKind(kind: SeoFixKind): boolean {
  return (
    kind === "copyRewrite" ||
    kind === "ctaRewrite" ||
    kind === "faqSection" ||
    kind === "visualUpgrade" ||
    kind === "productionUpgrade" ||
    kind === "interactiveConversionUpgrade" ||
    kind === "visibleContent"
  );
}

function hasPatchForPlanItem(
  input: SeoFixQualityGateInput,
  item: SeoFixPlanItem,
): boolean {
  if (item.kind === "copyRewrite") {
    return input.copyRewrite.some((patch) => patch.filepath === item.filepath && patch.targetId === item.target);
  }
  if (item.kind === "ctaRewrite") {
    return input.ctaRewrite.some((patch) => patch.filepath === item.filepath && patch.targetId === item.target);
  }
  if (item.kind === "faqSection") {
    return input.faqSection.some((patch) => patch.filepath === item.filepath);
  }
  if (item.kind === "visualUpgrade") {
    return input.visualUpgrade.some((patch) => patch.filepath === item.filepath);
  }
  if (item.kind === "productionUpgrade") {
    return input.productionUpgrade.some((patch) => patch.filepath === item.filepath);
  }
  if (item.kind === "interactiveConversionUpgrade") {
    return input.interactiveConversionUpgrade.some((patch) => patch.filepath === item.filepath);
  }
  if (item.kind === "visibleContent") {
    return input.visibleContent.some((patch) => patch.filepath === item.filepath);
  }
  if (item.kind === "pageMetadata") {
    return input.pageMetadata.some((patch) => patch.filepath === item.filepath);
  }
  return input.altText.some((patch) => patch.filepath === item.filepath && patch.imageSrc === item.target);
}

function duplicatePatchTargets(input: SeoFixQualityGateInput): string[] {
  const targets = [
    ...input.altText.map((patch) => `alt:${patch.filepath}:${patch.imageSrc}`),
    ...input.pageMetadata.map((patch) => `metadata:${patch.filepath}`),
    ...input.visibleContent.map((patch) => `visible:${patch.filepath}:${patch.heading}`),
    ...input.copyRewrite.map((patch) => `copy:${patch.filepath}:${patch.targetId}`),
    ...input.ctaRewrite.map((patch) => `cta:${patch.filepath}:${patch.targetId}`),
    ...input.faqSection.map((patch) => `faq:${patch.filepath}`),
    ...input.visualUpgrade.map((patch) => `visual:${patch.filepath}`),
    ...input.productionUpgrade.map((patch) => `production:${patch.filepath}`),
    ...input.interactiveConversionUpgrade.map((patch) => `interactive:${patch.filepath}`),
  ];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const target of targets) {
    if (seen.has(target)) duplicates.add(target);
    seen.add(target);
  }
  return Array.from(duplicates);
}

function userFacingPatchText(input: SeoFixQualityGateInput): string[] {
  return [
    ...input.altText.map((patch) => patch.altText),
    ...input.pageMetadata.flatMap((patch) => [patch.title, patch.description]),
    ...input.visibleContent.flatMap((patch) => [patch.heading, patch.body, ...(patch.bullets ?? [])]),
    ...input.copyRewrite.map((patch) => patch.replacementText),
    ...input.ctaRewrite.map((patch) => patch.replacementText),
    ...input.faqSection.flatMap((patch) => [
      patch.heading,
      ...patch.faqs.flatMap((faq) => [faq.question, faq.answer]),
    ]),
    ...input.visualUpgrade.flatMap((patch) => [
      patch.eyebrow,
      patch.heading,
      patch.body,
      patch.ctaText,
      ...patch.metrics.flatMap((metric) => [metric.value, metric.label]),
      ...patch.steps.flatMap((step) => [step.title, step.body]),
    ]),
    ...input.productionUpgrade.flatMap((patch) => [
      patch.fixDuplicateH1?.replacementLead,
      patch.section.eyebrow,
      patch.section.heading,
      patch.section.body,
      patch.section.ctaText,
      ...patch.section.highlights.flatMap((item) => [item.title, item.body]),
      ...(patch.section.comparisonRows ?? []).flatMap((row) => [
        row.feature,
        row.starter,
        row.growth,
        row.scale,
      ]),
    ]),
    ...input.interactiveConversionUpgrade.flatMap((patch) => [
      patch.section.eyebrow,
      patch.section.heading,
      patch.section.body,
      patch.section.calculatorTitle,
      patch.section.inputLabels.visitors,
      patch.section.inputLabels.conversionRate,
      patch.section.inputLabels.averageValue,
      patch.section.resultLabel,
      patch.section.ctaText,
      ...patch.section.recommendations.flatMap((item) => [item.title, item.body]),
    ]),
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function isUnsafeQualityText(value: string): boolean {
  const text = value.trim();
  if (/<|>/.test(text)) return true;
  if (/\b(refund|guarantee|legal|privacy|terms|copyright)\b/i.test(text)) return true;
  if (/[₹€£]\s?\d|\d+\s?(eur|gbp|inr)\b/i.test(text)) return true;
  return false;
}

function isClearlyPlaceholderCopy(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (/\b(lorem ipsum|placeholder|todo|insert copy|coming soon)\b/i.test(text)) return true;
  if (/\.{3,}/.test(text)) return true;
  return false;
}

function structuredQualityProblems(input: SeoFixQualityGateInput): {
  failures: string[];
  warnings: string[];
} {
  const failures: string[] = [];
  const warnings: string[] = [];

  for (const patch of input.interactiveConversionUpgrade) {
    const labelSet = new Set([
      patch.section.inputLabels.visitors.trim().toLowerCase(),
      patch.section.inputLabels.conversionRate.trim().toLowerCase(),
      patch.section.inputLabels.averageValue.trim().toLowerCase(),
    ]);
    if (patch.section.recommendations.length < 2) {
      failures.push(`${patch.filepath} interactive upgrade needs at least two recommendations.`);
    }
    if (labelSet.size < 3) {
      failures.push(`${patch.filepath} interactive calculator labels are too repetitive.`);
    }
    if (!textLengthBetween(patch.section.body, 70, 260)) {
      warnings.push(`${patch.filepath} interactive body should be concise but specific.`);
    }
  }

  for (const patch of input.productionUpgrade) {
    if (patch.section.highlights.length < 2) {
      failures.push(`${patch.filepath} production upgrade needs at least two useful highlights.`);
    }
    if (!textLengthBetween(patch.section.body, 70, 260)) {
      warnings.push(`${patch.filepath} production upgrade body should be clearer and more specific.`);
    }
    if (patch.section.ctaHref.trim() === "#") {
      warnings.push(`${patch.filepath} production upgrade CTA should point to a real local destination.`);
    }
  }

  for (const patch of input.visualUpgrade) {
    if (patch.metrics.length < 2 || patch.steps.length < 2) {
      failures.push(`${patch.filepath} visual upgrade needs at least two metrics and two workflow steps.`);
    }
  }

  for (const patch of input.faqSection) {
    if (patch.faqs.length < 2 || patch.faqs.length > 4) {
      failures.push(`${patch.filepath} FAQ section should contain 2-4 practical questions.`);
    }
  }

  for (const patch of input.visibleContent) {
    if (!textLengthBetween(patch.body, 60, 260)) {
      warnings.push(`${patch.filepath} visible section body should be concise but useful.`);
    }
  }

  for (const patch of input.copyRewrite) {
    if (patch.currentText.trim() === patch.replacementText.trim()) {
      failures.push(`${patch.filepath} copy rewrite did not change ${patch.targetId}.`);
    }
    if (patch.replacementText.trim().length < 8) {
      failures.push(`${patch.filepath} copy rewrite for ${patch.targetId} is too short.`);
    }
  }

  for (const patch of input.ctaRewrite) {
    if (patch.currentText.trim() === patch.replacementText.trim()) {
      failures.push(`${patch.filepath} CTA rewrite did not change ${patch.targetId}.`);
    }
    if (!textLengthBetween(patch.replacementText, 8, 64)) {
      warnings.push(`${patch.filepath} CTA text should be short, clear, and action-oriented.`);
    }
  }

  return { failures, warnings };
}

function metadataQualityWarnings(patches: PageMetadataPatch[]): {
  failures: string[];
  warnings: string[];
} {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const patch of patches) {
    if (patch.title !== undefined && !textLengthBetween(patch.title, 25, 70)) {
      warnings.push(`${patch.filepath} title is outside the practical 25-70 character range.`);
    }
    if (patch.description !== undefined && !textLengthBetween(patch.description, 70, 170)) {
      warnings.push(`${patch.filepath} description is outside the practical 70-170 character range.`);
    }
    if (patch.title === "" || patch.description === "") {
      failures.push(`${patch.filepath} metadata contains an empty title or description.`);
    }
  }
  return { failures, warnings };
}

function textLengthBetween(value: string | undefined, min: number, max: number): boolean {
  const length = (value ?? "").trim().length;
  return length >= min && length <= max;
}

function buildSeoFixApprovalPayload(input: {
  altText: AltTextPatch[];
  pageMetadata: PageMetadataPatch[];
  visibleContent: VisibleContentPatch[];
  copyRewrite: CopyRewritePatch[];
  ctaRewrite: CtaRewritePatch[];
  faqSection: FaqSectionPatch[];
  visualUpgrade: VisualUpgradePatch[];
  productionUpgrade: ProductionSiteUpgradePatch[];
  interactiveConversionUpgrade: InteractiveConversionUpgradePatch[];
  repo?: RepoConnectionConfig;
  plan: SeoFixPlan;
  qualityGate: SeoFixQualityGateResult;
  draftSource: DraftSource;
  fallbackReason?: string;
}): SeoFixApprovalPayload {
  return {
    type: "seo_pr_approval",
    toolName: "apply_seo_fixes",
    requiresApproval: true,
    altText: input.altText,
    pageMetadata: input.pageMetadata,
    visibleContent: input.visibleContent,
    copyRewrite: input.copyRewrite,
    ctaRewrite: input.ctaRewrite,
    faqSection: input.faqSection,
    visualUpgrade: input.visualUpgrade,
    productionUpgrade: input.productionUpgrade,
    interactiveConversionUpgrade: input.interactiveConversionUpgrade,
    repo: publicRepoConfig(input.repo),
    plan: input.plan,
    qualityGate: input.qualityGate,
    draftSource: input.draftSource,
    fallbackReason: input.fallbackReason,
    reason: formatPlanForPr(
      input.plan,
      input.draftSource,
      input.fallbackReason,
      input.qualityGate,
    ),
  };
}

function publicRepoConfig(repo: RepoConnectionConfig | undefined): RepoConnectionConfig | undefined {
  if (!repo) return undefined;
  return {
    owner: repo.owner,
    repo: repo.repo,
    defaultBranch: repo.defaultBranch,
    tokenSource: repo.tokenSource,
  };
}

function approvalSummaryForPayload(payload: SeoFixApprovalPayload): string {
  return [
    payload.plan.primaryFocus,
    `Quality gate passed with score ${payload.qualityGate.score}/100.`,
    `Prepared ${payload.interactiveConversionUpgrade.length} interactive upgrade(s), ${payload.productionUpgrade.length} production upgrade(s), ${payload.copyRewrite.length} copy rewrite(s), ${payload.ctaRewrite.length} CTA rewrite(s), ${payload.visualUpgrade.length} visual upgrade(s), ${payload.visibleContent.length} visible section(s), ${payload.faqSection.length} FAQ section(s), ${payload.pageMetadata.length} metadata fix(es), and ${payload.altText.length} alt-text fix(es).`,
    "No GitHub PR will be created until you approve.",
  ].join(" ");
}

export async function executeApprovedSeoFixApproval(
  approval: Approval,
): Promise<{ ok: boolean; prUrl?: string; error?: string }> {
  const payload = readSeoFixApprovalPayload(approval.proposedActionJson);
  if (!payload) {
    return { ok: false, error: "Approval does not contain a valid SEO PR payload." };
  }

  addStep(
    approval.skillRunId,
    "tool_call",
    `Approved apply_seo_fixes: ${payload.altText.length} alt-text + ${payload.pageMetadata.length} metadata + ${payload.productionUpgrade.length} production-upgrade + ${payload.interactiveConversionUpgrade.length} interactive-upgrade + ${payload.copyRewrite.length} copy-rewrite + ${payload.ctaRewrite.length} CTA-rewrite + ${payload.visualUpgrade.length} visual-upgrade + ${payload.visibleContent.length} visible-content + ${payload.faqSection.length} FAQ-section patch(es)`,
  );

  const write = await githubMdxConnector.applySeoFixes!({
    altText: payload.altText,
    pageMetadata: payload.pageMetadata,
    visibleContent: payload.visibleContent,
    copyRewrite: payload.copyRewrite,
    ctaRewrite: payload.ctaRewrite,
    faqSection: payload.faqSection,
    visualUpgrade: payload.visualUpgrade,
    productionUpgrade: payload.productionUpgrade,
    interactiveConversionUpgrade: payload.interactiveConversionUpgrade,
    repo: payload.repo,
    reason: payload.reason,
  });

  if (!write.success) {
    addStep(
      approval.skillRunId,
      "tool_result",
      "Approved apply_seo_fixes failed: connector returned failure.",
    );
    eventsStore.append("seo_pr_approval_execution_failed", {
      skillRunId: approval.skillRunId,
      approvalId: approval.id,
    }, approval.workspaceId);
    approvalsStore.update(approval.id, {
      decisionNote: "Approved, but GitHub PR creation failed. Check backend logs.",
    });
    updateRunReportAfterSeoApprovalFailure(approval.skillRunId, payload);
    return { ok: false, error: "GitHub PR could not be opened." };
  }

  const toolCall = toolCallsStore.create({
    skillRunId: approval.skillRunId,
    toolName: "apply_seo_fixes",
    tier: "YELLOW",
    inputJson: {
      plan: payload.plan,
      altText: payload.altText,
      pageMetadata: payload.pageMetadata,
      visibleContent: payload.visibleContent,
      copyRewrite: payload.copyRewrite,
      ctaRewrite: payload.ctaRewrite,
      faqSection: payload.faqSection,
      visualUpgrade: payload.visualUpgrade,
      productionUpgrade: payload.productionUpgrade,
      interactiveConversionUpgrade: payload.interactiveConversionUpgrade,
      repo: payload.repo,
      qualityGate: payload.qualityGate,
      draftSource: payload.draftSource,
      fallbackReason: payload.fallbackReason,
    },
    outputJson: { result: `Opened PR ${write.changeId}`, changeId: write.changeId },
    rollbackPayloadJson: write.rollbackPayload,
    status: "executed",
    executedAt: new Date().toISOString(),
  });

  approvalsStore.update(approval.id, {
    toolCallId: toolCall.id,
    decisionNote: `Approved and opened PR ${write.changeId}`,
  });
  addStep(approval.skillRunId, "tool_result", `Opened PR ${write.changeId}`);
  eventsStore.append("tool_executed_notify", {
    skillRunId: approval.skillRunId,
    approvalId: approval.id,
    toolCallId: toolCall.id,
    toolName: "apply_seo_fixes",
    tier: "YELLOW",
    prUrl: write.changeId,
  }, approval.workspaceId);
  updateRunReportAfterSeoApproval(approval.skillRunId, payload, write.changeId);
  return { ok: true, prUrl: write.changeId };
}

export function rejectSeoFixApproval(approval: Approval): void {
  const payload = readSeoFixApprovalPayload(approval.proposedActionJson);
  if (!payload) return;

  addStep(
    approval.skillRunId,
    "tool_result",
    `Rejected SEO PR plan: ${payload.plan.primaryFocus}. No GitHub PR was created.`,
  );
  eventsStore.append("seo_pr_approval_rejected", {
    skillRunId: approval.skillRunId,
    approvalId: approval.id,
  }, approval.workspaceId);
  updateRunReportAfterSeoRejection(approval.skillRunId, payload);
}

function readSeoFixApprovalPayload(value: unknown): SeoFixApprovalPayload | undefined {
  if (!isRecord(value)) return undefined;
  if (value.type !== "seo_pr_approval") return undefined;
  if (value.toolName !== "apply_seo_fixes") return undefined;
  if (value.requiresApproval !== true) return undefined;
  if (!Array.isArray(value.altText)) return undefined;
  if (!Array.isArray(value.pageMetadata)) return undefined;
  if (!Array.isArray(value.visibleContent)) return undefined;
  if (!Array.isArray(value.copyRewrite)) return undefined;
  if (value.ctaRewrite !== undefined && !Array.isArray(value.ctaRewrite)) return undefined;
  if (value.faqSection !== undefined && !Array.isArray(value.faqSection)) return undefined;
  if (value.visualUpgrade !== undefined && !Array.isArray(value.visualUpgrade)) return undefined;
  if (value.productionUpgrade !== undefined && !Array.isArray(value.productionUpgrade)) return undefined;
  if (
    value.interactiveConversionUpgrade !== undefined &&
    !Array.isArray(value.interactiveConversionUpgrade)
  ) {
    return undefined;
  }
  if (!isSeoFixPlan(value.plan)) return undefined;
  if (value.draftSource !== "gemini" && value.draftSource !== "fallback") return undefined;

  return {
    type: "seo_pr_approval",
    toolName: "apply_seo_fixes",
    requiresApproval: true,
    altText: value.altText as AltTextPatch[],
    pageMetadata: value.pageMetadata as PageMetadataPatch[],
    visibleContent: value.visibleContent as VisibleContentPatch[],
    copyRewrite: value.copyRewrite as CopyRewritePatch[],
    ctaRewrite: (value.ctaRewrite ?? []) as CtaRewritePatch[],
    faqSection: (value.faqSection ?? []) as FaqSectionPatch[],
    visualUpgrade: (value.visualUpgrade ?? []) as VisualUpgradePatch[],
    productionUpgrade: (value.productionUpgrade ?? []) as ProductionSiteUpgradePatch[],
    interactiveConversionUpgrade: (value.interactiveConversionUpgrade ?? []) as InteractiveConversionUpgradePatch[],
    repo: isRepoConnectionConfig(value.repo) ? value.repo : undefined,
    plan: value.plan,
    qualityGate: isSeoFixQualityGate(value.qualityGate)
      ? value.qualityGate
      : defaultQualityGate(),
    draftSource: value.draftSource,
    fallbackReason:
      typeof value.fallbackReason === "string" ? value.fallbackReason : undefined,
    reason:
      typeof value.reason === "string"
        ? value.reason
        : formatPlanForPr(
            value.plan,
            value.draftSource,
            undefined,
            isSeoFixQualityGate(value.qualityGate) ? value.qualityGate : undefined,
          ),
  };
}

function isRepoConnectionConfig(value: unknown): value is RepoConnectionConfig {
  return (
    isRecord(value) &&
    typeof value.owner === "string" &&
    value.owner.trim().length > 0 &&
    typeof value.repo === "string" &&
    value.repo.trim().length > 0 &&
    (value.defaultBranch === undefined || typeof value.defaultBranch === "string")
  );
}

function isSeoFixPlan(value: unknown): value is SeoFixPlan {
  return (
    isRecord(value) &&
    typeof value.auditUrl === "string" &&
    typeof value.healthScore === "number" &&
    typeof value.primaryFocus === "string" &&
    typeof value.strategySummary === "string" &&
    Array.isArray(value.items)
  );
}

function isSeoFixQualityGate(value: unknown): value is SeoFixQualityGateResult {
  return (
    isRecord(value) &&
    (value.status === "passed" || value.status === "blocked") &&
    typeof value.score === "number" &&
    typeof value.summary === "string" &&
    typeof value.checkedAt === "string" &&
    Array.isArray(value.checks)
  );
}

function defaultQualityGate(): SeoFixQualityGateResult {
  return {
    status: "passed",
    score: 100,
    summary: "Legacy approval created before quality-gate details were stored.",
    checkedAt: new Date().toISOString(),
    checks: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function updateRunReportAfterSeoApproval(
  taskId: string,
  payload: SeoFixApprovalPayload,
  prUrl: string,
): void {
  const run = skillRunsStore.get(taskId);
  const previous = run?.finalReport;
  skillRunsStore.update(taskId, {
    finalReport: {
      executiveSummary: `Approved SEO improvement plan and opened PR: ${prUrl}`,
      findings: previous?.findings ?? [],
      recommendations: previous?.recommendations ?? [],
      nextSteps: [
        `Review and merge the PR: ${prUrl}`,
        "Re-run the SEO audit after the PR is merged to measure the score change.",
      ],
      drafts: run?.drafts ?? [],
      proposedActions: [
        {
          actionId: taskId,
          type: "seo_pr_approval",
          title: "SEO improvement PR approved",
          description: approvalSummaryForPayload(payload),
          status: "executed",
          resolvedAt: new Date().toISOString(),
          result: `Opened PR ${prUrl}`,
        },
      ],
      decision: makeAgentDecision({
        kind: "pr_created",
        label: "PR created",
        summary: `The approved SEO improvement PR was opened: ${prUrl}`,
        reason: approvalSummaryForPayload(payload),
        nextStep: "Review and merge the PR, then check the verified impact in Settings.",
        severity: "success",
        link: prUrl,
      }),
    },
  });
}

function updateRunReportAfterSeoApprovalFailure(
  taskId: string,
  payload: SeoFixApprovalPayload,
): void {
  const run = skillRunsStore.get(taskId);
  const previous = run?.finalReport;
  skillRunsStore.update(taskId, {
    finalReport: {
      executiveSummary:
        "The SEO PR plan was approved, but GitHub PR creation failed.",
      findings: previous?.findings ?? [],
      recommendations: previous?.recommendations ?? [],
      nextSteps: ["Check backend logs for the GitHub connector error and retry."],
      drafts: run?.drafts ?? [],
      proposedActions: [
        {
          actionId: taskId,
          type: "seo_pr_approval",
          title: "SEO improvement PR approval failed",
          description: approvalSummaryForPayload(payload),
          status: "approved",
        },
      ],
      decision: makeAgentDecision({
        kind: "pr_failed",
        label: "PR creation failed",
        summary: "The SEO plan was approved, but GitHub did not create the PR.",
        reason: "The GitHub connector returned a failure during PR creation.",
        nextStep: "Check the backend logs and GitHub token/repo settings, then retry.",
        severity: "danger",
      }),
    },
  });
}

function updateRunReportAfterSeoRejection(
  taskId: string,
  payload: SeoFixApprovalPayload,
): void {
  const run = skillRunsStore.get(taskId);
  const previous = run?.finalReport;
  skillRunsStore.update(taskId, {
    finalReport: {
      executiveSummary:
        "The SEO improvement PR plan was rejected. No GitHub PR was created.",
      findings: previous?.findings ?? [],
      recommendations: previous?.recommendations ?? [],
      nextSteps: ["Run another SEO audit when you want a fresh plan."],
      drafts: run?.drafts ?? [],
      proposedActions: [
        {
          actionId: taskId,
          type: "seo_pr_approval",
          title: "SEO improvement PR rejected",
          description: approvalSummaryForPayload(payload),
          status: "rejected",
          resolvedAt: new Date().toISOString(),
        },
      ],
      decision: makeAgentDecision({
        kind: "pr_rejected",
        label: "PR rejected",
        summary: "The SEO improvement plan was rejected, so no GitHub PR was created.",
        reason: "The user rejected the approval request.",
        nextStep: "Run another SEO audit when you want a fresh proposal.",
        severity: "neutral",
      }),
    },
  });
}

const MAX_PLANNED_FIXES = 10;

export function buildSeoFixPlan(input: {
  siteUrl: string;
  healthScore: number;
  repoAnalysis?: RepoStructureAnalysis;
  findings: Finding[];
  altGaps: AltTextGap[];
  metadataGaps: PageMetadataGap[];
  visibleContentGaps: VisibleContentGap[];
  copyRewriteGaps: CopyRewriteGap[];
  ctaRewriteGaps: CtaRewriteGap[];
  faqSectionGaps: FaqSectionGap[];
  visualUpgradeGaps: VisualUpgradeGap[];
  productionUpgradeGaps: ProductionSiteUpgradeGap[];
  interactiveConversionUpgradeGaps: InteractiveConversionUpgradeGap[];
}): SeoFixPlan {
  const candidates: SeoFixPlanItem[] = [];
  const findingIds = new Set(input.findings.map((f) => f.id));

  for (const gap of input.copyRewriteGaps) {
    let score = 84;
    if (gap.tagName === "h1") score += 14;
    if (gap.tagName === "p") score += 8;
    if (isHomeFile(gap.filepath)) score += 14;
    if (matchesAuditedPage(input.siteUrl, gap.filepath)) score += 10;
    if (hasAnyFinding(findingIds, ["missing-h1", "multiple-h1", "thin-content"])) score += 12;

    candidates.push({
      kind: "copyRewrite",
      filepath: gap.filepath,
      target: gap.targetId,
      priority: priorityFromScore(score),
      reason: `Existing ${gap.tagName.toUpperCase()} copy is a visible page element. ${gap.reason}`,
      expectedVisibleResult:
        "Visitors should see clearer page copy immediately after the PR is merged.",
      score,
    });
  }

  for (const gap of input.ctaRewriteGaps) {
    let score = 86;
    if (isHomeFile(gap.filepath)) score += 12;
    if (matchesAuditedPage(input.siteUrl, gap.filepath)) score += 8;
    if (hasAnyFinding(findingIds, ["thin-content", "no-h2", "missing-h1"])) score += 8;

    candidates.push({
      kind: "ctaRewrite",
      filepath: gap.filepath,
      target: gap.targetId,
      priority: priorityFromScore(score),
      reason: gap.reason,
      expectedVisibleResult:
        "Visitors should see clearer button or link text that better explains the next action.",
      score,
    });
  }

  for (const gap of input.visualUpgradeGaps) {
    let score = 92;
    if (isHomeFile(gap.filepath)) score += 16;
    if (matchesAuditedPage(input.siteUrl, gap.filepath)) score += 12;
    if (hasAnyFinding(findingIds, ["thin-content", "no-h2", "missing-h1"])) score += 10;

    candidates.push({
      kind: "visualUpgrade",
      filepath: gap.filepath,
      target: "visual-upgrade-section",
      priority: priorityFromScore(score),
      reason: gap.reason,
      expectedVisibleResult:
        "Visitors should see a more polished, structured section with visual hierarchy, proof points, and a clearer CTA.",
      score,
    });
  }

  for (const gap of input.productionUpgradeGaps) {
    let score = 118;
    if (gap.issues.some((issue) => issue.startsWith("broken-link:"))) score += 20;
    if (gap.issues.includes("weak-pricing-structure")) score += 18;
    if (gap.issues.includes("duplicate-h1")) score += 14;
    if (gap.pageRole === "home") score += 10;
    if (gap.pageRole === "pricing") score += 12;
    if (matchesAuditedPage(input.siteUrl, gap.filepath)) score += 10;

    candidates.push({
      kind: "productionUpgrade",
      filepath: gap.filepath,
      target: "production-site-upgrade",
      priority: priorityFromScore(score),
      reason: gap.reason,
      expectedVisibleResult:
        "Visitors should see stronger page structure and layout, and repo-level issues like broken links or duplicate headings should be repaired.",
      score,
    });
  }

  for (const gap of input.interactiveConversionUpgradeGaps) {
    let score = 124;
    if (gap.pageRole === "home") score += 18;
    if (gap.pageRole === "pricing") score += 14;
    if (gap.pageRole === "features") score += 10;
    if (matchesAuditedPage(input.siteUrl, gap.filepath)) score += 12;
    if (hasAnyFinding(findingIds, ["thin-content", "no-h2", "missing-h1"])) score += 10;

    candidates.push({
      kind: "interactiveConversionUpgrade",
      filepath: gap.filepath,
      target: "interactive-conversion-upgrade",
      priority: priorityFromScore(score),
      reason: gap.reason,
      expectedVisibleResult:
        "Visitors should see a working calculator or planner section with polished layout, useful inputs, and a clearer CTA.",
      score,
    });
  }

  for (const gap of input.visibleContentGaps) {
    let score = 78;
    if (isHomeFile(gap.filepath)) score += 14;
    if (matchesAuditedPage(input.siteUrl, gap.filepath)) score += 10;
    if (hasAnyFinding(findingIds, ["thin-content", "no-h2", "missing-h1"])) score += 16;

    candidates.push({
      kind: "visibleContent",
      filepath: gap.filepath,
      target: "new-section",
      priority: priorityFromScore(score),
      reason: gap.reason,
      expectedVisibleResult:
        "Visitors should see a new helpful section on the page, not just hidden SEO metadata.",
      score,
    });
  }

  for (const gap of input.faqSectionGaps) {
    let score = 80;
    if (isHomeFile(gap.filepath)) score += 12;
    if (matchesAuditedPage(input.siteUrl, gap.filepath)) score += 8;
    if (hasAnyFinding(findingIds, ["thin-content", "no-h2"])) score += 14;

    candidates.push({
      kind: "faqSection",
      filepath: gap.filepath,
      target: "faq-section",
      priority: priorityFromScore(score),
      reason: gap.reason,
      expectedVisibleResult:
        "Visitors should see a new FAQ section that answers buyer questions directly on the page.",
      score,
    });
  }

  for (const gap of input.metadataGaps) {
    let score = 68;
    if (isHomeFile(gap.filepath)) score += 8;
    if (matchesAuditedPage(input.siteUrl, gap.filepath)) score += 12;
    if (
      hasAnyFinding(findingIds, [
        "missing-title",
        "title-length",
        "missing-meta-description",
        "meta-description-length",
      ])
    ) {
      score += 18;
    }

    candidates.push({
      kind: "pageMetadata",
      filepath: gap.filepath,
      target: "title-description",
      priority: priorityFromScore(score),
      reason: `Search result metadata needs attention: ${gap.issues.join(", ")}.`,
      expectedVisibleResult:
        "Search engines and browser tabs should get a clearer title or description. The page body may look unchanged.",
      score,
    });
  }

  for (const gap of input.altGaps) {
    let score = 44;
    if (isHomeFile(gap.filepath)) score += 6;
    if (matchesAuditedPage(input.siteUrl, gap.filepath)) score += 8;
    if (findingIds.has("images-missing-alt")) score += 18;

    candidates.push({
      kind: "altText",
      filepath: gap.filepath,
      target: gap.imageSrc,
      priority: priorityFromScore(score),
      reason: "The live SEO audit found images without descriptive alt text.",
      expectedVisibleResult:
        "The visible page usually looks the same, but screen readers and image SEO get better descriptive text.",
      score,
    });
  }

  const items = candidates
    .sort((a, b) => b.score - a.score || a.filepath.localeCompare(b.filepath))
    .slice(0, MAX_PLANNED_FIXES);

  return {
    auditUrl: input.siteUrl,
    healthScore: input.healthScore,
    auditFindingCount: input.findings.length,
    criticalFindingCount: input.findings.filter((finding) => finding.severity === "critical").length,
    warningFindingCount: input.findings.filter((finding) => finding.severity === "warning").length,
    findingIds: input.findings.map((finding) => finding.id),
    repoAnalysis: input.repoAnalysis,
    primaryFocus: primaryFocusFor(items),
    strategySummary: strategySummaryFor(items, input.findings, input.repoAnalysis),
    items,
  };
}

function selectAltGaps(gaps: AltTextGap[], plan: SeoFixPlan): AltTextGap[] {
  const selected = selectedKeys(plan, "altText");
  return gaps.filter((gap) => selected.has(`${gap.filepath}::${gap.imageSrc}`));
}

function selectMetadataGaps(
  gaps: PageMetadataGap[],
  plan: SeoFixPlan,
): PageMetadataGap[] {
  const selected = selectedKeys(plan, "pageMetadata");
  return gaps.filter((gap) => selected.has(`${gap.filepath}::title-description`));
}

function selectVisibleContentGaps(
  gaps: VisibleContentGap[],
  plan: SeoFixPlan,
): VisibleContentGap[] {
  const selected = selectedKeys(plan, "visibleContent");
  return gaps.filter((gap) => selected.has(`${gap.filepath}::new-section`));
}

function selectCopyRewriteGaps(
  gaps: CopyRewriteGap[],
  plan: SeoFixPlan,
): CopyRewriteGap[] {
  const selected = selectedKeys(plan, "copyRewrite");
  return gaps.filter((gap) => selected.has(`${gap.filepath}::${gap.targetId}`));
}

function selectCtaRewriteGaps(
  gaps: CtaRewriteGap[],
  plan: SeoFixPlan,
): CtaRewriteGap[] {
  const selected = selectedKeys(plan, "ctaRewrite");
  return gaps.filter((gap) => selected.has(`${gap.filepath}::${gap.targetId}`));
}

function selectFaqSectionGaps(
  gaps: FaqSectionGap[],
  plan: SeoFixPlan,
): FaqSectionGap[] {
  const selected = selectedKeys(plan, "faqSection");
  return gaps.filter((gap) => selected.has(`${gap.filepath}::faq-section`));
}

function selectVisualUpgradeGaps(
  gaps: VisualUpgradeGap[],
  plan: SeoFixPlan,
): VisualUpgradeGap[] {
  const selected = selectedKeys(plan, "visualUpgrade");
  return gaps.filter((gap) => selected.has(`${gap.filepath}::visual-upgrade-section`));
}

function selectProductionUpgradeGaps(
  gaps: ProductionSiteUpgradeGap[],
  plan: SeoFixPlan,
): ProductionSiteUpgradeGap[] {
  const selected = selectedKeys(plan, "productionUpgrade");
  return gaps.filter((gap) => selected.has(`${gap.filepath}::production-site-upgrade`));
}

function selectInteractiveConversionUpgradeGaps(
  gaps: InteractiveConversionUpgradeGap[],
  plan: SeoFixPlan,
): InteractiveConversionUpgradeGap[] {
  const selected = selectedKeys(plan, "interactiveConversionUpgrade");
  return gaps.filter((gap) => selected.has(`${gap.filepath}::interactive-conversion-upgrade`));
}

function selectedKeys(plan: SeoFixPlan, kind: SeoFixKind): Set<string> {
  return new Set(
    plan.items
      .filter((item) => item.kind === kind)
      .map((item) => `${item.filepath}::${item.target}`),
  );
}

function formatPlanForPr(
  plan: SeoFixPlan,
  draftSource: DraftSource = "gemini",
  fallbackReason?: string,
  qualityGate?: SeoFixQualityGateResult,
): string {
  return [
    `MarketPilot SEO audit on ${plan.auditUrl} (score ${plan.healthScore}/100).`,
    `Primary focus: ${plan.primaryFocus}`,
    `Strategy: ${plan.strategySummary}`,
    qualityGate
      ? `Quality gate: ${qualityGate.status} with score ${qualityGate.score}/100. ${qualityGate.summary}`
      : "",
    plan.repoAnalysis
      ? `Repo analysis: ${plan.repoAnalysis.projectKind} project, ${plan.repoAnalysis.pages.length} page(s), ${plan.repoAnalysis.issues.length} repo issue(s).`
      : "",
    `Draft source: ${draftSource === "gemini" ? "Gemini" : "fallback templates"}.`,
    draftSource === "fallback" && fallbackReason
      ? `Fallback reason: ${fallbackReason}`
      : "",
    "",
    "Prioritized fixes:",
    ...plan.items.map(
      (item, index) =>
        `${index + 1}. [${item.priority}] ${labelFixKind(item.kind)} in ${item.filepath} — ${item.reason}`,
    ),
  ].join("\n");
}

function priorityFromScore(score: number): SeoFixPriority {
  if (score >= 100) return "critical";
  if (score >= 86) return "high";
  if (score >= 66) return "medium";
  return "low";
}

function hasAnyFinding(findingIds: Set<string>, ids: string[]): boolean {
  return ids.some((id) => findingIds.has(id));
}

function isHomeFile(filepath: string): boolean {
  const normalized = filepath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized === "index.html" ||
    normalized.endsWith("/index.html") ||
    normalized.includes("content/pages/home.") ||
    normalized.includes("app/page.")
  );
}

function matchesAuditedPage(siteUrl: string, filepath: string): boolean {
  try {
    const path = new URL(siteUrl).pathname.replace(/^\/+|\/+$/g, "").toLowerCase();
    if (!path) return isHomeFile(filepath);
    const lastSegment = path.split("/").filter(Boolean).at(-1);
    if (!lastSegment) return isHomeFile(filepath);
    return filepath.toLowerCase().includes(lastSegment);
  } catch {
    return false;
  }
}

function primaryFocusFor(items: SeoFixPlanItem[]): string {
  const top = items[0];
  if (!top) return "No source-level fix was selected.";
  if (top.kind === "interactiveConversionUpgrade") return "Add a working conversion experience first";
  if (top.kind === "productionUpgrade") return "Apply repo-aware production site improvements first";
  if (top.kind === "copyRewrite" && isHomeFile(top.filepath)) {
    return "Improve visible homepage messaging first";
  }
  if (top.kind === "copyRewrite") return "Improve visible page copy first";
  if (top.kind === "ctaRewrite") return "Improve visible calls to action first";
  if (top.kind === "visualUpgrade") return "Improve page visuals and conversion flow first";
  if (top.kind === "faqSection") return "Add buyer-facing FAQ content first";
  if (top.kind === "visibleContent") return "Add useful visible content first";
  if (top.kind === "pageMetadata") return "Fix search result metadata first";
  return "Fix image accessibility and image SEO first";
}

function strategySummaryFor(
  items: SeoFixPlanItem[],
  findings: Finding[],
  repoAnalysis?: RepoStructureAnalysis,
): string {
  const visibleCount = items.filter(
    (item) =>
      item.kind === "copyRewrite" ||
      item.kind === "ctaRewrite" ||
      item.kind === "visualUpgrade" ||
      item.kind === "productionUpgrade" ||
      item.kind === "interactiveConversionUpgrade" ||
      item.kind === "visibleContent" ||
      item.kind === "faqSection",
  ).length;
  const metadataCount = items.filter((item) => item.kind === "pageMetadata").length;
  const altCount = items.filter((item) => item.kind === "altText").length;
  const criticalCount = findings.filter((finding) => finding.severity === "critical").length;
  const warningCount = findings.filter((finding) => finding.severity === "warning").length;

  return [
    `The audit found ${criticalCount} critical and ${warningCount} warning issue(s).`,
    repoAnalysis
      ? `Repo analysis identified a ${repoAnalysis.projectKind} project with ${repoAnalysis.issues.length} repo-level issue(s). ${repoAnalysis.recommendedFocus}`
      : "Repo analysis was unavailable, so the plan is based on source scans and live SEO findings.",
    `This PR prioritizes ${visibleCount} visible content/copy change(s), ${metadataCount} metadata change(s), and ${altCount} alt-text change(s).`,
    "Visible buyer-facing fixes are ranked above hidden metadata when both are available.",
  ].join(" ");
}

function labelFixKind(kind: SeoFixKind): string {
  if (kind === "interactiveConversionUpgrade") return "interactive conversion upgrade";
  if (kind === "productionUpgrade") return "production site upgrade";
  if (kind === "copyRewrite") return "existing copy rewrite";
  if (kind === "ctaRewrite") return "CTA text rewrite";
  if (kind === "visualUpgrade") return "visual page upgrade";
  if (kind === "faqSection") return "FAQ section";
  if (kind === "visibleContent") return "new visible section";
  if (kind === "pageMetadata") return "page metadata";
  return "image alt text";
}

function countDraftPatches(drafts: DraftedCopy): number {
  return (
    drafts.altText.length +
    drafts.pageMetadata.length +
    drafts.visibleContent.length +
    drafts.copyRewrite.length +
    drafts.ctaRewrite.length +
    drafts.faqSection.length +
    drafts.visualUpgrade.length +
    drafts.productionUpgrade.length +
    drafts.interactiveConversionUpgrade.length
  );
}

export function draftFallbackCopy(ctx: {
  workspaceId?: string;
  siteUrl: string;
  inputContext: Record<string, string>;
  altGaps: AltTextGap[];
  metadataGaps: PageMetadataGap[];
  visibleContentGaps: VisibleContentGap[];
  copyRewriteGaps: CopyRewriteGap[];
  ctaRewriteGaps: CtaRewriteGap[];
  faqSectionGaps: FaqSectionGap[];
  visualUpgradeGaps: VisualUpgradeGap[];
  productionUpgradeGaps: ProductionSiteUpgradeGap[];
  interactiveConversionUpgradeGaps: InteractiveConversionUpgradeGap[];
  repoAnalysis?: RepoStructureAnalysis;
}): DraftedCopy {
  const workspaceId = ctx.workspaceId ?? DEFAULT_WORKSPACE_ID;
  const productName = fallbackProductName(ctx.inputContext, ctx.siteUrl, workspaceId);
  const audience = fallbackAudience(ctx.inputContext, workspaceId);
  const channel = fallbackChannel(ctx.inputContext);

  return {
    altText: ctx.altGaps.map((gap) => ({
      filepath: gap.filepath,
      imageSrc: gap.imageSrc,
      altText: fallbackAltText(gap.imageSrc, productName, channel),
    })),
    pageMetadata: ctx.metadataGaps.map((gap) => ({
      filepath: gap.filepath,
      title: fallbackTitle(gap.filepath, productName, channel),
      description: fallbackDescription(gap.filepath, productName, audience, channel),
    })),
    visibleContent: ctx.visibleContentGaps.map((gap) => ({
      filepath: gap.filepath,
      heading: fallbackSectionHeading(gap.filepath, productName),
      body: `${productName} gives ${audience} a clearer way to review, improve, and ship ${channel} work without losing track of what changed.`,
      bullets: [
        "Find the most important page issues first",
        "Review proposed changes before merging them",
        "Keep a rollback path for every agent-created update",
      ],
    })),
    copyRewrite: ctx.copyRewriteGaps
      .map((gap) => ({
        filepath: gap.filepath,
        targetId: gap.targetId,
        tagName: gap.tagName,
        currentText: gap.currentText,
        replacementText: fallbackCopyReplacement(gap, productName, audience, channel),
      }))
      .filter((patch) => patch.replacementText !== patch.currentText.trim()),
    ctaRewrite: ctx.ctaRewriteGaps
      .map((gap) => ({
        filepath: gap.filepath,
        targetId: gap.targetId,
        element: gap.element,
        currentText: gap.currentText,
        replacementText: fallbackCtaReplacement(gap, productName, channel),
      }))
      .filter((patch) => patch.replacementText !== patch.currentText.trim()),
    faqSection: ctx.faqSectionGaps.map((gap) => ({
      filepath: gap.filepath,
      heading: fallbackFaqHeading(gap.filepath, productName),
      faqs: fallbackFaqs(productName, audience, channel),
    })),
    visualUpgrade: ctx.visualUpgradeGaps.map((gap) => ({
      filepath: gap.filepath,
      stylesheetPath: gap.stylesheetPath,
      eyebrow: "Agent-guided growth",
      heading: fallbackVisualHeading(gap.filepath, productName),
      body: `${productName} gives ${audience} a clearer operating layer for finding ${channel} opportunities, reviewing proposed changes, and shipping improvements with confidence.`,
      metrics: [
        { value: "1", label: "workspace for audits, proposed actions, and approvals" },
        { value: "3", label: "clear steps from issue discovery to reviewed PR" },
        { value: "100%", label: "review-first workflow before code changes go live" },
      ],
      steps: [
        {
          title: "Audit the page",
          body: "Find visible and technical gaps that can improve the customer journey.",
        },
        {
          title: "Review the plan",
          body: "See the proposed frontend change before a pull request is created.",
        },
        {
          title: "Ship with rollback",
          body: "Merge approved updates with a clear path to close or revert them.",
        },
      ],
      ctaText: fallbackVisualCtaText(channel),
      ctaHref: isHomeFile(gap.filepath) ? "features.html" : "index.html",
    })),
    productionUpgrade: ctx.productionUpgradeGaps.map((gap) =>
      fallbackProductionUpgrade(gap, productName, audience, channel, ctx.repoAnalysis),
    ),
    interactiveConversionUpgrade: ctx.interactiveConversionUpgradeGaps.map((gap) =>
      fallbackInteractiveConversionUpgrade(gap, productName, audience, channel),
    ),
  };
}

function fallbackProductName(
  inputContext: Record<string, string>,
  siteUrl: string,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): string {
  const profile = productProfileStore.get(workspaceId);
  return (
    cleanFallbackPhrase(inputContext.productName) ||
    cleanFallbackPhrase(profile?.productName) ||
    brandFromUrl(siteUrl) ||
    "Your product"
  );
}

function fallbackAudience(
  inputContext: Record<string, string>,
  workspaceId: string = DEFAULT_WORKSPACE_ID,
): string {
  const profile = productProfileStore.get(workspaceId);
  return (
    cleanFallbackPhrase(inputContext.targetAudience) ||
    cleanFallbackPhrase(profile?.icp) ||
    "growing teams"
  );
}

function fallbackChannel(inputContext: Record<string, string>): string {
  const channel = cleanFallbackPhrase(inputContext.mainChannel);
  if (!channel) return "marketing";
  return channel.toLowerCase().includes("seo") ? "SEO" : channel;
}

function fallbackCopyReplacement(
  gap: CopyRewriteGap,
  productName: string,
  audience: string,
  channel: string,
): string {
  const shortAudience = titleCase(shortenPhrase(audience, 42));
  const shortChannel = channel.toLowerCase() === "seo" ? "SEO" : titleCase(channel);

  if (gap.tagName === "h1") {
    return clampSentence(`${productName} for ${shortAudience}`, 90);
  }

  if (gap.tagName === "h2") {
    if (gap.filepath.toLowerCase().includes("pricing")) {
      return clampSentence(`Choose the Right ${productName} Plan`, 90);
    }
    return clampSentence(`Improve ${shortChannel} Work With ${productName}`, 90);
  }

  if (gap.filepath.toLowerCase().includes("pricing")) {
    return clampSentence(
      `Compare ${productName} plans and choose the option that fits your current ${channel} workflow.`,
      170,
    );
  }

  return clampSentence(
    `${productName} helps ${audience} plan, improve, and ship ${channel} campaigns from one focused workspace.`,
    170,
  );
}

function fallbackCtaReplacement(
  gap: CtaRewriteGap,
  productName: string,
  channel: string,
): string {
  const shortChannel = channel.toLowerCase() === "seo" ? "SEO" : titleCase(channel);

  if (/\bdemo\b/i.test(gap.currentText)) {
    return clampSentence(`See ${productName} in Action`, 62);
  }
  if (/\bstart|try|get\b/i.test(gap.currentText)) {
    return clampSentence(`Start Improving ${shortChannel}`, 62);
  }
  if (/\blearn|more\b/i.test(gap.currentText)) {
    return clampSentence(`Explore ${shortChannel} Workflows`, 62);
  }
  return clampSentence(`Review ${productName}`, 62);
}

function fallbackFaqHeading(filepath: string, productName: string): string {
  if (filepath.toLowerCase().includes("pricing")) {
    return `Questions before choosing ${productName}`;
  }
  return `Frequently asked questions about ${productName}`;
}

function fallbackFaqs(
  productName: string,
  audience: string,
  channel: string,
): Array<{ question: string; answer: string }> {
  return [
    {
      question: `What does ${productName} help teams improve?`,
      answer: `${productName} helps ${audience} find priority ${channel} issues, review suggested fixes, and ship clearer marketing updates through a controlled workflow.`,
    },
    {
      question: "Can teams review changes before they go live?",
      answer: "Yes. The agent prepares proposed changes first, then waits for approval before creating a GitHub pull request.",
    },
    {
      question: "What happens if a change is not right?",
      answer: "Each agent-created write keeps a rollback path, so teams can close or revert the proposed change instead of editing blindly.",
    },
  ];
}

function fallbackVisualHeading(filepath: string, productName: string): string {
  if (filepath.toLowerCase().includes("pricing")) {
    return `A clearer way to choose and approve ${productName}`;
  }
  if (filepath.toLowerCase().includes("feature")) {
    return `Turn ${productName} features into a cleaner growth workflow`;
  }
  return `See how ${productName} moves work from audit to approved update`;
}

function fallbackVisualCtaText(channel: string): string {
  const shortChannel = channel.toLowerCase() === "seo" ? "SEO" : titleCase(channel);
  return `Explore the ${shortChannel} Workflow`;
}

function fallbackProductionUpgrade(
  gap: ProductionSiteUpgradeGap,
  productName: string,
  audience: string,
  channel: string,
  repoAnalysis?: RepoStructureAnalysis,
): DraftedCopy["productionUpgrade"][number] {
  const shortChannel = channel.toLowerCase() === "seo" ? "SEO" : titleCase(channel);
  const isPricing = gap.pageRole === "pricing";
  const hasDuplicateH1 = gap.issues.includes("duplicate-h1");

  return {
    filepath: gap.filepath,
    pageRole: gap.pageRole,
    stylesheetPath: gap.stylesheetPath,
    fixDuplicateH1: hasDuplicateH1
      ? {
          replacementLead: isPricing
            ? `Compare plans by launch volume, approval needs, and ${channel} workflow maturity before choosing your workspace.`
            : `${productName} helps ${audience} turn marketing opportunities into reviewed, trackable website improvements.`,
        }
      : undefined,
    linkRepairs: gap.brokenLocalLinks.map((link) => ({
      currentHref: link.href,
      replacementHref: link.suggestedHref,
    })),
    section: {
      eyebrow: repoAnalysis?.projectKind === "static-html" ? "Production-ready workflow" : "Site improvement plan",
      heading: isPricing
        ? `Choose the ${productName} plan with clearer decision support`
        : `A stronger path from ${shortChannel} insight to approved site update`,
      body: isPricing
        ? `${productName} now gives buyers a clearer way to compare plan fit, review upgrade paths, and move from interest to action without guessing.`
        : `${productName} connects audit findings, approval review, and PR-based shipping so teams can improve the site without losing control of quality.`,
      highlights: [
        {
          title: "Fix what blocks visitors",
          body: "Repair obvious experience issues first, including broken local links and confusing page hierarchy.",
        },
        {
          title: "Make decisions easier",
          body: "Add structured guidance so visitors understand which next step fits their situation.",
        },
        {
          title: "Keep changes reviewable",
          body: "Ship improvements through pull requests so every update has history and rollback.",
        },
      ],
      comparisonRows: isPricing
        ? [
            {
              feature: "Best fit",
              starter: "One launch or focused audit",
              growth: "Multiple campaigns and approvals",
              scale: "Team-wide marketing operations",
            },
            {
              feature: "Review workflow",
              starter: "Basic proposed changes",
              growth: "Prioritized PR-ready improvements",
              scale: "Expanded approval and rollback control",
            },
            {
              feature: "Recommended next step",
              starter: "Start with a focused SEO audit",
              growth: "Review campaign and page improvements",
              scale: "Centralize recurring optimization work",
            },
          ]
        : undefined,
      ctaText: isPricing ? "Compare Plan Fit" : `Explore the ${shortChannel} Workflow`,
      ctaHref: isPricing ? "features.html" : "features.html",
    },
  };
}

function fallbackInteractiveConversionUpgrade(
  gap: InteractiveConversionUpgradeGap,
  productName: string,
  audience: string,
  channel: string,
): DraftedCopy["interactiveConversionUpgrade"][number] {
  const shortChannel = channel.toLowerCase() === "seo" ? "SEO" : titleCase(channel);
  const isPricing = gap.pageRole === "pricing";

  return {
    filepath: gap.filepath,
    pageRole: gap.pageRole,
    stylesheetPath: gap.stylesheetPath,
    section: {
      eyebrow: isPricing ? "Plan-fit estimator" : "Interactive growth planner",
      heading: isPricing
        ? `Estimate the value of improving ${shortChannel} before choosing a plan`
        : `Calculate the ${shortChannel} opportunity ${productName} can help uncover`,
      body: `${productName} helps ${audience} turn page traffic, conversion goals, and review-ready recommendations into a clearer next step.`,
      calculatorTitle: "Estimate monthly opportunity",
      inputLabels: {
        visitors: "Monthly website visitors",
        conversionRate: "Current conversion rate (%)",
        averageValue: "Average lead or signup value",
      },
      resultLabel: "Estimated monthly opportunity",
      recommendations: [
        {
          title: "Audit the highest-intent page",
          body: `Start with the page closest to a ${shortChannel} conversion so fixes are easier to measure.`,
        },
        {
          title: "Review suggested changes",
          body: "Use the approval workflow to compare the proposed update before GitHub is touched.",
        },
        {
          title: "Ship and re-check",
          body: "Merge the PR, re-run the audit, and keep the rollback path available if the result is not right.",
        },
      ],
      ctaText: isPricing ? "Compare Plan Fit" : `Explore the ${shortChannel} Workflow`,
      ctaHref: "features.html",
    },
  };
}

function fallbackTitle(
  filepath: string,
  productName: string,
  channel: string,
): string {
  const page = pageLabel(filepath);
  if (page === "Pricing") return clampSentence(`${productName} Pricing for SaaS Teams`, 62);
  if (page === "Home") return clampSentence(`${productName} for SaaS ${channel} Teams`, 62);
  return clampSentence(`${page} - ${productName}`, 62);
}

function fallbackDescription(
  filepath: string,
  productName: string,
  audience: string,
  channel: string,
): string {
  const page = pageLabel(filepath).toLowerCase();
  if (page === "pricing") {
    return clampSentence(
      `Compare ${productName} plans for ${audience}. Review features, choose a fit, and improve your ${channel} workflow with confidence.`,
      155,
    );
  }

  return clampSentence(
    `${productName} helps ${audience} improve ${channel}, review agent-created changes, and ship clearer marketing pages faster.`,
    155,
  );
}

function fallbackSectionHeading(filepath: string, productName: string): string {
  if (filepath.toLowerCase().includes("pricing")) {
    return `How to choose a ${productName} plan`;
  }
  return `How ${productName} helps teams move faster`;
}

function fallbackAltText(
  imageSrc: string,
  productName: string,
  channel: string,
): string {
  const label = imageSrc
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/\.[a-z0-9]+$/i, "")
    .replace(/[-_]+/g, " ")
    .trim();
  const topic = label ? `${label} view` : `${channel} dashboard view`;
  return clampSentence(`${productName} ${topic} for marketing teams`, 115);
}

function cleanFallbackPhrase(value: string | undefined): string {
  return (value ?? "")
    .replace(/https?:\/\/[^\s)"']+/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function brandFromUrl(siteUrl: string): string {
  try {
    const host = new URL(siteUrl).hostname.replace(/^www\./, "");
    const first = host.split(".")[0];
    return titleCase(first.replace(/[-_]+/g, " "));
  } catch {
    return "";
  }
}

function pageLabel(filepath: string): string {
  const lower = filepath.toLowerCase();
  if (isHomeFile(filepath)) return "Home";
  if (lower.includes("pricing")) return "Pricing";
  if (lower.includes("feature")) return "Features";
  const file = filepath.split(/[\\/]/).at(-1) ?? "Page";
  return titleCase(file.replace(/\.[a-z0-9]+$/i, "").replace(/[-_]+/g, " "));
}

function shortenPhrase(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const words = value.split(" ");
  const kept: string[] = [];
  for (const word of words) {
    const next = [...kept, word].join(" ");
    if (next.length > maxLength) break;
    kept.push(word);
  }
  return kept.join(" ") || value.slice(0, maxLength).trim();
}

function clampSentence(value: string, maxLength: number): string {
  const cleaned = value.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return shortenPhrase(cleaned, maxLength).replace(/[.,;:]$/, "");
}

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => {
      if (word.toUpperCase() === word && word.length <= 4) return word;
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function renderProductProfile(workspaceId: string = DEFAULT_WORKSPACE_ID): string {
  const p = productProfileStore.get(workspaceId);
  if (!p) return "(no product profile)";
  return [
    `Product: ${p.productName} — ${p.tagline}`,
    `Industry: ${p.industry} · Stage: ${p.stage}`,
    `Positioning: ${p.positioning}`,
    `ICP: ${p.icp}`,
    `Voice: ${p.voiceTone.join(", ")}`,
  ].join("\n");
}

// ----------------------------------------------------------------------------
//  Gemini draft step — single round-trip, structured JSON output.
// ----------------------------------------------------------------------------

async function draftCopy(
  apiKey: string,
  ctx: {
    siteUrl: string;
    auditedPageTitle: string;
    productProfileText: string;
    userHint: string;
    fixPlan: SeoFixPlan;
    altGaps: AltTextGap[];
    metadataGaps: PageMetadataGap[];
    visibleContentGaps: VisibleContentGap[];
    copyRewriteGaps: CopyRewriteGap[];
    ctaRewriteGaps: CtaRewriteGap[];
    faqSectionGaps: FaqSectionGap[];
    visualUpgradeGaps: VisualUpgradeGap[];
    productionUpgradeGaps: ProductionSiteUpgradeGap[];
    interactiveConversionUpgradeGaps: InteractiveConversionUpgradeGap[];
    repoAnalysis?: RepoStructureAnalysis;
    skillContent: string;
  },
): Promise<DraftedCopy> {
  const prompt = buildDraftPrompt(ctx);

  // Hard cap the LLM call so a slow Gemini doesn't hang the whole run.
  const res = await fetch(`${GEMINI_DRAFT_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        responseMimeType: "application/json",
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = (await res.json()) as Record<string, unknown>;
  const candidate = (json.candidates as Record<string, unknown>[])?.[0];
  const content = candidate?.content as Record<string, unknown> | undefined;
  const parts = content?.parts as Array<{ text?: string }> | undefined;
  const text = parts?.[0]?.text ?? "{}";

  let parsed: DraftedCopy = {
    altText: [],
    pageMetadata: [],
    visibleContent: [],
    copyRewrite: [],
    ctaRewrite: [],
    faqSection: [],
    visualUpgrade: [],
    productionUpgrade: [],
    interactiveConversionUpgrade: [],
  };
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (Array.isArray(raw.altText)) parsed.altText = raw.altText as DraftedCopy["altText"];
    if (Array.isArray(raw.pageMetadata)) {
      parsed.pageMetadata = raw.pageMetadata as DraftedCopy["pageMetadata"];
    }
    if (Array.isArray(raw.visibleContent)) {
      parsed.visibleContent = raw.visibleContent as DraftedCopy["visibleContent"];
    }
    if (Array.isArray(raw.copyRewrite)) {
      parsed.copyRewrite = raw.copyRewrite as DraftedCopy["copyRewrite"];
    }
    if (Array.isArray(raw.ctaRewrite)) {
      parsed.ctaRewrite = raw.ctaRewrite as DraftedCopy["ctaRewrite"];
    }
    if (Array.isArray(raw.faqSection)) {
      parsed.faqSection = raw.faqSection as DraftedCopy["faqSection"];
    }
    if (Array.isArray(raw.visualUpgrade)) {
      parsed.visualUpgrade = raw.visualUpgrade as DraftedCopy["visualUpgrade"];
    }
    if (Array.isArray(raw.productionUpgrade)) {
      parsed.productionUpgrade = raw.productionUpgrade as DraftedCopy["productionUpgrade"];
    }
    if (Array.isArray(raw.interactiveConversionUpgrade)) {
      parsed.interactiveConversionUpgrade = raw.interactiveConversionUpgrade as DraftedCopy["interactiveConversionUpgrade"];
    }
  } catch {
    // Leave as empty; caller surfaces the no-patches case to the user.
  }
  return parsed;
}

function buildDraftPrompt(ctx: {
  siteUrl: string;
  auditedPageTitle: string;
  productProfileText: string;
  userHint: string;
  fixPlan: SeoFixPlan;
  altGaps: AltTextGap[];
  metadataGaps: PageMetadataGap[];
  visibleContentGaps: VisibleContentGap[];
  copyRewriteGaps: CopyRewriteGap[];
  ctaRewriteGaps: CtaRewriteGap[];
  faqSectionGaps: FaqSectionGap[];
  visualUpgradeGaps: VisualUpgradeGap[];
  productionUpgradeGaps: ProductionSiteUpgradeGap[];
  interactiveConversionUpgradeGaps: InteractiveConversionUpgradeGap[];
  repoAnalysis?: RepoStructureAnalysis;
  skillContent: string;
}): string {
  const altInput = ctx.altGaps.map((g) => ({
    filepath: g.filepath,
    imageSrc: g.imageSrc,
  }));
  const metaInput = ctx.metadataGaps.map((g) => ({
    filepath: g.filepath,
    style: g.style,
    currentTitle: g.currentTitle ?? "",
    currentDescription: g.currentDescription ?? "",
    issues: g.issues,
  }));
  const visibleInput = ctx.visibleContentGaps.map((g) => ({
    filepath: g.filepath,
    style: g.style,
    reason: g.reason,
    existingHeadings: g.existingHeadings,
  }));
  const copyRewriteInput = ctx.copyRewriteGaps.map((g) => ({
    filepath: g.filepath,
    targetId: g.targetId,
    tagName: g.tagName,
    currentText: g.currentText,
    reason: g.reason,
  }));
  const ctaRewriteInput = ctx.ctaRewriteGaps.map((g) => ({
    filepath: g.filepath,
    targetId: g.targetId,
    element: g.element,
    currentText: g.currentText,
    reason: g.reason,
  }));
  const faqSectionInput = ctx.faqSectionGaps.map((g) => ({
    filepath: g.filepath,
    style: g.style,
    reason: g.reason,
    existingHeadings: g.existingHeadings,
  }));
  const visualUpgradeInput = ctx.visualUpgradeGaps.map((g) => ({
    filepath: g.filepath,
    style: g.style,
    stylesheetPath: g.stylesheetPath,
    reason: g.reason,
    existingHeadings: g.existingHeadings,
  }));
  const productionUpgradeInput = ctx.productionUpgradeGaps.map((g) => ({
    filepath: g.filepath,
    pageRole: g.pageRole,
    stylesheetPath: g.stylesheetPath,
    reason: g.reason,
    issues: g.issues,
    existingHeadings: g.existingHeadings,
    brokenLocalLinks: g.brokenLocalLinks,
  }));
  const interactiveConversionUpgradeInput = ctx.interactiveConversionUpgradeGaps.map((g) => ({
    filepath: g.filepath,
    pageRole: g.pageRole,
    stylesheetPath: g.stylesheetPath,
    reason: g.reason,
    existingHeadings: g.existingHeadings,
    ctaTexts: g.ctaTexts,
  }));

  return [
    "You are MarketPilot AI's SEO copy writer. You are drafting fixes for",
    `${ctx.siteUrl}. Output STRICT JSON — no commentary, no markdown fences.`,
    "",
    "Product context:",
    ctx.productProfileText,
    "",
    "AGENT FIX PLAN:",
    `Primary focus: ${ctx.fixPlan.primaryFocus}`,
    `Strategy: ${ctx.fixPlan.strategySummary}`,
    ctx.repoAnalysis
      ? `Repo analysis: ${ctx.repoAnalysis.projectKind} project, ${ctx.repoAnalysis.pages.length} page(s), ${ctx.repoAnalysis.issues.length} repo issue(s). ${ctx.repoAnalysis.recommendedFocus}`
      : "Repo analysis: unavailable.",
    ctx.repoAnalysis
      ? `Site structure: ${formatSiteStructureForPrompt(ctx.repoAnalysis)}`
      : "Site structure: unavailable.",
    "Selected fixes, in priority order:",
    JSON.stringify(
      ctx.fixPlan.items.map((item) => ({
        kind: item.kind,
        filepath: item.filepath,
        target: item.target,
        priority: item.priority,
        reason: item.reason,
        expectedVisibleResult: item.expectedVisibleResult,
      })),
      null,
      2,
    ),
    "",
    "AUDITED SITE IDENTITY:",
    `URL: ${ctx.siteUrl}`,
    `Current page title: ${ctx.auditedPageTitle || "(not found)"}`,
    "Important: MarketPilot AI is the platform running this agent. Do NOT use MarketPilot as the audited site's brand unless the audited site itself says MarketPilot.",
    "",
    ...(ctx.userHint
      ? [
          "USER GUIDANCE (apply where relevant, but do NOT skip fixing other gaps):",
          ctx.userHint,
          "",
        ]
      : []),
    "RULES:",
    "- Alt text: 8-15 words, descriptive, naturally use 1-2 keywords from the page topic.",
    '- Page title: 25-65 characters. Include primary keyword near the start. No "|" branding unless natural.',
    "- Page description: 70-165 characters. Compelling value prop + 1 keyword + CTA verb.",
    "- Visible content: add one short FAQ, next-step, or decision-support section. Make it useful on the actual page, not generic filler.",
    "- Visible content must be 1 heading, 1 short paragraph, and 2-4 bullets. Do not change pricing, legal claims, forms, navigation, or existing CTA text.",
    "- Existing copy rewrites: improve the exact currentText only. Keep the meaning accurate. Make headlines clearer and paragraphs more specific.",
    "- Existing copy rewrites must not mention prices, discounts, guarantees, legal terms, or unsupported claims.",
    "- For copy rewrites, preserve the filepath, targetId, tagName, and currentText exactly as provided. Only replacementText is new.",
    "- CTA rewrites: improve the exact currentText only. Keep it short, action-oriented, and truthful. Do not mention prices, discounts, guarantees, legal terms, or unsupported claims.",
    "- For CTA rewrites, preserve the filepath, targetId, element, and currentText exactly as provided. Only replacementText is new.",
    "- FAQ sections: write 2-4 practical buyer questions with short answers. Do not invent integrations, prices, customer names, guarantees, or legal claims.",
    "- Visual upgrades: create one polished conversion-focused section using concise copy, 2-3 metrics, 2-3 workflow steps, and one CTA. This will be rendered with CSS by the connector.",
    "- For visual upgrades, preserve filepath and stylesheetPath exactly. Do not invent code, scripts, prices, guarantees, customer logos, or unsupported performance claims.",
    "- Production upgrades: create one repo-aware page improvement that can repair broken local links, clean duplicate H1 structure, and add a strong decision-support section.",
    "- Production upgrades must use the site structure summary. Improve the page that matters for the user journey; do not stack random sections onto a page that already has enough content.",
    "- For production upgrades, preserve filepath, pageRole, stylesheetPath, currentHref, and suggested replacement href values exactly. Do not invent scripts, backend APIs, prices, guarantees, or unsupported claims.",
    "- Interactive conversion upgrades: create one useful calculator or planner section for static HTML pages. It must help visitors estimate opportunity or choose a next step.",
    "- For interactive conversion upgrades, preserve filepath, pageRole, and stylesheetPath exactly. The connector will add safe HTML, CSS, and local JavaScript. Do not invent backend APIs, tracking pixels, form submission, prices, guarantees, customer names, or unsupported performance claims.",
    "- Interactive conversion input labels should be short and practical. Recommendations should explain what to do after seeing the estimate.",
    "- Never invent file paths. Use ONLY the filepath/imageSrc values provided below.",
    "- Draft fixes ONLY for the selected fixes in the AGENT FIX PLAN. Do not fill lower-priority gaps that are not in the plan.",
    "- If the current title/description is acceptable, omit that field from the patch.",
    "- Match the brand tone in the user guidance when it is given.",
    "",
    "INPUT — alt-text gaps:",
    JSON.stringify(altInput, null, 2),
    "",
    "INPUT — page-metadata gaps:",
    JSON.stringify(metaInput, null, 2),
    "",
    "INPUT — visible-content opportunities:",
    JSON.stringify(visibleInput, null, 2),
    "",
    "INPUT — existing-copy rewrite opportunities:",
    JSON.stringify(copyRewriteInput, null, 2),
    "",
    "INPUT — CTA rewrite opportunities:",
    JSON.stringify(ctaRewriteInput, null, 2),
    "",
    "INPUT — FAQ section opportunities:",
    JSON.stringify(faqSectionInput, null, 2),
    "",
    "INPUT — visual upgrade opportunities:",
    JSON.stringify(visualUpgradeInput, null, 2),
    "",
    "INPUT — production site upgrade opportunities:",
    JSON.stringify(productionUpgradeInput, null, 2),
    "",
    "INPUT — interactive conversion upgrade opportunities:",
    JSON.stringify(interactiveConversionUpgradeInput, null, 2),
    "",
    "OUTPUT — return JSON of this exact shape:",
    `{
  "altText": [
    { "filepath": "...", "imageSrc": "...", "altText": "..." }
  ],
  "pageMetadata": [
    { "filepath": "...", "title": "...", "description": "..." }
  ],
  "visibleContent": [
    { "filepath": "...", "heading": "...", "body": "...", "bullets": ["...", "..."] }
  ],
  "copyRewrite": [
    { "filepath": "...", "targetId": "copy:h1:0", "tagName": "h1", "currentText": "...", "replacementText": "..." }
  ],
  "ctaRewrite": [
    { "filepath": "...", "targetId": "cta:a:0", "element": "a", "currentText": "...", "replacementText": "..." }
  ],
  "faqSection": [
    {
      "filepath": "...",
      "heading": "Frequently asked questions",
      "faqs": [
        { "question": "...", "answer": "..." },
        { "question": "...", "answer": "..." }
      ]
    }
  ],
  "visualUpgrade": [
    {
      "filepath": "...",
      "stylesheetPath": "styles.css",
      "eyebrow": "Agent-guided growth",
      "heading": "...",
      "body": "...",
      "metrics": [
        { "value": "1", "label": "..." },
        { "value": "3", "label": "..." }
      ],
      "steps": [
        { "title": "...", "body": "..." },
        { "title": "...", "body": "..." }
      ],
      "ctaText": "...",
      "ctaHref": "features.html"
    }
  ],
  "productionUpgrade": [
    {
      "filepath": "...",
      "pageRole": "pricing",
      "stylesheetPath": "styles.css",
      "fixDuplicateH1": { "replacementLead": "..." },
      "linkRepairs": [
        { "currentHref": "missing-page.html", "replacementHref": "features.html" }
      ],
      "section": {
        "eyebrow": "Production-ready workflow",
        "heading": "...",
        "body": "...",
        "highlights": [
          { "title": "...", "body": "..." },
          { "title": "...", "body": "..." }
        ],
        "comparisonRows": [
          { "feature": "...", "starter": "...", "growth": "...", "scale": "..." }
        ],
        "ctaText": "...",
        "ctaHref": "features.html"
      }
    }
  ],
  "interactiveConversionUpgrade": [
    {
      "filepath": "...",
      "pageRole": "home",
      "stylesheetPath": "styles.css",
      "section": {
        "eyebrow": "Interactive growth planner",
        "heading": "...",
        "body": "...",
        "calculatorTitle": "Estimate monthly opportunity",
        "inputLabels": {
          "visitors": "Monthly website visitors",
          "conversionRate": "Current conversion rate (%)",
          "averageValue": "Average lead or signup value"
        },
        "resultLabel": "Estimated monthly opportunity",
        "recommendations": [
          { "title": "...", "body": "..." },
          { "title": "...", "body": "..." }
        ],
        "ctaText": "...",
        "ctaHref": "features.html"
      }
    }
  ]
}`,
  ].join("\n");
}

function formatSiteStructureForPrompt(analysis: RepoStructureAnalysis): string {
  const importantPages = analysis.importantPages.join(", ") || "none";
  const primaryNav = analysis.primaryNav
    .map((link) => `${link.text}->${link.resolvedPath ?? link.href}`)
    .slice(0, 8)
    .join(", ") || "none";
  const orphanPages = analysis.orphanPages.slice(0, 6).join(", ") || "none";
  const pageMap = analysis.pages
    .slice(0, 8)
    .map((page) => {
      const sectionKinds = page.sections.map((section) => section.kind).join("/") || "none";
      return `${page.filepath} (${page.role}, route ${page.routePath}, depth ${page.depth}, inbound ${page.inboundInternalLinks.length}, sections ${sectionKinds})`;
    })
    .join("; ") || "none";

  return [
    `Important pages: ${importantPages}.`,
    `Primary nav: ${primaryNav}.`,
    `Orphan pages: ${orphanPages}.`,
    `Broken local links: ${analysis.brokenLinkCount}.`,
    `Page map: ${pageMap}.`,
  ].join(" ");
}

// Build the "user said this" block. We pull every brief field that has
// content, but avoid echoing the resolved URL back as a copy instruction.
function renderUserHint(
  inputContext: Record<string, string>,
  resolvedUrl: string,
): string {
  const goal = (inputContext.campaignGoal ?? "")
    .replace(resolvedUrl, "")
    .trim();

  const parts: string[] = [];
  if (goal) parts.push(`Goal: ${goal}`);
  if (inputContext.targetAudience) parts.push(`Audience: ${inputContext.targetAudience}`);
  if (inputContext.brandTone) parts.push(`Brand tone: ${inputContext.brandTone}`);
  if (inputContext.mainChannel) parts.push(`Main channel: ${inputContext.mainChannel}`);
  if (inputContext.productName) parts.push(`Product: ${inputContext.productName}`);

  const alreadyRendered = new Set([
    "campaignGoal",
    "targetAudience",
    "brandTone",
    "mainChannel",
    "productName",
    "siteUrl",
  ]);

  for (const [key, value] of Object.entries(inputContext)) {
    if (alreadyRendered.has(key)) continue;
    if (!value.trim()) continue;
    parts.push(`${formatBriefLabel(key)}: ${value}`);
  }

  return parts.join("\n");
}

function formatBriefLabel(key: string): string {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
