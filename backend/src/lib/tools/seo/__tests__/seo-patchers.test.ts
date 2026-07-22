// Sanity tests for the new SEO patchers:
//   - findMissingAltText now handles markdown ![](src) and JSX <Image>
//   - applyAltTextPatch writes alt-text into all three patterns
//   - inspectPageMetadata / applyPageMetadataPatch handle mdx-frontmatter,
//     nextjs-metadata, and html-head
//
// Run with: npx tsx src/lib/tools/seo/__tests__/seo-patchers.test.ts

import {
  analyzeRepoFiles,
  applyAltTextPatch,
  applyCopyRewritePatch,
  applyCtaRewritePatch,
  applyFaqSectionPatch,
  applyInteractiveConversionUpgradePatch,
  applyInteractiveConversionUpgradeStyles,
  applyPageMetadataPatch,
  applyProductionSiteUpgradePatch,
  applyProductionSiteUpgradeStyles,
  applyVisibleContentPatch,
  applyVisualUpgradePatch,
  applyVisualUpgradeStyles,
  findMissingAltText,
  inspectCopyRewriteOpportunities,
  inspectCtaRewriteOpportunities,
  inspectFaqSectionOpportunity,
  inspectVisibleContentOpportunity,
  inspectVisualUpgradeOpportunity,
  inspectPageMetadata,
} from "../../../connectors/github/mdx";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

// ----- alt-text: scanner catches markdown + JSX -----
const mixed = [
  '<img src="/a.svg" />',
  '![](src/b.svg)',
  '![ ](src/c.svg)',
  '![already good](src/d.svg)',
  '<Image src="/e.svg" />',
  '<Image src="/f.svg" alt="ok" />',
  '<Image src="/g.svg" alt={someVar} />',
].join("\n");

const gaps = findMissingAltText(mixed, "content/demo.mdx");
const srcs = gaps.map((g) => g.imageSrc).sort();
assert(srcs.includes("/a.svg"), "scanner catches plain <img>");
assert(srcs.includes("src/b.svg"), "scanner catches markdown ![](src)");
assert(srcs.includes("src/c.svg"), "scanner catches whitespace-only alt");
assert(!srcs.includes("src/d.svg"), "scanner skips markdown with real alt");
assert(srcs.includes("/e.svg"), "scanner catches JSX <Image> with no alt");
assert(!srcs.includes("/f.svg"), "scanner skips JSX <Image> with literal alt");
assert(!srcs.includes("/g.svg"), "scanner skips JSX <Image> with alt={expr}");

// ----- alt-text: patcher writes into all three -----
const before = '<img src="/a.svg" />\n![](src/b.svg)\n<Image src="/e.svg" />';
let after = applyAltTextPatch(before, {
  filepath: "x.mdx",
  imageSrc: "/a.svg",
  altText: "A diagram of the system",
});
after = applyAltTextPatch(after, {
  filepath: "x.mdx",
  imageSrc: "src/b.svg",
  altText: "A second helpful image",
});
after = applyAltTextPatch(after, {
  filepath: "x.mdx",
  imageSrc: "/e.svg",
  altText: "Next.js Image example",
});
assert(after.includes('<img src="/a.svg" alt="A diagram of the system"'), "patches <img>");
assert(after.includes("![A second helpful image](src/b.svg)"), "patches markdown");
assert(after.includes('<Image src="/e.svg" alt="Next.js Image example"'), "patches JSX <Image>");

// ----- metadata: mdx-frontmatter -----
const mdx = '---\ntitle: ""\n---\n# body\n';
const mdxGap = inspectPageMetadata(mdx, "content/post.mdx");
assert(mdxGap?.style === "mdx-frontmatter", "detects mdx-frontmatter style");
assert(mdxGap?.issues.includes("missing-title"), "flags missing title in frontmatter");

const patched = applyPageMetadataPatch(mdx, {
  filepath: "content/post.mdx",
  style: "mdx-frontmatter",
  title: "How to ship reliable SEO audits in MarketPilot",
  description:
    "A short, repeatable workflow for shipping reliable SEO audit fixes via PRs every week without manual review.",
});
assert(patched.includes('title: "How to ship reliable SEO audits in MarketPilot"'), "writes title to frontmatter");
assert(patched.includes('description: "A short, repeatable workflow'), "writes description to frontmatter");

// ----- metadata: html-head -----
const html = "<!doctype html><html><head><title></title></head><body></body></html>";
const htmlGap = inspectPageMetadata(html, "pricing.html");
assert(htmlGap?.style === "html-head", "detects html-head style");
assert(htmlGap?.issues.includes("missing-description"), "flags missing description in html-head");

const htmlPatched = applyPageMetadataPatch(html, {
  filepath: "pricing.html",
  style: "html-head",
  title: "MarketPilot AI pricing — plans for SaaS teams of every size",
  description:
    "Compare MarketPilot AI plans for autonomous SEO, copy, and ads. Pick the right tier and start your free trial today.",
});
assert(htmlPatched.includes("<title>MarketPilot AI pricing"), "writes <title> tag");
assert(htmlPatched.includes('name="description"'), "writes meta description");

// ----- metadata: nextjs-metadata -----
const tsx = 'export const metadata = { title: "" };\nexport default function P(){return null;}';
const tsxGap = inspectPageMetadata(tsx, "app/page.tsx");
assert(tsxGap?.style === "nextjs-metadata", "detects nextjs-metadata style");
assert(tsxGap?.issues.includes("missing-title"), "flags missing title in nextjs metadata");

const tsxPatched = applyPageMetadataPatch(tsx, {
  filepath: "app/page.tsx",
  style: "nextjs-metadata",
  title: "MarketPilot home — autonomous marketing agents",
  description:
    "Run SEO audits, draft copy, and propose paid-ads actions on autopilot. Try MarketPilot AI free for 14 days.",
});
assert(tsxPatched.includes('title: "MarketPilot home'), "writes title into nextjs metadata");
assert(tsxPatched.includes('description: "Run SEO audits'), "writes description into nextjs metadata");

// ----- visible content: html-main -----
const contentHtml = [
  "<!doctype html>",
  "<html><body>",
  "<main>",
  "<h1>LaunchPilot AI</h1>",
  "<p>Plan SaaS launches faster.</p>",
  "</main>",
  "</body></html>",
].join("\n");
const visibleGap = inspectVisibleContentOpportunity(contentHtml, "index.html");
assert(visibleGap === undefined, "does not create standalone visible-content opportunity in html main");
const readmeGap = inspectVisibleContentOpportunity(contentHtml, "README.md");
assert(readmeGap === undefined, "does not treat README.md as a visible website page");

const contentHtmlPatched = applyVisibleContentPatch(contentHtml, {
  filepath: "index.html",
  style: "html-main",
  heading: "What teams get after setup",
  body: "LaunchPilot helps teams turn launch planning into clear weekly execution.",
  bullets: ["Prioritized campaign tasks", "Simple launch milestones"],
});
assert(contentHtmlPatched.includes('<section class="content-improvement">'), "adds visible html section");
assert(contentHtmlPatched.includes("<h2>What teams get after setup</h2>"), "writes visible html heading");
assert(contentHtmlPatched.indexOf("</section>") < contentHtmlPatched.indexOf("</main>"), "inserts section before closing main");

// ----- visible content: mdx-section -----
const contentMdx = "---\ntitle: Launch checklist\n---\n\n# Launch checklist\n\nBody.";
const visibleMdxGap = inspectVisibleContentOpportunity(contentMdx, "content/blog/launch-checklist.mdx");
assert(visibleMdxGap?.style === "mdx-section", "detects visible-content opportunity in mdx");
const contentMdxPatched = applyVisibleContentPatch(contentMdx, {
  filepath: "content/blog/launch-checklist.mdx",
  style: "mdx-section",
  heading: "Before you publish",
  body: "Check the launch basics before your announcement goes live.",
  bullets: ["Confirm the target audience", "Review the primary CTA"],
});
assert(contentMdxPatched.includes("## Before you publish"), "adds visible mdx heading");
assert(contentMdxPatched.includes("- Confirm the target audience"), "adds visible mdx bullets");

// ----- existing copy rewrites: h1 + intro paragraph -----
const rewriteHtml = [
  "<!doctype html>",
  "<html><body>",
  "<nav><p>Do not rewrite nav text</p></nav>",
  "<main>",
  "<h1>LaunchPilot AI</h1>",
  "<p>Plan SaaS launches faster with a simple workspace for campaigns.</p>",
  "<button>Start free</button>",
  '<section class="content-improvement"><h2>Already generated</h2><p>Leave this alone.</p></section>',
  "</main>",
  "</body></html>",
].join("\n");
const rewriteGaps = inspectCopyRewriteOpportunities(rewriteHtml, "index.html");
assert(rewriteGaps.some((g) => g.tagName === "h1"), "finds homepage h1 rewrite target");
assert(rewriteGaps.some((g) => g.tagName === "p"), "finds homepage intro paragraph rewrite target");
assert(!rewriteGaps.some((g) => g.currentText.includes("Already generated")), "skips generated content sections");

const h1Gap = rewriteGaps.find((g) => g.tagName === "h1");
assert(h1Gap, "has h1 gap to patch");
const rewritePatched = applyCopyRewritePatch(rewriteHtml, {
  filepath: "index.html",
  style: "html-text",
  targetId: h1Gap!.targetId,
  tagName: "h1",
  currentText: h1Gap!.currentText,
  replacementText: "Launch SaaS Campaigns Faster With AI Agents",
});
assert(rewritePatched.includes("<h1>Launch SaaS Campaigns Faster With AI Agents</h1>"), "rewrites existing h1 text");
assert(rewritePatched.includes("<button>Start free</button>"), "does not rewrite button text");

const unsafeRewrite = applyCopyRewritePatch(rewriteHtml, {
  filepath: "index.html",
  style: "html-text",
  targetId: h1Gap!.targetId,
  tagName: "h1",
  currentText: h1Gap!.currentText,
  replacementText: "Launch SaaS Campaigns for $1 Today",
});
assert(unsafeRewrite === rewriteHtml, "rejects unsafe price-like replacement copy");

// ----- CTA rewrites: safe button/link text only inside main -----
const ctaHtml = [
  "<!doctype html>",
  "<html><body>",
  "<nav><a href='/pricing'>Pricing</a></nav>",
  "<main>",
  "<a href='/signup' class='primary'>Start free</a>",
  "<button>Learn more</button>",
  "</main>",
  "</body></html>",
].join("\n");
const ctaGaps = inspectCtaRewriteOpportunities(ctaHtml, "index.html");
assert(ctaGaps.length === 2, "finds safe CTA rewrite targets in main");
assert(!ctaGaps.some((g) => g.currentText === "Pricing"), "skips nav CTA text outside main");

const firstCta = ctaGaps[0];
assert(firstCta, "has CTA gap to patch");
const ctaPatched = applyCtaRewritePatch(ctaHtml, {
  filepath: "index.html",
  style: "html-cta",
  targetId: firstCta!.targetId,
  element: firstCta!.element,
  currentText: firstCta!.currentText,
  replacementText: "Start Your SEO Audit",
});
assert(ctaPatched.includes(">Start Your SEO Audit</a>"), "rewrites CTA text and preserves the element");
assert(ctaPatched.includes("<nav><a href='/pricing'>Pricing</a></nav>"), "does not change nav links");

const unsafeCta = applyCtaRewritePatch(ctaHtml, {
  filepath: "index.html",
  style: "html-cta",
  targetId: firstCta!.targetId,
  element: firstCta!.element,
  currentText: firstCta!.currentText,
  replacementText: "Start for $1",
});
assert(unsafeCta === ctaHtml, "rejects unsafe price-like CTA copy");

// ----- FAQ sections: html-main and mdx-section -----
const faqGap = inspectFaqSectionOpportunity(contentHtml, "index.html");
assert(faqGap === undefined, "does not create standalone FAQ opportunity in html main");
const faqPatched = applyFaqSectionPatch(contentHtml, {
  filepath: "index.html",
  style: "html-main",
  heading: "Frequently asked questions",
  faqs: [
    {
      question: "Can teams review changes first?",
      answer: "Yes. The agent prepares the change and waits for approval.",
    },
    {
      question: "Can changes be rolled back?",
      answer: "Yes. Each write keeps a rollback path.",
    },
  ],
});
assert(faqPatched.includes('class="content-improvement faq-improvement"'), "adds FAQ html section");
assert(faqPatched.includes("<h3>Can teams review changes first?</h3>"), "writes FAQ question");

const faqMdxGap = inspectFaqSectionOpportunity(contentMdx, "content/pages/home.mdx");
assert(faqMdxGap?.style === "mdx-section", "detects FAQ opportunity in mdx");
const faqMdxPatched = applyFaqSectionPatch(contentMdx, {
  filepath: "content/pages/home.mdx",
  style: "mdx-section",
  heading: "Frequently asked questions",
  faqs: [
    {
      question: "Who is this for?",
      answer: "Early-stage SaaS teams that want clearer marketing execution.",
    },
  ],
});
assert(faqMdxPatched.includes("## Frequently asked questions"), "adds FAQ mdx heading");
assert(faqMdxPatched.includes("### Who is this for?"), "adds FAQ mdx question");

// ----- visual upgrades: html structure plus stylesheet append -----
const visualHtml = [
  "<!doctype html>",
  "<html>",
  "<head><link rel=\"stylesheet\" href=\"styles.css\" /></head>",
  "<body>",
  "<main>",
  "<h1>LaunchPilot AI</h1>",
  "<p>Plan SaaS launches faster.</p>",
  "</main>",
  "</body>",
  "</html>",
].join("\n");
const visualGap = inspectVisualUpgradeOpportunity(visualHtml, "index.html");
assert(visualGap?.style === "html-main-css", "detects visual upgrade opportunity with stylesheet");
assert(visualGap?.stylesheetPath === "styles.css", "resolves root stylesheet path");

const visualPatched = applyVisualUpgradePatch(contentHtml, {
  filepath: "index.html",
  style: "html-main-css",
  stylesheetPath: "styles.css",
  eyebrow: "Agent-guided growth",
  heading: "See the workflow before it ships",
  body: "Review the agent plan, approve the pull request, and keep every change traceable.",
  metrics: [
    { value: "1", label: "approval workspace" },
    { value: "3", label: "steps from audit to PR" },
  ],
  steps: [
    { title: "Audit", body: "Find the most important gaps first." },
    { title: "Approve", body: "Review before GitHub is touched." },
  ],
  ctaText: "Explore the Workflow",
  ctaHref: "features.html",
});
assert(visualPatched.includes('class="agent-visual-upgrade"'), "adds visual upgrade html section");
assert(visualPatched.includes("See the workflow before it ships"), "writes visual upgrade heading");

const cssPatched = applyVisualUpgradeStyles(":root { --brand: #3157d5; }\n");
assert(cssPatched.includes("MarketPilot agent visual upgrade"), "adds visual upgrade css marker");
assert(cssPatched.includes(".agent-visual-upgrade"), "adds visual upgrade css class");

// ----- repo analysis + production site upgrades -----
const repoFiles = [
  "index.html",
  "pricing.html",
  "features.html",
  "styles.css",
];
const repoContents = new Map<string, string>([
  [
    "index.html",
    [
      "<!doctype html>",
      "<html>",
      "<head><meta name=\"viewport\" content=\"width=device-width\"><link rel=\"stylesheet\" href=\"styles.css\"></head>",
      "<body>",
      "<header><a href=\"features.html\">Features</a><a href=\"missing-page.html\">Case studies</a></header>",
      "<main><h1>LaunchPilot AI</h1><p>Plan launches.</p><section class=\"content-improvement\"><h2>Old generated block</h2><p>Remove this unstyled section.</p></section></main>",
      "</body></html>",
    ].join("\n"),
  ],
  [
    "pricing.html",
    [
      "<!doctype html>",
      "<html>",
      "<head><link rel=\"stylesheet\" href=\"styles.css\"></head>",
      "<body>",
      "<main>",
      "<h1>Flexible Plans</h1>",
      "<h1>Pick a plan</h1>",
      "<section class=\"pricing-grid\"><article><h2>Starter</h2><p>$19/mo</p></article></section>",
      "</main>",
      "</body></html>",
    ].join("\n"),
  ],
  ["features.html", "<html><head><link rel=\"stylesheet\" href=\"styles.css\"></head><body><main><h1>Features</h1></main></body></html>"],
  ["styles.css", ":root { --brand: #3157d5; --line: #dce2ea; --soft: #f5f7fb; }"],
]);
const repoAnalysis = analyzeRepoFiles(repoFiles, repoContents);
assert(repoAnalysis.projectKind === "static-html", "repo analysis classifies static HTML repo");
assert(
  repoAnalysis.issues.some((issue) => issue.code === "broken-local-link"),
  "repo analysis detects broken local links",
);
assert(
  repoAnalysis.issues.some((issue) => issue.code === "duplicate-h1"),
  "repo analysis detects duplicate H1s",
);
assert(
  repoAnalysis.issues.some((issue) => issue.code === "plain-generated-section"),
  "repo analysis detects plain generated sections",
);
assert(repoAnalysis.primaryNav.some((link) => link.text === "Features"), "repo analysis detects primary nav links");
assert(repoAnalysis.brokenLinkCount === 1, "repo analysis counts broken local links");
assert(repoAnalysis.importantPages.includes("index.html"), "repo analysis keeps the homepage as important");
assert(
  repoAnalysis.pages.some((page) => page.filepath === "features.html" && page.inboundInternalLinks.includes("index.html")),
  "repo analysis tracks inbound internal links",
);
assert(
  repoAnalysis.pages.some((page) => page.filepath === "index.html" && page.sections.some((section) => section.kind === "generated")),
  "repo analysis summarizes generated page sections",
);

const productionPatched = applyProductionSiteUpgradePatch(repoContents.get("pricing.html") ?? "", {
  filepath: "pricing.html",
  style: "static-html-page-css",
  pageRole: "pricing",
  stylesheetPath: "styles.css",
  fixDuplicateH1: {
    replacementLead: "Compare plans by workflow maturity before choosing your workspace.",
  },
  linkRepairs: [],
  section: {
    eyebrow: "Production-ready workflow",
    heading: "Choose the plan with clearer decision support",
    body: "Compare launch volume, approval depth, and optimization needs before choosing a plan.",
    highlights: [
      { title: "Clearer fit", body: "Each plan is framed around the work it supports." },
      { title: "Better review", body: "Teams can see how approval needs change by stage." },
    ],
    comparisonRows: [
      {
        feature: "Best fit",
        starter: "One launch",
        growth: "Multiple campaigns",
        scale: "Team-wide operations",
      },
    ],
    ctaText: "Compare Plan Fit",
    ctaHref: "features.html",
  },
});
assert(productionPatched.includes('class="page-lede"'), "production upgrade cleans duplicate H1 structure");
assert(productionPatched.includes('class="production-upgrade"'), "production upgrade adds structured HTML section");
assert(productionPatched.includes('class="production-comparison"'), "production upgrade adds comparison table");

const linkRepairPatched = applyProductionSiteUpgradePatch(repoContents.get("index.html") ?? "", {
  filepath: "index.html",
  style: "static-html-page-css",
  pageRole: "home",
  stylesheetPath: "styles.css",
  linkRepairs: [{ currentHref: "missing-page.html", replacementHref: "features.html" }],
  section: {
    eyebrow: "Production-ready workflow",
    heading: "Move from audit to approved update",
    body: "Repair broken paths and give visitors a clearer route through the site.",
    highlights: [
      { title: "Fixed navigation", body: "Broken links are replaced with live pages." },
      { title: "Clear next step", body: "Visitors get a better path to product details." },
    ],
    ctaText: "Explore Features",
    ctaHref: "features.html",
  },
});
assert(linkRepairPatched.includes('href="features.html"'), "production upgrade repairs broken local links");
assert(!linkRepairPatched.includes("content-improvement"), "production upgrade removes old plain generated sections");

const productionCss = applyProductionSiteUpgradeStyles(repoContents.get("styles.css") ?? "");
assert(productionCss.includes("MarketPilot production site upgrade"), "adds production upgrade css marker");
assert(productionCss.includes(".production-upgrade"), "adds production upgrade css class");

const interactivePatched = applyInteractiveConversionUpgradePatch(repoContents.get("index.html") ?? "", {
  filepath: "index.html",
  style: "static-html-interactive-css",
  pageRole: "home",
  stylesheetPath: "styles.css",
  section: {
    eyebrow: "Interactive growth planner",
    heading: "Calculate the SEO opportunity before the next update",
    body: "Use a simple estimate to decide which page improvement deserves review first.",
    calculatorTitle: "Estimate monthly opportunity",
    inputLabels: {
      visitors: "Monthly website visitors",
      conversionRate: "Current conversion rate (%)",
      averageValue: "Average lead or signup value",
    },
    resultLabel: "Estimated monthly opportunity",
    recommendations: [
      { title: "Audit the page", body: "Start with the page closest to conversion." },
      { title: "Review the PR", body: "Compare the change before it lands." },
    ],
    ctaText: "Explore the Workflow",
    ctaHref: "features.html",
  },
});
assert(interactivePatched.includes('class="interactive-conversion"'), "adds interactive conversion section");
assert(interactivePatched.includes("data-conversion-calculator"), "adds local calculator behavior");
assert(interactivePatched.includes("Calculate the SEO opportunity"), "writes interactive section heading");
assert(!interactivePatched.includes("content-improvement"), "interactive upgrade removes old plain generated sections");

const interactiveCss = applyInteractiveConversionUpgradeStyles(repoContents.get("styles.css") ?? "");
assert(interactiveCss.includes("MarketPilot interactive conversion upgrade"), "adds interactive conversion css marker");
assert(interactiveCss.includes(".interactive-conversion"), "adds interactive conversion css class");

console.log("\nAll SEO patcher tests passed.");
