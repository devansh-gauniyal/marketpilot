import "dotenv/config";
import express from "express";
import cors from "cors";
import { agentRouter } from "./routes/agent";
import { approvalsRouter } from "./routes/approvals";
import { toolCallsRouter } from "./routes/tool-calls";
import { profileRouter } from "./routes/profile";
import { connectionsRouter } from "./routes/connections";
import { chatRouter } from "./routes/chat";
import { draftsRouter } from "./routes/drafts";
import { databaseRouter } from "./routes/database";
import { workspacesRouter } from "./routes/workspaces";
import { skillsRouter } from "./routes/skills";
import {
  approvalsStore,
  auditsStore,
  eventsStore,
  skillRunsStore,
} from "./lib/store";
import {
  resolveRequestContext,
  sendContextError,
} from "./lib/workspace/request-context";
import { jobs, registerCronJobs, runJob } from "./scheduler";

const app = express();
const PORT = Number(process.env.PORT ?? 4000);
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

app.use(cors({ origin: FRONTEND_URL }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "marketpilot-backend" });
});

app.use("/api/agent", agentRouter);
app.use("/api/approvals", approvalsRouter);
app.use("/api/tool-calls", toolCallsRouter);
app.use("/api/profile", profileRouter);
app.use("/api/connections", connectionsRouter);
app.use("/api/chat", chatRouter);
app.use("/api/drafts", draftsRouter);
app.use("/api/database", databaseRouter);
app.use("/api/workspaces", workspacesRouter);
app.use("/api/skills", skillsRouter);

// Step 6 — scheduler dev endpoints.
app.get("/api/scheduler/jobs", (_req, res) => {
  res.json({
    jobs: Object.values(jobs).map((j) => ({
      id: j.id,
      cron: j.cron,
      description: j.description,
    })),
  });
});

app.post("/api/scheduler/run/:jobId", async (req, res) => {
  try {
    const result = await runJob(req.params.jobId);
    res.json(result);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "unknown",
    });
  }
});

// Tiny count endpoint for the sidebar pending badge (cheap to poll).
app.get("/api/approvals-count", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  res.json({
    pending: approvalsStore.list(ctx.workspaceId, "pending").length,
  });
});

// Temporary read-only event log endpoint so we can verify tier-gate decisions
// during Step 2 testing. Will move to its own router at Step 6+ once an
// /api/events spec is settled.
app.get("/api/events", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const limit = Number(req.query.limit ?? 50);
  res.json({ events: eventsStore.tail(limit, ctx.workspaceId) });
});

// Step 7 — runs feed for the dashboard. Returns runs newest first, optionally
// filtered by status (?status=running|completed|failed).
app.get("/api/skill-runs", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const status = req.query.status as
    | "running"
    | "completed"
    | "failed"
    | undefined;
  const runs = skillRunsStore
    .list()
    .filter((r) => r.workspaceId === ctx.workspaceId)
    .filter((r) => !status || r.status === status)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ skillRuns: runs });
});

// Aggregated counters for the dashboard stat cards.
app.get("/api/dashboard-stats", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const runs = skillRunsStore.list().filter((r) => r.workspaceId === ctx.workspaceId);
  const approvals = approvalsStore.list(ctx.workspaceId);
  const audits = auditsStore.list(ctx.workspaceId);
  // "this week" cutoff
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  res.json({
    activeCampaigns: new Set(
      runs.filter((r) => r.campaignId).map((r) => r.campaignId),
    ).size,
    agentsRunning: runs.filter((r) => r.status === "running").length,
    pendingApprovals: approvals.filter((a) => a.status === "pending").length,
    draftsThisWeek: runs
      .filter((r) => r.createdAt >= weekAgo)
      .reduce((sum, r) => sum + r.drafts.length, 0),
    auditsTotal: audits.length,
    runsThisWeek: runs.filter((r) => r.createdAt >= weekAgo).length,
  });
});

// Step 3 — read-only audits endpoint. Powers the future Audits screen.
app.get("/api/audits", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  res.json({ audits: auditsStore.list(ctx.workspaceId) });
});

app.get("/api/audits/:id", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const audit = auditsStore.get(req.params.id);
  if (!audit) return res.status(404).json({ error: "Audit not found." });
  if (audit.workspaceId !== ctx.workspaceId) {
    return res.status(404).json({ error: "Audit not found." });
  }
  res.json(audit);
});

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
  console.log(`CORS allowed origin: ${FRONTEND_URL}`);
  registerCronJobs();
});
