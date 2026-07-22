import { Router } from "express";
import { promises as fs } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { skillRunsStore } from "../lib/store";
import { runAgentLoop } from "../lib/agent-loop";
import { getSkill } from "../lib/skills/catalog";
import {
  resolveRequestContext,
  sendContextError,
} from "../lib/workspace/request-context";

export const agentRouter = Router();

// Resolve the .agents/skills directory once.
// The backend lives at marketing-agent-platform/backend, so skills are one level up.
const SKILLS_DIR = path.resolve(__dirname, "..", "..", "..", ".agents", "skills");

async function loadSkillContent(skillId: string): Promise<string> {
  const candidates = [
    path.join(SKILLS_DIR, skillId, "SKILL.md"),
    path.join(process.cwd(), "..", ".agents", "skills", skillId, "SKILL.md"),
  ];
  for (const filePath of candidates) {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch {
      // try the next location
    }
  }
  return `# ${skillId}\nExecute the ${skillId} marketing workflow for this product.`;
}

// POST /api/agent/start
// Body: { skillId, brief: Record<string, string>, campaignId? }
// Legacy top-level campaign fields are still accepted while the frontend
// finishes moving to catalog-driven brief forms.
agentRouter.post("/start", async (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const body = isRecord(req.body) ? req.body : {};
  const skillId =
    typeof body.skillId === "string" ? body.skillId.trim() : "";

  if (!skillId) {
    return res.status(400).json({ error: "skillId is required." });
  }

  const skill = getSkill(skillId);
  if (!skill) {
    return res.status(400).json({ error: `Unknown skillId: ${skillId}` });
  }

  const legacyContext = readLegacyCampaignFields(body);
  const structuredBrief = readStringRecord(body.brief);
  const inputContext: Record<string, string> = {
    ...legacyContext,
    ...structuredBrief,
  };

  if (isRecord(body.brief)) {
    const missingFields = skill.briefFields
      .filter((field) => field.required)
      .filter((field) => !inputContext[field.key]?.trim())
      .map((field) => field.label);

    if (missingFields.length > 0) {
      return res.status(400).json({
        error: `Missing required brief field(s): ${missingFields.join(", ")}`,
      });
    }
  }

  const campaignId =
    typeof body.campaignId === "string" ? body.campaignId : undefined;

  const taskId = randomUUID();
  const skillContent = await loadSkillContent(skillId);

  skillRunsStore.create(taskId, skillId, inputContext, campaignId, ctx.workspaceId);

  // Kick off the agent loop in the background — do not await.
  runAgentLoop(taskId, skillContent).catch((err: Error) => {
    skillRunsStore.update(taskId, { status: "failed", error: err.message });
  });

  res.json({ taskId, status: "running" });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};

  const output: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    const parsedValue = readInputValue(rawValue);
    if (parsedValue.length > 0) {
      output[key] = parsedValue;
    }
  }
  return output;
}

function readLegacyCampaignFields(
  body: Record<string, unknown>,
): Record<string, string> {
  const fields = [
    "productName",
    "targetAudience",
    "campaignGoal",
    "brandTone",
    "mainChannel",
    "campaignBudget",
    "launchTimeline",
  ];

  const output: Record<string, string> = {};
  for (const field of fields) {
    const parsedValue = readInputValue(body[field]);
    if (parsedValue.length > 0) {
      output[field] = parsedValue;
    }
  }
  return output;
}

function readInputValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "";
}

// GET /api/agent/:taskId
agentRouter.get("/:taskId", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const task = skillRunsStore.get(req.params.taskId);
  if (!task) {
    return res.status(404).json({ error: "Task not found." });
  }
  if (task.workspaceId !== ctx.workspaceId) {
    return res.status(404).json({ error: "Task not found." });
  }
  res.json(task);
});

// POST /api/agent/:taskId/approve
// Body: { actionId: string, approved: boolean }
agentRouter.post("/:taskId/approve", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const { taskId } = req.params;
  const task = skillRunsStore.get(taskId);
  if (!task || task.workspaceId !== ctx.workspaceId) {
    return res.status(404).json({ error: "Task not found." });
  }

  const body = req.body ?? {};
  const actionId =
    typeof body.actionId === "string" ? body.actionId : "";
  const approved = body.approved === true;

  if (!actionId) {
    return res.status(400).json({ error: "actionId is required." });
  }

  const action = skillRunsStore.resolveAction(taskId, actionId, approved);
  if (!action) {
    return res
      .status(404)
      .json({ error: "Action not found or already resolved." });
  }

  res.json({ action });
});
