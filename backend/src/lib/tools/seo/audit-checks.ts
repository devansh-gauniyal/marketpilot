// Pure SEO audit checks. Input: a CrawledPage. Output: a list of findings.
// No I/O — easy to unit-test.
//
// Findings are categorized by severity so the frontend can color them.
// Add new checks here as we learn what matters per skill.

import type { CrawledPage } from "../../connectors/types";

export type Severity = "critical" | "warning" | "info";

export type Finding = {
  id: string;       // stable check id, e.g. "missing-title"
  severity: Severity;
  message: string;  // human-readable summary
  detail?: string;  // optional extra context
};

const TITLE_MIN = 25;
const TITLE_MAX = 65;
const META_MIN = 70;
const META_MAX = 165;
const MIN_WORD_COUNT = 300;
const MAX_IMAGES_WITHOUT_ALT = 0;

export function runAuditChecks(page: CrawledPage): Finding[] {
  const out: Finding[] = [];

  // Title
  if (!page.title) {
    out.push({
      id: "missing-title",
      severity: "critical",
      message: "Page has no <title> tag.",
    });
  } else if (page.title.length < TITLE_MIN || page.title.length > TITLE_MAX) {
    out.push({
      id: "title-length",
      severity: "warning",
      message: `Title length ${page.title.length} is outside the ideal ${TITLE_MIN}-${TITLE_MAX} range.`,
      detail: page.title,
    });
  }

  // Meta description
  if (!page.metaDescription) {
    out.push({
      id: "missing-meta-description",
      severity: "critical",
      message: "Page has no meta description.",
    });
  } else if (
    page.metaDescription.length < META_MIN ||
    page.metaDescription.length > META_MAX
  ) {
    out.push({
      id: "meta-description-length",
      severity: "warning",
      message: `Meta description length ${page.metaDescription.length} is outside the ideal ${META_MIN}-${META_MAX} range.`,
    });
  }

  // H1
  if (page.h1s.length === 0) {
    out.push({
      id: "missing-h1",
      severity: "critical",
      message: "Page has no <h1> heading.",
    });
  } else if (page.h1s.length > 1) {
    out.push({
      id: "multiple-h1",
      severity: "warning",
      message: `Page has ${page.h1s.length} <h1> tags. Use only one.`,
    });
  }

  // H2 presence
  if (page.h1s.length > 0 && page.h2s.length === 0) {
    out.push({
      id: "no-h2",
      severity: "info",
      message: "Page has an H1 but no H2s — content hierarchy is shallow.",
    });
  }

  // Alt-text gaps
  if (page.imagesWithoutAlt.length > MAX_IMAGES_WITHOUT_ALT) {
    out.push({
      id: "images-missing-alt",
      severity: "warning",
      message: `${page.imagesWithoutAlt.length} image(s) are missing alt text.`,
      detail: page.imagesWithoutAlt.slice(0, 5).join(", "),
    });
  }

  // Word count
  if (page.wordCount < MIN_WORD_COUNT) {
    out.push({
      id: "thin-content",
      severity: "warning",
      message: `Body has only ${page.wordCount} words. Thin content (< ${MIN_WORD_COUNT}) ranks poorly.`,
    });
  }

  // Canonical
  if (!page.canonical) {
    out.push({
      id: "missing-canonical",
      severity: "warning",
      message: "Page has no canonical link — duplicate content risk.",
    });
  }

  // Schema
  if (!page.hasJsonLdSchema) {
    out.push({
      id: "missing-schema",
      severity: "info",
      message: "Page has no JSON-LD structured data.",
    });
  }

  // Language
  if (!page.language) {
    out.push({
      id: "missing-lang",
      severity: "info",
      message: "<html> tag has no lang attribute.",
    });
  }

  // Viewport
  if (!page.viewportMeta) {
    out.push({
      id: "missing-viewport",
      severity: "warning",
      message: "Page has no viewport meta tag — mobile rendering will be broken.",
    });
  }

  // HTTP status
  if (page.status >= 400) {
    out.push({
      id: "bad-status",
      severity: "critical",
      message: `Page returned HTTP ${page.status}.`,
    });
  }

  return out;
}

export function scoreFromFindings(findings: Finding[]): number {
  // Simple deterministic score: start at 100, subtract per severity, floor 0.
  let score = 100;
  for (const f of findings) {
    if (f.severity === "critical") score -= 15;
    else if (f.severity === "warning") score -= 6;
    else score -= 1;
  }
  return Math.max(0, score);
}
