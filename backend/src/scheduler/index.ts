// Scheduler. Registers cron jobs at server boot and exposes a manual-trigger
// helper for the dev API.
//
// Cron expression format (5 fields): minute hour day-of-month month day-of-week
//   "0 6 * * 1" = every Monday 06:00 local time
//
// Per backend AGENTS.md §2: node-cron is the chosen scheduler. Inngest will
// replace it when we need durability/retries across restarts.

import cron from "node-cron";
import { eventsStore } from "../lib/store";
import { runWeeklySeoAudit } from "./weekly-seo-audit";
import {
  verifyMergedAgentPrs,
  type VerifyMergedAgentPrsResult,
} from "./verify-merged-agent-prs";

export type JobId = "weekly-seo-audit" | "verify-merged-agent-prs";

export type JobRunResult = {
  taskId?: string;
  message?: string;
} | VerifyMergedAgentPrsResult;

type Job = {
  id: JobId;
  cron: string;            // cron expression
  description: string;
  handler: () => Promise<JobRunResult>;
};

export const jobs: Record<JobId, Job> = {
  "weekly-seo-audit": {
    id: "weekly-seo-audit",
    cron: "0 6 * * 1",
    description: "Every Monday 06:00 — full SEO audit of the workspace's site.",
    handler: runWeeklySeoAudit,
  },
  "verify-merged-agent-prs": {
    id: "verify-merged-agent-prs",
    cron: "*/2 * * * *",
    description: "Every 2 minutes — verify agent PRs after GitHub marks them merged.",
    handler: verifyMergedAgentPrs,
  },
};

// Called once at server boot.
export function registerCronJobs(): void {
  for (const job of Object.values(jobs)) {
    cron.schedule(job.cron, async () => {
      eventsStore.append("scheduler_cron_tick", { jobId: job.id });
      try {
        await job.handler();
      } catch (err) {
        eventsStore.append("scheduler_cron_error", {
          jobId: job.id,
          message: err instanceof Error ? err.message : "unknown",
        });
      }
    });
    console.log(`[scheduler] registered "${job.id}" — cron: ${job.cron}`);
  }
}

// Used by POST /api/scheduler/run/:jobId — fire a job on demand without
// waiting for its cron tick.
export async function runJob(jobId: string): Promise<JobRunResult> {
  const job = jobs[jobId as JobId];
  if (!job) throw new Error(`Unknown jobId: ${jobId}`);
  eventsStore.append("scheduler_manual_run", { jobId });
  return job.handler();
}
