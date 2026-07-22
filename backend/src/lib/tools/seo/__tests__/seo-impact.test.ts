// Sanity tests for Step 9 before-vs-after SEO impact labels.
//
// Run with: npx tsx src/lib/tools/seo/__tests__/seo-impact.test.ts

import { buildSeoImpactSummary } from "../../../agent-tools";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

const improved = buildSeoImpactSummary(true, {
  ok: true,
  status: "improved",
  summary: "Live audit moved from 72/100 to 86/100 (+14 point(s)).",
  scoreDelta: 14,
  findingDelta: -3,
});
assert(improved.verdict === "verified_improvement", "labels improved audits as verified improvement");
assert(improved.scoreDelta === 14, "keeps score delta on improved audits");

const unchanged = buildSeoImpactSummary(true, {
  ok: true,
  status: "unchanged",
  summary: "Live audit moved from 86/100 to 86/100 (0 point(s)).",
  scoreDelta: 0,
  findingDelta: 0,
});
assert(unchanged.verdict === "merged_no_improvement", "labels unchanged audits as merged with no improvement");

const regressed = buildSeoImpactSummary(true, {
  ok: false,
  status: "regressed",
  summary: "Live audit moved from 86/100 to 80/100 (-6 point(s)).",
  scoreDelta: -6,
  findingDelta: 2,
});
assert(regressed.verdict === "needs_review", "labels regressed audits as needing review");

const repoFailed = buildSeoImpactSummary(false, {
  ok: true,
  status: "improved",
  summary: "Live audit improved, but expected source checks failed.",
  scoreDelta: 10,
  findingDelta: -1,
});
assert(repoFailed.verdict === "needs_review", "source verification failure overrides live improvement");

const unavailable = buildSeoImpactSummary(true, {
  ok: false,
  status: "unavailable",
  summary: "Live audit could not run because the local site was offline.",
});
assert(unavailable.verdict === "unavailable", "labels offline audits as unavailable");

console.log("\nSEO impact tests passed.");
