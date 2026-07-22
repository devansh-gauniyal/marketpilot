// Connector base types. Every connector implementation must satisfy one of
// the specific connector interfaces below.
//
// Framework rule §5.5: "Connectors declare capabilities. Tools check
// capabilities before attempting writes." Tools never assume a connector can
// do something — they ask via `capabilities.canWriteX`.

export type SiteCapabilities = {
  canCrawl: boolean;
  canReadCompetitor: boolean; // structured competitor-research read (different shape than canCrawl)
  canScanSource: boolean;    // read source files for repo-backed site issues
  canAnalyzeRepoStructure: boolean; // inspect framework/files/pages before planning
  canWriteMeta: boolean;
  canWriteCopy: boolean;
  canPublishPosts: boolean;
  canFixAltText: boolean;     // Step 5 — first real write capability
  canFixPageMetadata: boolean; // post-Step-7 — title/description fixes in source
  canImproveVisibleContent: boolean; // visible body-copy improvements via PR
  canRewriteVisibleCopy: boolean; // safe edits to existing visible text
  canImproveCtas: boolean; // safe edits to visible CTA link/button text
  canAddFaqSections: boolean; // safe FAQ additions in visible page body
  canApplyVisualUpgrades: boolean; // structured HTML + CSS improvements
  canApplyProductionSiteUpgrades: boolean; // repo-aware HTML/CSS/functionality changes
  canApplyInteractiveConversionUpgrades: boolean; // safe HTML/CSS/JS conversion tools
  writesViaPR: boolean;
};

// One image whose alt-text the agent wants to fix.
export type AltTextPatch = {
  filepath: string;   // e.g. "content/blog/launch.mdx"
  imageSrc: string;   // identifies which <img> to update (matches src=)
  altText: string;    // the new alt text
};

export type AltTextGap = {
  filepath: string;
  imageSrc: string;
  line: number;
};

// What a source file's page metadata currently looks like, plus which style of
// metadata block it uses so the patcher knows how to edit it.
export type PageMetadataGap = {
  filepath: string;
  // How metadata is declared in this file. Drives which regex the patcher uses.
  //   "mdx-frontmatter": leading --- ... --- YAML block at top of an .md/.mdx
  //   "nextjs-metadata": `export const metadata = { ... }` in a .ts/.tsx
  //   "html-head":       <title> / <meta name="description"> inside <head>
  style: "mdx-frontmatter" | "nextjs-metadata" | "html-head";
  currentTitle?: string;
  currentDescription?: string;
  // What's wrong, so the LLM/orchestrator knows which field to draft. May
  // contain "missing-title", "missing-description", "title-length",
  // "description-length".
  issues: string[];
};

// One file's title/description to update. Either field optional so the patcher
// can fix just title, just description, or both. `style` mirrors the gap.
export type PageMetadataPatch = {
  filepath: string;
  style: "mdx-frontmatter" | "nextjs-metadata" | "html-head";
  title?: string;
  description?: string;
};

// A source page where the agent can safely add visible, helpful content.
// This is intentionally small-scope: add a section, don't rewrite the page.
export type VisibleContentGap = {
  filepath: string;
  style: "html-main" | "mdx-section";
  reason: string;
  existingHeadings: string[];
};

// One visible content section to add to a page.
export type VisibleContentPatch = {
  filepath: string;
  style: "html-main" | "mdx-section";
  heading: string;
  body: string;
  bullets?: string[];
};

export type CopyRewriteGap = {
  filepath: string;
  style: "html-text";
  targetId: string;
  tagName: "h1" | "h2" | "p";
  currentText: string;
  reason: string;
};

export type CopyRewritePatch = {
  filepath: string;
  style: "html-text";
  targetId: string;
  tagName: "h1" | "h2" | "p";
  currentText: string;
  replacementText: string;
};

export type CtaRewriteGap = {
  filepath: string;
  style: "html-cta";
  targetId: string;
  element: "a" | "button";
  currentText: string;
  reason: string;
};

export type CtaRewritePatch = {
  filepath: string;
  style: "html-cta";
  targetId: string;
  element: "a" | "button";
  currentText: string;
  replacementText: string;
};

export type FaqSectionGap = {
  filepath: string;
  style: "html-main" | "mdx-section";
  reason: string;
  existingHeadings: string[];
};

export type FaqSectionPatch = {
  filepath: string;
  style: "html-main" | "mdx-section";
  heading: string;
  faqs: Array<{
    question: string;
    answer: string;
  }>;
};

export type VisualUpgradeGap = {
  filepath: string;
  style: "html-main-css";
  stylesheetPath: string;
  reason: string;
  existingHeadings: string[];
};

export type VisualUpgradePatch = {
  filepath: string;
  style: "html-main-css";
  stylesheetPath: string;
  eyebrow: string;
  heading: string;
  body: string;
  metrics: Array<{
    value: string;
    label: string;
  }>;
  steps: Array<{
    title: string;
    body: string;
  }>;
  ctaText: string;
  ctaHref: string;
};

export type RepoProjectKind =
  | "static-html"
  | "nextjs"
  | "react"
  | "content-site"
  | "unknown";

export type RepoPageRole = "home" | "features" | "pricing" | "blog" | "content" | "unknown";

export type RepoPageSectionKind =
  | "hero"
  | "pricing"
  | "faq"
  | "cta"
  | "generated"
  | "content"
  | "unknown";

export type RepoPageSectionSummary = {
  index: number;
  kind: RepoPageSectionKind;
  heading?: string;
  className?: string;
  wordCount: number;
  hasCta: boolean;
};

export type RepoNavigationArea = "header" | "nav" | "main" | "footer" | "unknown";

export type RepoNavigationLink = {
  sourceFilepath: string;
  area: RepoNavigationArea;
  text: string;
  href: string;
  resolvedPath?: string;
  status: "ok" | "broken";
};

export type RepoPageSummary = {
  filepath: string;
  role: RepoPageRole;
  routePath: string;
  depth: number;
  title?: string;
  h1s: string[];
  h2s: string[];
  sections: RepoPageSectionSummary[];
  stylesheetPaths: string[];
  localLinks: string[];
  inboundInternalLinks: string[];
  ctaTexts: string[];
  wordCount: number;
  hasMain: boolean;
  issues: string[];
};

export type RepoStructureIssue = {
  severity: "critical" | "warning" | "info";
  code:
    | "broken-local-link"
    | "duplicate-h1"
    | "missing-viewport"
    | "weak-pricing-structure"
    | "plain-generated-section"
    | "basic-static-layout"
    | "unknown-project";
  filepath?: string;
  message: string;
};

export type RepoStructureAnalysis = {
  projectKind: RepoProjectKind;
  sourceFiles: string[];
  pages: RepoPageSummary[];
  stylesheets: string[];
  assets: string[];
  navigationLinks: RepoNavigationLink[];
  primaryNav: RepoNavigationLink[];
  footerNav: RepoNavigationLink[];
  orphanPages: string[];
  importantPages: string[];
  brokenLinkCount: number;
  issues: RepoStructureIssue[];
  recommendedFocus: string;
};

export type ProductionSiteUpgradeGap = {
  filepath: string;
  style: "static-html-page-css";
  pageRole: RepoPageRole;
  stylesheetPath: string;
  reason: string;
  issues: string[];
  existingHeadings: string[];
  brokenLocalLinks: Array<{
    href: string;
    suggestedHref: string;
  }>;
};

export type ProductionSiteUpgradePatch = {
  filepath: string;
  style: "static-html-page-css";
  pageRole: RepoPageRole;
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
    highlights: Array<{
      title: string;
      body: string;
    }>;
    comparisonRows?: Array<{
      feature: string;
      starter: string;
      growth: string;
      scale: string;
    }>;
    ctaText: string;
    ctaHref: string;
  };
};

export type InteractiveConversionUpgradeGap = {
  filepath: string;
  style: "static-html-interactive-css";
  pageRole: RepoPageRole;
  stylesheetPath: string;
  reason: string;
  existingHeadings: string[];
  ctaTexts: string[];
};

export type InteractiveConversionUpgradePatch = {
  filepath: string;
  style: "static-html-interactive-css";
  pageRole: RepoPageRole;
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
    recommendations: Array<{
      title: string;
      body: string;
    }>;
    ctaText: string;
    ctaHref: string;
  };
};

export type CrawledPage = {
  url: string;
  status: number;
  title?: string;
  metaDescription?: string;
  h1s: string[];
  h2s: string[];
  imagesWithoutAlt: string[];
  internalLinks: number;
  externalLinks: number;
  wordCount: number;
  hasJsonLdSchema: boolean;
  schemaTypes: string[];
  canonical?: string;
  language?: string;
  viewportMeta?: string;
  fetchedAt: string;
};

// Structured facts about a competitor (or comparable) page. Tuned for
// competitor profiling and similar research skills — different fields than
// CrawledPage (which is SEO-tuned). Both are produced by the same site
// connector but answer different questions.
export type CompetitorPageFacts = {
  url: string;
  status: number;
  brandName?: string;        // best guess: og:site_name → application-name → <title> → hostname
  hero: {
    headline?: string;       // first <h1>
    subhead?: string;        // first meaningful <p> after the hero
  };
  navItems: string[];        // top-level nav link text, deduped
  ctas: string[];            // visible button/CTA text, deduped
  pricingSignals: string[];  // text snippets that mention pricing / $ / /mo / /year / free
  socialProof: string[];     // "trusted by", testimonials, customer logo alts
  footerLinks: string[];     // footer link text — often reveals integrations / docs / careers
  metaDescription?: string;  // raw <meta name="description">
  ogTitle?: string;
  ogDescription?: string;
  language?: string;
  fetchedAt: string;
};

// Writes return this so the tool can store a rollback payload.
// Framework rule §5.3 — every write tool persists rollbackPayload.
export type WriteResult = {
  success: boolean;
  changeId: string; // PR url, CMS revision id, etc.
  rollbackPayload: unknown;
  previewUrl?: string;
};

export type ExpectedChangeCheck = {
  kind: string;
  filepath: string;
  target: string;
  passed: boolean;
  message: string;
};

export type SeoFixVerificationInput = {
  altText?: AltTextPatch[];
  pageMetadata?: PageMetadataPatch[];
  visibleContent?: VisibleContentPatch[];
  copyRewrite?: CopyRewritePatch[];
  ctaRewrite?: CtaRewritePatch[];
  faqSection?: FaqSectionPatch[];
  visualUpgrade?: VisualUpgradePatch[];
  productionUpgrade?: ProductionSiteUpgradePatch[];
  interactiveConversionUpgrade?: InteractiveConversionUpgradePatch[];
  repo?: RepoConnectionConfig;
  plan?: {
    auditUrl?: string;
    healthScore?: number;
    auditFindingCount?: number;
    criticalFindingCount?: number;
    warningFindingCount?: number;
    findingIds?: string[];
    repoAnalysis?: RepoStructureAnalysis;
  };
};

export type SeoFixVerificationResult = {
  ok: boolean;
  checkedAt: string;
  summary: string;
  expectedChecks: ExpectedChangeCheck[];
  repo?: {
    projectKind: RepoProjectKind;
    beforeIssueCount?: number;
    afterIssueCount: number;
    issuesImproved?: boolean;
    recommendedFocus: string;
  };
};

export type ExternalWriteStatus = {
  provider: "github" | "unknown";
  kind: "pull_request" | "simulated" | "unknown";
  state: "open" | "merged" | "closed" | "not_found" | "simulated" | "unknown";
  checkedAt: string;
  changeId?: string;
  summary: string;
};

export type RepoConnectionConfig = {
  owner: string;
  repo: string;
  defaultBranch?: string;
  accessToken?: string;
  tokenSource?: "env" | "oauth";
};

export type SourceScanOptions = {
  paths?: string[];
  maxFiles?: number;
  repo?: RepoConnectionConfig;
};

export interface SiteConnector {
  type: string; // "site:cheerio", "site:wordpress", "site:github-mdx", ...
  capabilities: SiteCapabilities;
  crawl(url: string): Promise<CrawledPage>;
  // Read a page for competitor research — different shape than `crawl`.
  // Capability flag: SiteCapabilities.canReadCompetitor.
  crawlCompetitor?(url: string): Promise<CompetitorPageFacts>;
  // Write methods (optional — connector capabilities flag which exist):
  updateMeta?: (
    url: string,
    meta: { title?: string; description?: string },
  ) => Promise<WriteResult>;
  publishPost?: (post: {
    title: string;
    body: string;
    slug?: string;
  }) => Promise<WriteResult>;
  scanAltTextGaps?: (options?: SourceScanOptions) => Promise<AltTextGap[]>;
  analyzeRepoStructure?: (options?: SourceScanOptions) => Promise<RepoStructureAnalysis>;
  fixAltText?: (patches: AltTextPatch[]) => Promise<WriteResult>;
  scanPageMetadata?: (options?: SourceScanOptions) => Promise<PageMetadataGap[]>;
  fixPageMetadata?: (patches: PageMetadataPatch[]) => Promise<WriteResult>;
  scanVisibleContentGaps?: (options?: SourceScanOptions) => Promise<VisibleContentGap[]>;
  scanCopyRewriteGaps?: (options?: SourceScanOptions) => Promise<CopyRewriteGap[]>;
  scanCtaRewriteGaps?: (options?: SourceScanOptions) => Promise<CtaRewriteGap[]>;
  scanFaqSectionGaps?: (options?: SourceScanOptions) => Promise<FaqSectionGap[]>;
  scanVisualUpgradeGaps?: (options?: SourceScanOptions) => Promise<VisualUpgradeGap[]>;
  scanProductionSiteUpgradeGaps?: (options?: {
    paths?: string[];
    maxFiles?: number;
    repo?: RepoConnectionConfig;
    analysis?: RepoStructureAnalysis;
  }) => Promise<ProductionSiteUpgradeGap[]>;
  scanInteractiveConversionUpgradeGaps?: (options?: {
    paths?: string[];
    maxFiles?: number;
    repo?: RepoConnectionConfig;
    analysis?: RepoStructureAnalysis;
  }) => Promise<InteractiveConversionUpgradeGap[]>;
  // Bundled write — one PR carrying multiple kinds of fixes. The orchestrator
  // uses this so all SEO fixes for a run land in a single review unit.
  applySeoFixes?: (input: {
    altText?: AltTextPatch[];
    pageMetadata?: PageMetadataPatch[];
    visibleContent?: VisibleContentPatch[];
    copyRewrite?: CopyRewritePatch[];
    ctaRewrite?: CtaRewritePatch[];
    faqSection?: FaqSectionPatch[];
    visualUpgrade?: VisualUpgradePatch[];
    productionUpgrade?: ProductionSiteUpgradePatch[];
    interactiveConversionUpgrade?: InteractiveConversionUpgradePatch[];
    repo?: RepoConnectionConfig;
    reason?: string;
  }) => Promise<WriteResult>;
  verifySeoFixes?: (
    input: SeoFixVerificationInput,
  ) => Promise<SeoFixVerificationResult>;
  inspectWriteStatus?: (
    rollbackPayload: unknown,
  ) => Promise<ExternalWriteStatus>;
  // Rollback for changes this connector produced. The `kind` matches the
  // write that produced the payload (e.g. "alt-text").
  rollback?: (kind: string, rollbackPayload: unknown) => Promise<WriteResult>;
}
