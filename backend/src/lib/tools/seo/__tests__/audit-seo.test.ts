// Step 3 sanity test. Runs:
//   cheerioSiteConnector.crawl(url) → runAuditChecks(page) → audits store
// against a live URL. No Gemini, no agent loop. Verifies the connector
// returns structured data, the checks fire, and an audit is persisted.
//
// Run with: npx tsx src/lib/tools/seo/__tests__/audit-seo.test.ts

import { cheerioSiteConnector } from "../../../connectors";
import { runAuditChecks, scoreFromFindings } from "../audit-checks";
import { auditsStore } from "../../../store";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

// example.com is a stable, well-known URL maintained by IANA. Tiny page,
// no JS, predictable structure. Good for a smoke test.
const URL = "https://example.com";

(async () => {
  console.log(`Crawling ${URL}...`);
  const page = await cheerioSiteConnector.crawl(URL);

  assert(page.status === 200, "got HTTP 200");
  assert(typeof page.title === "string" && page.title.length > 0, "title parsed");
  assert(page.h1s.length > 0, "at least one h1 found");
  assert(typeof page.wordCount === "number", "wordCount is numeric");
  assert(typeof page.fetchedAt === "string", "fetchedAt timestamp present");

  console.log("Running audit checks...");
  const findings = runAuditChecks(page);
  console.log(`  → ${findings.length} findings`);
  const score = scoreFromFindings(findings);
  console.log(`  → score: ${score}`);
  assert(Array.isArray(findings), "findings is an array");
  assert(score >= 0 && score <= 100, "score is in 0-100 range");

  console.log("Persisting audit...");
  const audit = auditsStore.create({
    workspaceId: "ws_default",
    type: "seo",
    scopeJson: { url: URL },
    findingsJson: { score, findings, page },
    triagedActionsJson: {},
  });
  assert(!!audit.id, "audit got an id");

  const fetched = auditsStore.get(audit.id);
  assert(fetched?.type === "seo", "audit reads back as type=seo");

  const list = auditsStore.list("ws_default", "seo");
  assert(list.length >= 1, "audits store lists at least one seo audit");

  console.log("\nAll Step 3 connector+audit tests passed.");
})().catch((err) => {
  console.error("FAIL: unexpected error", err);
  process.exit(1);
});
