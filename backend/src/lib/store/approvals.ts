// Approvals store. First-class records that can outlive a skill run.
// Populated at Step 4 when the Approvals inbox UI lands. Today, approvals
// still live inline on the skill run's final report — this is the future home.

import type { Approval } from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspaces";
import { getJson, listJson, putJson } from "./sqlite";

function saveApproval(approval: Approval): Approval {
  return putJson("approvals", approval.id, approval, {
    workspaceId: approval.workspaceId,
    skillRunId: approval.skillRunId,
    status: approval.status,
    createdAt: approval.createdAt,
  });
}

export const approvalsStore = {
  create(
    input: Omit<Approval, "id" | "createdAt" | "status">,
  ): Approval {
    const approval: Approval = {
      id: crypto.randomUUID(),
      status: "pending",
      createdAt: new Date().toISOString(),
      ...input,
    };
    return saveApproval(approval);
  },

  get(id: string): Approval | undefined {
    return getJson<Approval>("approvals", id);
  },

  list(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
    status?: Approval["status"],
  ): Approval[] {
    return listJson<Approval>("approvals", { workspaceId, status });
  },

  decide(
    id: string,
    status: Approval["status"],
    decidedBy: string,
    decisionNote?: string,
  ): Approval | undefined {
    const approval = this.get(id);
    if (!approval || approval.status !== "pending") return undefined;
    const next: Approval = {
      ...approval,
      status,
      decidedBy,
      decidedAt: new Date().toISOString(),
      decisionNote,
    };
    return saveApproval(next);
  },

  update(id: string, updates: Partial<Approval>): Approval | undefined {
    const approval = this.get(id);
    if (!approval) return undefined;
    const next: Approval = { ...approval, ...updates };
    return saveApproval(next);
  },
};
