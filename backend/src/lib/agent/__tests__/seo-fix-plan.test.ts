// Sanity tests for the SEO fix prioritizer.
//
// Run with: npx tsx src/lib/agent/__tests__/seo-fix-plan.test.ts

import {
  buildSeoFixPlan,
  draftFallbackCopy,
  evaluateSeoChangeNecessity,
  runSeoFixQualityGate,
} from "../seo-orchestrator";
import type {
  AltTextGap,
  CopyRewriteGap,
  CtaRewriteGap,
  FaqSectionGap,
  InteractiveConversionUpgradeGap,
  PageMetadataGap,
  ProductionSiteUpgradeGap,
  RepoStructureAnalysis,
  VisibleContentGap,
  VisualUpgradeGap,
} from "../../connectors/types";
import type { Finding } from "../../tools/seo/audit-checks";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

const findings: Finding[] = [
  {
    id: "thin-content",
    severity: "warning",
    message: "Body has only 180 words.",
  },
  {
    id: "images-missing-alt",
    severity: "warning",
    message: "2 image(s) are missing alt text.",
  },
  {
    id: "missing-meta-description",
    severity: "critical",
    message: "Page has no meta description.",
  },
];

const copyRewriteGaps: CopyRewriteGap[] = [
  {
    filepath: "index.html",
    style: "html-text",
    targetId: "copy:h1:0",
    tagName: "h1",
    currentText: "LaunchPilot AI",
    reason: "Homepage H1 is brand-only and does not explain the product.",
  },
  {
    filepath: "pricing.html",
    style: "html-text",
    targetId: "copy:p:0",
    tagName: "p",
    currentText: "Choose your plan.",
    reason: "Pricing intro is too vague for comparison visitors.",
  },
];

const visibleContentGaps: VisibleContentGap[] = [
  {
    filepath: "index.html",
    style: "html-main",
    reason: "No FAQ or decision-support section was found in the visible page body.",
    existingHeadings: ["LaunchPilot AI"],
  },
];

const ctaRewriteGaps: CtaRewriteGap[] = [
  {
    filepath: "index.html",
    style: "html-cta",
    targetId: "cta:a:0",
    element: "a",
    currentText: "Start free",
    reason: "CTA can be more specific about what happens after the click.",
  },
];

const faqSectionGaps: FaqSectionGap[] = [
  {
    filepath: "index.html",
    style: "html-main",
    reason: "No FAQ section was found in the visible page body.",
    existingHeadings: ["LaunchPilot AI"],
  },
];

const visualUpgradeGaps: VisualUpgradeGap[] = [
  {
    filepath: "index.html",
    style: "html-main-css",
    stylesheetPath: "styles.css",
    reason:
      "Page has basic content but no polished conversion-focused visual section with metrics, workflow, and CTA.",
    existingHeadings: ["LaunchPilot AI"],
  },
];

const productionUpgradeGaps: ProductionSiteUpgradeGap[] = [
  {
    filepath: "pricing.html",
    style: "static-html-page-css",
    pageRole: "pricing",
    stylesheetPath: "styles.css",
    reason: "Pricing page needs stronger buyer decision support, clearer hierarchy, and comparison content.",
    issues: ["duplicate-h1", "weak-pricing-structure"],
    existingHeadings: ["Flexible Plans", "Pick a plan"],
    brokenLocalLinks: [],
  },
];

const interactiveConversionUpgradeGaps: InteractiveConversionUpgradeGap[] = [
  {
    filepath: "index.html",
    style: "static-html-interactive-css",
    pageRole: "home",
    stylesheetPath: "styles.css",
    reason: "Homepage can be improved with an interactive calculator that turns interest into a clearer next step.",
    existingHeadings: ["LaunchPilot AI"],
    ctaTexts: ["Start free", "Learn more"],
  },
];

const repoAnalysis: RepoStructureAnalysis = {
  projectKind: "static-html",
  sourceFiles: ["index.html", "pricing.html", "styles.css"],
  pages: [],
  stylesheets: ["styles.css"],
  assets: [],
  navigationLinks: [],
  primaryNav: [],
  footerNav: [],
  orphanPages: [],
  importantPages: ["index.html", "pricing.html"],
  brokenLinkCount: 0,
  issues: [
    {
      severity: "warning",
      code: "weak-pricing-structure",
      filepath: "pricing.html",
      message: "pricing.html has pricing cards but no comparison table.",
    },
  ],
  recommendedFocus: "Improve the pricing page structure and buyer decision support.",
};

const metadataGaps: PageMetadataGap[] = [
  {
    filepath: "index.html",
    style: "html-head",
    currentTitle: "LaunchPilot AI",
    currentDescription: "",
    issues: ["missing-description"],
  },
];

const altGaps: AltTextGap[] = [
  {
    filepath: "index.html",
    imageSrc: "assets/product-dashboard.svg",
    line: 12,
  },
];

const plan = buildSeoFixPlan({
  siteUrl: "http://localhost:5177/",
  healthScore: 72,
  repoAnalysis,
  findings,
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

assert(plan.items.length > 0, "creates at least one plan item");
assert(
  plan.items[0]?.kind === "interactiveConversionUpgrade" && plan.items[0]?.filepath === "index.html",
  "ranks interactive conversion upgrades before smaller copy fixes",
);
assert(
  plan.items.some((item) => item.kind === "productionUpgrade"),
  "keeps repo-aware production upgrades in the plan",
);
assert(
  plan.items.some((item) => item.kind === "copyRewrite"),
  "keeps visible copy fixes in the plan",
);
assert(
  plan.items.some((item) => item.kind === "pageMetadata"),
  "keeps metadata fixes in the plan",
);
assert(
  plan.items.some((item) => item.kind === "ctaRewrite"),
  "keeps CTA rewrite fixes in the plan",
);
assert(
  plan.items.some((item) => item.kind === "visualUpgrade"),
  "keeps visual upgrade fixes in the plan",
);
assert(
  plan.items.some((item) => item.kind === "faqSection"),
  "keeps FAQ section fixes in the plan",
);
assert(
  plan.items.some((item) => item.kind === "altText"),
  "keeps alt-text fixes in the plan",
);
assert(
  plan.primaryFocus.includes("working conversion experience"),
  "explains the interactive primary focus in plain language",
);
const neededGate = evaluateSeoChangeNecessity({
  plan,
  findings,
  repoAnalysis,
});
assert(neededGate.status === "needed", "necessity gate allows PRs for material SEO issues");

const fallback = draftFallbackCopy({
  siteUrl: "http://localhost:5177/",
  inputContext: {
    productName: "LaunchPilot AI",
    targetAudience: "early-stage SaaS teams",
    mainChannel: "SEO",
  },
  altGaps,
  metadataGaps,
  visibleContentGaps,
  copyRewriteGaps,
  ctaRewriteGaps,
  faqSectionGaps,
  visualUpgradeGaps,
  productionUpgradeGaps,
  interactiveConversionUpgradeGaps,
  repoAnalysis,
});

assert(fallback.copyRewrite.length === 2, "fallback drafts copy rewrites");
assert(
  fallback.copyRewrite[0]?.replacementText.includes("LaunchPilot AI"),
  "fallback copy uses product context",
);
assert(fallback.pageMetadata.length === 1, "fallback drafts page metadata");
assert(
  Boolean(fallback.pageMetadata[0]?.description?.includes("early-stage SaaS teams")),
  "fallback metadata uses audience context",
);
assert(fallback.altText.length === 1, "fallback drafts alt text");
assert(
  fallback.altText[0]?.altText.includes("product dashboard"),
  "fallback alt text describes the image filename",
);
assert(fallback.visibleContent.length === 1, "fallback drafts visible content");
assert(
  (fallback.visibleContent[0]?.bullets ?? []).length >= 2,
  "fallback visible content includes useful bullets",
);
assert(fallback.ctaRewrite.length === 1, "fallback drafts CTA rewrites");
assert(
  fallback.ctaRewrite[0]?.replacementText.includes("SEO"),
  "fallback CTA copy uses channel context",
);
assert(fallback.faqSection.length === 1, "fallback drafts FAQ sections");
assert(
  (fallback.faqSection[0]?.faqs ?? []).length >= 2,
  "fallback FAQ section includes useful questions",
);
assert(fallback.visualUpgrade.length === 1, "fallback drafts visual upgrades");
assert(
  fallback.visualUpgrade[0]?.stylesheetPath === "styles.css",
  "fallback visual upgrade keeps stylesheet path",
);
assert(
  (fallback.visualUpgrade[0]?.steps ?? []).length >= 2,
  "fallback visual upgrade includes workflow steps",
);
assert(fallback.productionUpgrade.length === 1, "fallback drafts production upgrades");
assert(
  fallback.productionUpgrade[0]?.section.comparisonRows?.length === 3,
  "fallback production upgrade includes pricing comparison rows",
);
assert(
  fallback.productionUpgrade[0]?.stylesheetPath === "styles.css",
  "fallback production upgrade keeps stylesheet path",
);
assert(fallback.interactiveConversionUpgrade.length === 1, "fallback drafts interactive conversion upgrades");
assert(
  fallback.interactiveConversionUpgrade[0]?.section.calculatorTitle.includes("Estimate"),
  "fallback interactive upgrade includes calculator copy",
);
assert(
  fallback.interactiveConversionUpgrade[0]?.stylesheetPath === "styles.css",
  "fallback interactive upgrade keeps stylesheet path",
);

const passingQualityGate = runSeoFixQualityGate({
  plan,
  draftSource: "gemini",
  altText: fallback.altText,
  pageMetadata: fallback.pageMetadata.map((patch) => ({
    ...patch,
    style: "html-head",
  })),
  visibleContent: [],
  copyRewrite: fallback.copyRewrite.map((patch) => ({
    ...patch,
    style: "html-text",
  })),
  ctaRewrite: fallback.ctaRewrite.map((patch) => ({
    ...patch,
    style: "html-cta",
  })),
  faqSection: [],
  visualUpgrade: fallback.visualUpgrade.map((patch) => ({
    ...patch,
    style: "html-main-css",
  })),
  productionUpgrade: fallback.productionUpgrade.map((patch) => ({
    ...patch,
    style: "static-html-page-css",
  })),
  interactiveConversionUpgrade: fallback.interactiveConversionUpgrade.map((patch) => ({
    ...patch,
    style: "static-html-interactive-css",
  })),
});
assert(passingQualityGate.status === "passed", "quality gate passes useful generated fixes");
assert(passingQualityGate.score >= 70, "quality gate gives passing fixes a safe score");

const blockedQualityGate = runSeoFixQualityGate({
  plan,
  draftSource: "gemini",
  altText: [],
  pageMetadata: [],
  visibleContent: [],
  copyRewrite: [],
  ctaRewrite: [],
  faqSection: [],
  visualUpgrade: [],
  productionUpgrade: [],
  interactiveConversionUpgrade: [
    {
      filepath: "index.html",
      style: "static-html-interactive-css",
      pageRole: "home",
      stylesheetPath: "styles.css",
      section: {
        eyebrow: "Placeholder",
        heading: "Placeholder",
        body: "Placeholder",
        calculatorTitle: "Placeholder",
        inputLabels: {
          visitors: "Metric",
          conversionRate: "Metric",
          averageValue: "Metric",
        },
        resultLabel: "Result",
        recommendations: [
          {
            title: "Todo",
            body: "Insert copy",
          },
        ],
        ctaText: "Learn more",
        ctaHref: "#",
      },
    },
  ],
});
assert(blockedQualityGate.status === "blocked", "quality gate blocks weak placeholder fixes");
assert(
  blockedQualityGate.checks.some((check) => check.status === "fail"),
  "blocked quality gate records failed checks",
);

const standaloneHtmlBlockGate = runSeoFixQualityGate({
  plan,
  draftSource: "gemini",
  altText: [],
  pageMetadata: [],
  visibleContent: [
    {
      filepath: "index.html",
      style: "html-main",
      heading: "Random extra section",
      body: "This kind of bare HTML block should not be allowed on a production page.",
      bullets: ["It looks pasted in", "It has no designed layout"],
    },
  ],
  copyRewrite: [],
  ctaRewrite: [],
  faqSection: [],
  visualUpgrade: [],
  productionUpgrade: [],
  interactiveConversionUpgrade: [],
});
assert(
  standaloneHtmlBlockGate.status === "blocked",
  "quality gate blocks standalone HTML content blocks",
);

const healthyNiceToHavePlan = buildSeoFixPlan({
  siteUrl: "http://localhost:5177/",
  healthScore: 99,
  repoAnalysis: {
    ...repoAnalysis,
    issues: [
      {
        severity: "info",
        code: "basic-static-layout",
        filepath: "index.html",
        message: "Page layout is basic but functional.",
      },
    ],
  },
  findings: [
    {
      id: "missing-schema",
      severity: "info",
      message: "Page has no JSON-LD structured data.",
    },
  ],
  altGaps: [],
  metadataGaps: [],
  visibleContentGaps: [],
  copyRewriteGaps: [],
  ctaRewriteGaps: [],
  faqSectionGaps: [],
  visualUpgradeGaps,
  productionUpgradeGaps: [],
  interactiveConversionUpgradeGaps,
});
const notNeededGate = evaluateSeoChangeNecessity({
  plan: healthyNiceToHavePlan,
  findings: [
    {
      id: "missing-schema",
      severity: "info",
      message: "Page has no JSON-LD structured data.",
    },
  ],
  repoAnalysis: healthyNiceToHavePlan.repoAnalysis,
});
assert(notNeededGate.status === "not_needed", "necessity gate blocks nice-to-have PRs on healthy audits");

const infoOnlyLowScorePlan = buildSeoFixPlan({
  siteUrl: "http://localhost:5177/",
  healthScore: 89,
  repoAnalysis: {
    ...repoAnalysis,
    issues: [],
  },
  findings: [
    {
      id: "missing-schema",
      severity: "info",
      message: "Page has no JSON-LD structured data.",
    },
  ],
  altGaps: [],
  metadataGaps: [],
  visibleContentGaps: [],
  copyRewriteGaps: [],
  ctaRewriteGaps: [],
  faqSectionGaps: [],
  visualUpgradeGaps,
  productionUpgradeGaps: [],
  interactiveConversionUpgradeGaps,
});
const infoOnlyLowScoreGate = evaluateSeoChangeNecessity({
  plan: infoOnlyLowScorePlan,
  findings: [
    {
      id: "missing-schema",
      severity: "info",
      message: "Page has no JSON-LD structured data.",
    },
  ],
  repoAnalysis: infoOnlyLowScorePlan.repoAnalysis,
});
assert(
  infoOnlyLowScoreGate.status === "not_needed",
  "necessity gate blocks PRs when a lower score only comes from informational issues",
);

const repoIssuePlan = buildSeoFixPlan({
  siteUrl: "http://localhost:5177/pricing.html",
  healthScore: 96,
  repoAnalysis,
  findings: [],
  altGaps: [],
  metadataGaps: [],
  visibleContentGaps: [],
  copyRewriteGaps: [],
  ctaRewriteGaps: [],
  faqSectionGaps: [],
  visualUpgradeGaps: [],
  productionUpgradeGaps,
  interactiveConversionUpgradeGaps: [],
});
const repoNeededGate = evaluateSeoChangeNecessity({
  plan: repoIssuePlan,
  findings: [],
  repoAnalysis,
});
assert(repoNeededGate.status === "needed", "necessity gate allows PRs for material repo issues");

console.log("\nSEO fix plan tests passed.");
