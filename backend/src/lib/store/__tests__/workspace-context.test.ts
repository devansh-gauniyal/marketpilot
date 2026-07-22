import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import type { Request } from "express";

async function main(): Promise<void> {
  process.env.MARKETPILOT_DB_PATH = path.join(
    os.tmpdir(),
    "marketpilot-tests",
    `workspace-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );

  const {
    DEFAULT_USER_ID,
    DEFAULT_WORKSPACE_ID,
    approvalsStore,
    auditsStore,
    productProfileStore,
    skillRunsStore,
    usersStore,
    workspaceMembersStore,
    workspacesStore,
  } = await import("../index.js");
  const { resolveRequestContext } = await import("../../workspace/request-context.js");

  const defaultUser = usersStore.getDefault();
  assert(defaultUser.id === DEFAULT_USER_ID, "default local user is seeded");
  assert(
    workspaceMembersStore.hasAccess(DEFAULT_USER_ID, DEFAULT_WORKSPACE_ID),
    "default user can access default workspace",
  );

  const secondWorkspace = workspacesStore.create({ name: "Second Workspace" });
  workspaceMembersStore.add({
    userId: DEFAULT_USER_ID,
    workspaceId: secondWorkspace.id,
    role: "owner",
  });
  productProfileStore.ensure(secondWorkspace.id, "Second Product");

  const requestContext = resolveRequestContext(fakeRequest({
    "x-user-id": DEFAULT_USER_ID,
    "x-workspace-id": secondWorkspace.id,
  }));
  assert(!("error" in requestContext), "request context resolves header workspace");
  assert(requestContext.workspaceId === secondWorkspace.id, "request context uses selected workspace");

  const secondRun = skillRunsStore.create(
    "workspace-run-1",
    "seo-audit",
    { campaignGoal: "Audit workspace two" },
    undefined,
    secondWorkspace.id,
  );
  assert(secondRun.workspaceId === secondWorkspace.id, "skill runs can be created in selected workspace");

  approvalsStore.create({
    workspaceId: secondWorkspace.id,
    skillRunId: secondRun.taskId,
    toolCallId: "tool-workspace-1",
    title: "Workspace approval",
    summary: "Approve scoped work",
    reasoning: "Testing workspace isolation",
    proposedActionJson: { ok: true },
    expectedImpact: "Scoped approval",
    rollbackPlan: "Reject it",
  });

  auditsStore.create({
    workspaceId: secondWorkspace.id,
    type: "seo",
    scopeJson: { url: "https://example.com/second" },
    findingsJson: { score: 90 },
    triagedActionsJson: {},
  });

  assert(approvalsStore.list(secondWorkspace.id).length === 1, "second workspace sees its approval");
  assert(approvalsStore.list(DEFAULT_WORKSPACE_ID).length === 0, "default workspace does not see second approval");
  assert(auditsStore.list(secondWorkspace.id, "seo").length === 1, "second workspace sees its audit");
  assert(skillRunsStore.list().some((run) => run.workspaceId === secondWorkspace.id), "runs retain workspace id");

  console.log("Workspace context tests passed.");
}

function fakeRequest(headers: Record<string, string>): Request {
  return {
    header(name: string): string | undefined {
      return headers[name.toLowerCase()];
    },
    query: {},
    body: {},
  } as unknown as Request;
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
