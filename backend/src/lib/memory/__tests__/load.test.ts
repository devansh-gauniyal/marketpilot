// Step 6 sanity test — verifies memory loader returns the seeded profile and
// renders the prompt block correctly. No Gemini, no network.
//
// Run with: npx tsx src/lib/memory/__tests__/load.test.ts

import { loadMemory, renderMemoryForPrompt } from "../load";
import { auditsStore, performanceStore } from "../../store";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

// 1) Empty world (besides seeded profile)
const bare = loadMemory();
assert(bare.profile !== null, "default profile seeded");
assert(bare.profile?.productName === "MarketPilot AI", "default product name");
assert(Array.isArray(bare.recentAudits), "recentAudits is an array");
assert(Array.isArray(bare.recentPerformance), "recentPerformance is an array");

const bareText = renderMemoryForPrompt(bare);
assert(bareText.includes("WORKSPACE MEMORY"), "prompt has memory header");
assert(bareText.includes("MarketPilot AI"), "prompt mentions product name");
assert(!bareText.includes("RECENT AUDITS"), "no audits section when empty");
assert(!bareText.includes("RECENT PERFORMANCE"), "no performance section when empty");

// 2) Add an audit + a performance snapshot, re-load
auditsStore.create({
  workspaceId: "ws_default",
  type: "seo",
  scopeJson: { url: "https://example.com" },
  findingsJson: {
    score: 65,
    findings: [
      { severity: "critical", id: "missing-meta-description", message: "..." },
      { severity: "warning", id: "thin-content", message: "..." },
      { severity: "info", id: "missing-schema", message: "..." },
    ],
  },
  triagedActionsJson: {},
});

performanceStore.upsert({
  date: "2026-05-17",
  workspaceId: "ws_default",
  trafficOrganic: 12000,
  trafficPaid: 3400,
  trafficDirect: 1800,
  conversions: 84,
  mrr: 45000,
  cac: 220,
  churnRate: 0.045,
  adSpend: 2100,
  adRoas: 3.2,
  rankingsJson: {},
});

const populated = loadMemory();
assert(populated.recentAudits.length >= 1, "audit picked up");
assert(populated.recentPerformance.length >= 1, "performance picked up");

const populatedText = renderMemoryForPrompt(populated);
assert(populatedText.includes("RECENT AUDITS"), "prompt has audits section");
assert(populatedText.includes("score 65"), "prompt mentions score");
assert(populatedText.includes("1 crit"), "prompt mentions critical count");
assert(populatedText.includes("RECENT PERFORMANCE"), "prompt has performance section");
assert(populatedText.includes("$45000"), "prompt mentions MRR");

console.log("\nAll Step 6 memory tests passed.");
