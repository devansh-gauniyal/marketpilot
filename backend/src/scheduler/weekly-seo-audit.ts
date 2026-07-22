// Weekly SEO audit job. Reads the workspace's product profile to find the
// site URL, kicks off an agent run with the seo-audit skill, and seeds the
// brief from the profile so the agent has business context.
//
// Triggers:
//   - cron: every Monday 06:00 (registered in scheduler/index.ts)
//   - manual: POST /api/scheduler/run/weekly-seo-audit

import { randomUUID } from "crypto";
import {
  DEFAULT_WORKSPACE_ID,
  eventsStore,
  productProfileStore,
  skillRunsStore,
} from "../lib/store";
import { runAgentLoop } from "../lib/agent-loop";
import { primaryWorkspaceSiteUrl } from "../lib/connections/workspace-connections";
import { promises as fs } from "fs";
import path from "path";

const SKILL_ID = "seo-audit";

async function loadSkillContent(skillId: string): Promise<string> {
  const candidates = [
    path.resolve(__dirname, "..", "..", "..", ".agents", "skills", skillId, "SKILL.md"),
    path.join(process.cwd(), "..", ".agents", "skills", skillId, "SKILL.md"),
  ];
  for (const p of candidates) {
    try {
      return await fs.readFile(p, "utf8");
    } catch {
      // try the next one
    }
  }
  return `# ${skillId}\nExecute the ${skillId} marketing workflow for this product.`;
}

export async function runWeeklySeoAudit(): Promise<{ taskId: string }> {
  const profile = productProfileStore.get(DEFAULT_WORKSPACE_ID);
  if (!profile) {
    throw new Error("weekly-seo-audit: product profile not seeded.");
  }

  const taskId = randomUUID();
  const siteUrl = primaryWorkspaceSiteUrl(DEFAULT_WORKSPACE_ID) ?? profile.siteUrl;

  skillRunsStore.create(
    taskId,
    SKILL_ID,
    {
      siteUrl,
      siteType: "Marketing site",
      primaryGoal:
        "Run a full SEO audit and propose 2-3 concrete fixes the user can approve.",
      knownIssues:
        "Reference recent audit findings if they exist in memory. Do not re-audit pages that were audited in the last 24h.",
      productName: profile.productName,
      targetAudience: profile.icp,
      campaignGoal:
        `Run a full SEO audit on ${siteUrl} using audit_seo. ` +
        `Propose 2-3 concrete fixes the user can approve. Reference recent audit findings if they exist in memory — do not re-audit pages that were audited in the last 24h.`,
      brandTone: profile.voiceTone.join(", ") || "Professional",
      mainChannel: "Website SEO",
      campaignBudget: "Low",
      launchTimeline: new Date().toISOString().slice(0, 10),
    },
    /* campaignId */ undefined,
    DEFAULT_WORKSPACE_ID,
  );

  eventsStore.append("scheduler_job_fired", {
    jobId: "weekly-seo-audit",
    taskId,
    siteUrl,
  }, DEFAULT_WORKSPACE_ID);

  const skillContent = await loadSkillContent(SKILL_ID);

  // Kick off the loop in the background — do not await.
  runAgentLoop(taskId, skillContent).catch((err: Error) => {
    skillRunsStore.update(taskId, { status: "failed", error: err.message });
  });

  return { taskId };
}
