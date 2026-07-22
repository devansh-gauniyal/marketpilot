// Plain script (no test framework) — run with:
//   npx tsx src/lib/agent/__tests__/tier-gate.test.ts
//
// Exercises every branch of the tier gate against a fake skill run id.

import { tierGate } from "../tier-gate";
import { approvalsStore, eventsStore } from "../../store";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

const skillRunId = "test-run";

// GREEN: web_search
const green = tierGate({
  skillRunId,
  toolName: "web_search",
  input: { query: "anything" },
});
assert(green.kind === "execute", "web_search → execute");
assert(green.tier === "GREEN", "web_search tier is GREEN");

// YELLOW: write_draft
const yellow = tierGate({
  skillRunId,
  toolName: "write_draft",
  input: { title: "T", content: "C", type: "email" },
});
assert(yellow.kind === "execute-and-notify", "write_draft → execute-and-notify");
assert(yellow.tier === "YELLOW", "write_draft tier is YELLOW");

// RED: unknown tool (fails closed)
const red = tierGate({
  skillRunId,
  toolName: "this_tool_does_not_exist",
  input: {},
});
assert(red.kind === "blocked", "unknown tool → blocked");
assert(red.tier === "RED", "unknown tool tier is RED");
assert(
  typeof (red as { approvalId?: string }).approvalId === "string",
  "blocked decision returns an approvalId",
);

// The block should have created an approval record.
const approval = approvalsStore.get(
  (red as { approvalId: string }).approvalId,
);
assert(!!approval, "approval record was created for the blocked call");
assert(approval?.status === "pending", "approval starts pending");
assert(
  approval?.skillRunId === skillRunId,
  "approval references the skill run",
);

// Dynamic RED: SEO PR writes can be prepared first, then blocked for approval.
const seo = tierGate({
  skillRunId,
  toolName: "apply_seo_fixes",
  input: {
    requiresApproval: true,
    approvalTitle: "Approve SEO improvement PR",
    approvalSummary: "Prepared safe SEO fixes.",
    approvalReasoning: "Wait for human approval before creating a GitHub PR.",
    expectedImpact: "Improve visible homepage messaging first",
    rollbackPlan: "Rejecting creates no PR.",
    proposedActionJson: {
      type: "seo_pr_approval",
      toolName: "apply_seo_fixes",
      requiresApproval: true,
    },
  },
});
assert(seo.kind === "blocked", "apply_seo_fixes with requiresApproval → blocked");
const seoApproval = approvalsStore.get((seo as { approvalId: string }).approvalId);
assert(
  seoApproval?.title === "Approve SEO improvement PR",
  "dynamic approval uses the custom title",
);
assert(
  (seoApproval?.proposedActionJson as { type?: string } | undefined)?.type ===
    "seo_pr_approval",
  "dynamic approval stores the proposed SEO PR payload",
);

// All three gate calls should have written one tool_gated event each.
const events = eventsStore.tail(10).filter((e) => e.type === "tool_gated");
assert(events.length >= 4, "four tool_gated events written");

console.log("\nAll tier-gate tests passed.");
