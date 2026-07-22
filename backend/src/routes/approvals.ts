// Step 4 — Approvals inbox endpoints.
//
//   GET  /api/approvals                 list (optional ?status=pending|approved|rejected)
//   GET  /api/approvals/:id             read one
//   POST /api/approvals/:id/decide      body: { approved: boolean, note?: string }
//
// These read from the first-class approvals store. Approval records are created
// in two places:
//   1. The tier gate (lib/agent/tier-gate.ts) — when a RED-tier tool is blocked.
//   2. The agent loop (lib/agent-loop.ts) — when a skill run finishes with
//      proposedActions, each one becomes a pending Approval here.

import { Router } from "express";
import { approvalsStore, type Approval } from "../lib/store";
import {
  executeApprovedSeoFixApproval,
  rejectSeoFixApproval,
} from "../lib/agent/seo-orchestrator";
import {
  resolveRequestContext,
  sendContextError,
} from "../lib/workspace/request-context";

export const approvalsRouter = Router();

// GET /api/approvals
approvalsRouter.get("/", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const status = req.query.status as Approval["status"] | undefined;
  const approvals = approvalsStore.list(ctx.workspaceId, status);
  // newest first
  approvals.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ approvals });
});

// GET /api/approvals/:id
approvalsRouter.get("/:id", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const approval = approvalsStore.get(req.params.id);
  if (!approval) return res.status(404).json({ error: "Approval not found." });
  if (approval.workspaceId !== ctx.workspaceId) {
    return res.status(404).json({ error: "Approval not found." });
  }
  res.json(approval);
});

// POST /api/approvals/:id/decide
approvalsRouter.post("/:id/decide", async (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const body = req.body ?? {};
  if (typeof body.approved !== "boolean") {
    return res.status(400).json({ error: "approved (boolean) is required." });
  }
  const status: Approval["status"] = body.approved ? "approved" : "rejected";
  const note = typeof body.note === "string" ? body.note : undefined;
  const existing = approvalsStore.get(req.params.id);

  if (!existing || existing.workspaceId !== ctx.workspaceId || existing.status !== "pending") {
    return res
      .status(404)
      .json({ error: "Approval not found or already decided." });
  }

  let execution:
    | { ok: boolean; prUrl?: string; error?: string }
    | undefined;

  if (isSeoPrApproval(existing.proposedActionJson) && status === "approved") {
    execution = await executeApprovedSeoFixApproval(existing);
    if (!execution.ok) {
      const approval = approvalsStore.get(existing.id) ?? existing;
      return res.status(502).json({ approval, execution });
    }
  } else if (isSeoPrApproval(existing.proposedActionJson)) {
    rejectSeoFixApproval(existing);
  }

  const updated = approvalsStore.decide(
    req.params.id,
    status,
    ctx.userId,
    execution?.prUrl ? `Opened PR ${execution.prUrl}` : note,
  );

  const approval = updated ?? approvalsStore.get(existing.id) ?? existing;
  res.json({ approval, execution });
});

function isSeoPrApproval(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "type" in value &&
    value.type === "seo_pr_approval"
  );
}
