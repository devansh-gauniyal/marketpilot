// Step 5 sanity test. Exercises:
//   addAltText (tool body) → githubMdxConnector.fixAltText (simulated PR)
//   rollbackToolCall("add_alt_text", payload) → connector.rollback (simulated)
// Plus the no-patches early return + the capability check.
//
// Run with: npx tsx src/lib/tools/seo/__tests__/add-alt-text.test.ts

import { addAltText } from "../add-alt-text";
import { rollbackToolCall } from "../../../agent-tools";

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error("FAIL:", msg);
    process.exit(1);
  }
  console.log("ok:", msg);
}

(async () => {
  // 1) Empty patches → graceful failure
  const empty = await addAltText({ patches: [] });
  assert(empty.success === false, "empty patches → success=false");
  assert(empty.changeId === "", "empty patches → no changeId");

  // 2) Real-ish call with two patches → success + rollback payload
  const out = await addAltText({
    patches: [
      {
        filepath: "content/blog/launch.mdx",
        imageSrc: "/img/hero.png",
        altText: "Two engineers shipping a feature flag rollout",
      },
      {
        filepath: "content/blog/launch.mdx",
        imageSrc: "/img/metric.png",
        altText: "Line chart showing weekly active users climbing 22 percent",
      },
    ],
    reason: "audit_seo flagged 2 images without alt text",
  });

  assert(out.success === true, "fixes two images → success=true");
  assert(typeof out.changeId === "string" && out.changeId.startsWith("https://github.com/"), "changeId looks like a github URL");
  assert(out.rollbackPayload !== null, "rollback payload returned");

  const payload = out.rollbackPayload as { kind: string; patches: unknown[] };
  assert(payload.kind === "alt-text", "rollback payload kind is alt-text");
  assert(Array.isArray(payload.patches) && payload.patches.length === 2, "rollback payload carries both patches");

  // 3) Rollback dispatcher reverses the call
  const rollback = await rollbackToolCall("add_alt_text", out.rollbackPayload);
  assert(rollback.success === true, "rollback dispatch succeeded");
  assert(/closed/i.test(rollback.result), "rollback result mentions 'closed'");

  // 4) Unknown tool → graceful failure
  const unknown = await rollbackToolCall("nonexistent_tool", {});
  assert(unknown.success === false, "unknown tool → rollback failure");

  console.log("\nAll Step 5 add_alt_text tests passed.");
})().catch((err) => {
  console.error("FAIL: unexpected error", err);
  process.exit(1);
});
