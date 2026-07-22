// Skill runs store. Holds every run the agent has started: status, steps,
// drafts, final report. Wire shape is identical to the legacy AgentTask so
// the frontend keeps working without changes.

import type {
  AgentDraft,
  AgentStep,
  ProposedAction,
  SkillRun,
} from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspaces";
import { getJson, listJson, putJson } from "./sqlite";

function saveRun(run: SkillRun): SkillRun {
  return putJson("skill_runs", run.taskId, run, {
    workspaceId: run.workspaceId,
    status: run.status,
    type: run.skillId,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  });
}

export const skillRunsStore = {
  create(
    taskId: string,
    skillId: string,
    inputContext: Record<string, string>,
    campaignId?: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): SkillRun {
    const run: SkillRun = {
      taskId,
      workspaceId,
      campaignId,
      status: "running",
      skillId,
      inputContext,
      steps: [],
      drafts: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    return saveRun(run);
  },

  get(taskId: string): SkillRun | undefined {
    return getJson<SkillRun>("skill_runs", taskId);
  },

  list(): SkillRun[] {
    return listJson<SkillRun>("skill_runs", { orderBy: "updated_at_desc" });
  },

  // Recent completed runs of a specific skill for a workspace. Used by the
  // memory loader so each new run can see prior runs of the same skill (e.g.
  // competitor-profiling: "we already flagged this gap last week").
  recentSkillRuns(
    workspaceId: string,
    skillId: string,
    limit: number,
  ): SkillRun[] {
    return listJson<SkillRun>("skill_runs", {
      workspaceId,
      type: skillId,
      status: "completed",
      orderBy: "updated_at_desc",
      limit,
    });
  },

  update(taskId: string, updates: Partial<SkillRun>): void {
    const run = this.get(taskId);
    if (!run) return;
    saveRun({
      ...run,
      ...updates,
      updatedAt: new Date().toISOString(),
    });
  },

  addStep(taskId: string, step: Omit<AgentStep, "stepId" | "timestamp">): void {
    const run = this.get(taskId);
    if (!run) return;
    run.steps.push({
      ...step,
      stepId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
    });
    run.updatedAt = new Date().toISOString();
    saveRun(run);
  },

  addDraft(taskId: string, draft: Omit<AgentDraft, "createdAt">): void {
    const run = this.get(taskId);
    if (!run) return;
    run.drafts.push({
      ...draft,
      createdAt: new Date().toISOString(),
    });
    run.updatedAt = new Date().toISOString();
    saveRun(run);
  },

  // Approve or reject a proposed action attached to this run's final report.
  // Returns the updated action or null if not found / already resolved.
  // NOTE: this lives here for now because proposed actions are still embedded
  // in the final report. Step 4 promotes approvals to a first-class store.
  resolveAction(
    taskId: string,
    actionId: string,
    approved: boolean,
  ): ProposedAction | null {
    const run = this.get(taskId);
    if (!run?.finalReport) return null;

    const action = run.finalReport.proposedActions.find(
      (a) => a.actionId === actionId,
    );
    if (!action || action.status !== "pending") return null;

    action.status = approved ? "executed" : "rejected";
    action.resolvedAt = new Date().toISOString();
    if (approved) {
      action.result = simulateExecution(action);
    }

    run.updatedAt = new Date().toISOString();
    saveRun(run);
    return action;
  },
};

// Simulated execution for approved actions. No real APIs are called.
// Will be replaced by real tool dispatch once connectors land at Step 3+.
function simulateExecution(action: ProposedAction): string {
  const stamp = new Date().toLocaleString();
  const typeMap: Record<string, string> = {
    social_post: `Scheduled social post "${action.title}" — published ${stamp}.`,
    email: `Email "${action.title}" queued and sent ${stamp}.`,
    budget_allocation: `Budget allocated for "${action.title}" — confirmed ${stamp}.`,
    content_publish: `Content "${action.title}" published live ${stamp}.`,
    ad_campaign: `Ad campaign "${action.title}" launched ${stamp}.`,
    outreach: `Outreach "${action.title}" sent to contacts ${stamp}.`,
    seo_update: `SEO updates for "${action.title}" applied ${stamp}.`,
  };
  return typeMap[action.type] ?? `Action "${action.title}" completed ${stamp}.`;
}
