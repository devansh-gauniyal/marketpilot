// End-to-end test for the SEO orchestrator.
//
// What this exercises:
//   - agent-loop routing for skillId === "seo-audit"
//   - the orchestrator's full pipeline
//   - real GitHub repo scan (alt-text + page metadata)
//   - real Gemini draft step (with a user hint)
//   - real PR opened on the configured repo
//   - tool-call persistence (for rollback)
//
// What's stubbed:
//   - cheerioSiteConnector.crawl — returns a flawed CrawledPage so we don't
//     need python http.server running. The repo scan and Gemini call are NOT
//     stubbed.
//
// Run with:
//   npx tsx scripts/test-seo-orchestrator.ts
//   npx tsx scripts/test-seo-orchestrator.ts "your hint here"

import "dotenv/config";
import { randomUUID } from "crypto";
import { cheerioSiteConnector } from "../src/lib/connectors";
import type { CrawledPage } from "../src/lib/connectors/types";
import {
  eventsStore,
  skillRunsStore,
  toolCallsStore,
} from "../src/lib/store";
import { runSeoAuditOrchestrator } from "../src/lib/agent/seo-orchestrator";

const hint = process.argv[2] ?? "";
const TEST_URL = "http://localhost:5177";

// Stub the live-page crawl so we can run without python http.server.
const flawedPage: CrawledPage = {
  url: TEST_URL,
  status: 200,
  // intentionally short
  title: "Home",
  // intentionally missing
  metaDescription: undefined,
  h1s: ["MarketPilot AI"],
  h2s: [],
  imagesWithoutAlt: ["assets/product-dashboard.svg", "assets/launch-calendar.svg"],
  internalLinks: 4,
  externalLinks: 1,
  wordCount: 120,
  hasJsonLdSchema: false,
  schemaTypes: [],
  canonical: undefined,
  language: undefined,
  viewportMeta: "width=device-width, initial-scale=1",
  fetchedAt: new Date().toISOString(),
};
cheerioSiteConnector.crawl = async () => flawedPage;

async function main() {
  console.log("\n=== SEO orchestrator end-to-end test ===\n");
  console.log("URL:", TEST_URL);
  console.log("Hint:", hint || "(none)");
  console.log("GitHub repo:", `${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO}`);
  console.log("Gemini key present:", !!process.env.GEMINI_API_KEY);
  console.log("");

  const taskId = randomUUID();
  skillRunsStore.create(
    taskId,
    "seo-audit",
    {
      productName: "MarketPilot AI",
      targetAudience: "B2B SaaS founders",
      campaignGoal: hint ? `Audit ${TEST_URL}. ${hint}` : `Audit ${TEST_URL}`,
      brandTone: "Bold, technical",
      mainChannel: "Website SEO",
      campaignBudget: "Low",
      launchTimeline: new Date().toISOString().slice(0, 10),
    },
  );

  const t0 = Date.now();
  await runSeoAuditOrchestrator(taskId, "# seo-audit\nAudit the site.");
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const run = skillRunsStore.get(taskId)!;
  console.log(`\n--- run finished in ${elapsed}s ---`);
  console.log("status:", run.status);
  if (run.error) console.log("error:", run.error);

  console.log("\nSteps:");
  for (const step of run.steps) {
    console.log(`  [${step.type}] ${step.content.slice(0, 180)}`);
  }

  if (run.finalReport) {
    console.log("\nExecutive summary:");
    console.log("  " + run.finalReport.executiveSummary);
    console.log("\nFindings:");
    for (const f of run.finalReport.findings) console.log("  -", f);
    console.log("\nProposed actions:");
    for (const a of run.finalReport.proposedActions) {
      console.log(`  - [${a.type}] ${a.title}`);
      console.log(`      ${a.description}`);
    }
  }

  console.log("\nRollbackable tool calls created:");
  const calls = toolCallsStore.listForRun(taskId);
  for (const c of calls) {
    console.log(`  - ${c.toolName} (${c.tier}) → status=${c.status}`);
    const out = c.outputJson as { changeId?: string } | undefined;
    if (out?.changeId) console.log(`      changeId: ${out.changeId}`);
  }

  console.log("\nEvent log (last 20):");
  const events = eventsStore.tail(20);
  for (const e of events) {
    console.log(`  - ${e.type}`);
  }

  console.log("\n=== done ===\n");
  process.exit(run.status === "failed" ? 1 : 0);
}

main().catch((err) => {
  console.error("test crashed:", err);
  process.exit(1);
});
