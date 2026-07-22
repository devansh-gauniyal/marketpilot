import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  process.env.MARKETPILOT_DB_PATH = path.join(
    os.tmpdir(),
    "marketpilot-tests",
    `store-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );

  const {
    DEFAULT_WORKSPACE_ID,
    approvalsStore,
    auditsStore,
    connectionsStore,
    eventsStore,
    performanceStore,
    productProfileStore,
    skillRunsStore,
    toolCallsStore,
    workspacesStore,
  } = await import("../index.js");

  assert(workspacesStore.getDefault().id === DEFAULT_WORKSPACE_ID, "default workspace is persisted");

  const profile = productProfileStore.get(DEFAULT_WORKSPACE_ID);
  assert(profile?.productName === "MarketPilot AI", "default product profile is persisted");

  const updatedProfile = productProfileStore.set({
    ...profile!,
    tagline: "Persistent agent memory for marketing teams.",
  });
  assert(
    productProfileStore.get(DEFAULT_WORKSPACE_ID)?.tagline === updatedProfile.tagline,
    "product profile updates persist",
  );

  const githubConnection = connectionsStore.findByType("github");
  assert(githubConnection, "default GitHub connection is persisted");
  connectionsStore.update(githubConnection.id, { status: "active" });
  assert(connectionsStore.get(githubConnection.id)?.status === "active", "connection updates persist");

  const run = skillRunsStore.create("test-run-1", "seo-audit", { campaignGoal: "Audit the site" });
  skillRunsStore.addStep(run.taskId, { type: "tool_call", toolName: "audit_seo", content: "Started audit" });
  skillRunsStore.update(run.taskId, { status: "completed" });
  assert(skillRunsStore.get(run.taskId)?.status === "completed", "skill run updates persist");
  assert(skillRunsStore.get(run.taskId)?.steps.length === 1, "skill run steps persist");

  const approval = approvalsStore.create({
    workspaceId: DEFAULT_WORKSPACE_ID,
    skillRunId: run.taskId,
    toolCallId: "tool-test-1",
    title: "Approve SEO PR",
    summary: "Create a PR",
    reasoning: "Audit found a material issue",
    proposedActionJson: { kind: "seo_pr" },
    expectedImpact: "Cleaner site",
    rollbackPlan: "Close or revert the PR",
  });
  approvalsStore.decide(approval.id, "approved", "devansh");
  assert(approvalsStore.get(approval.id)?.status === "approved", "approval decisions persist");

  const toolCall = toolCallsStore.create({
    skillRunId: run.taskId,
    toolName: "apply_seo_fixes",
    tier: "YELLOW",
    inputJson: { url: "http://localhost:5177" },
    rollbackPayloadJson: { prUrl: "https://example.com/pr/1" },
    status: "executed",
    executedAt: new Date().toISOString(),
  });
  toolCallsStore.update(toolCall.id, { verified: true, verificationResult: "verified" });
  assert(toolCallsStore.get(toolCall.id)?.verified === true, "tool call verification persists");

  const audit = auditsStore.create({
    workspaceId: DEFAULT_WORKSPACE_ID,
    type: "seo",
    scopeJson: { url: "http://localhost:5177" },
    findingsJson: [{ severity: "warning" }],
    triagedActionsJson: { yellow: 1 },
  });
  assert(auditsStore.get(audit.id)?.type === "seo", "audits persist");

  performanceStore.upsert({
    workspaceId: DEFAULT_WORKSPACE_ID,
    date: "2026-05-22",
    trafficOrganic: 10,
    trafficPaid: 0,
    trafficDirect: 5,
    conversions: 1,
    mrr: 0,
    cac: 0,
    churnRate: 0,
    adSpend: 0,
    adRoas: 0,
    rankingsJson: [],
  });
  assert(performanceStore.recent(1)[0]?.date === "2026-05-22", "performance snapshots persist");

  const event = eventsStore.append("store_test_event", { ok: true });
  assert(eventsStore.tail(1)[0]?.id === event.id, "events persist");

  console.log("SQLite store tests passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
