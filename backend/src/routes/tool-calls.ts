// Step 5 — Tool-calls route. Lists every persisted tool call (today only
// rollbackable YELLOW writes land here) and exposes a rollback action.
//
//   GET  /api/tool-calls                 list, newest first
//   GET  /api/tool-calls/:id             read one
//   POST /api/tool-calls/:id/verify      re-check that the write landed
//   POST /api/tool-calls/:id/rollback    invoke the rollback path for this call

import { Router } from "express";
import { eventsStore, skillRunsStore, toolCallsStore } from "../lib/store";
import { rollbackToolCall, verifyToolCall } from "../lib/agent-tools";
import {
  resolveRequestContext,
  sendContextError,
} from "../lib/workspace/request-context";

export const toolCallsRouter = Router();

// GET /api/tool-calls
toolCallsRouter.get("/", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const calls = toolCallsStore
    .listAll()
    .filter((call) => skillRunsStore.get(call.skillRunId)?.workspaceId === ctx.workspaceId);
  calls.sort((a, b) => ((a.executedAt ?? "") < (b.executedAt ?? "") ? 1 : -1));
  res.json({ toolCalls: calls });
});

// GET /api/tool-calls/:id
toolCallsRouter.get("/:id", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const call = toolCallsStore.get(req.params.id);
  if (!call) return res.status(404).json({ error: "Tool call not found." });
  if (skillRunsStore.get(call.skillRunId)?.workspaceId !== ctx.workspaceId) {
    return res.status(404).json({ error: "Tool call not found." });
  }
  res.json(call);
});

// POST /api/tool-calls/:id/verify
toolCallsRouter.post("/:id/verify", async (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const call = toolCallsStore.get(req.params.id);
  if (!call) return res.status(404).json({ error: "Tool call not found." });
  if (skillRunsStore.get(call.skillRunId)?.workspaceId !== ctx.workspaceId) {
    return res.status(404).json({ error: "Tool call not found." });
  }
  if (call.status !== "executed") {
    return res
      .status(409)
      .json({ error: `Cannot verify a call with status='${call.status}'.` });
  }

  const result = await verifyToolCall(call.toolName, call.inputJson);
  const outputJson = mergeOutputJson(call.outputJson, {
    verification: result.details ?? null,
  });
  const updated = toolCallsStore.update(call.id, {
    verified: result.success,
    verificationResult: result.result,
    outputJson,
  });

  eventsStore.append("tool_verified", {
    toolCallId: call.id,
    toolName: call.toolName,
    success: result.success,
    impact: readVerificationImpact(result.details),
  }, ctx.workspaceId);

  res.json({ success: result.success, result: result.result, toolCall: updated });
});

// POST /api/tool-calls/:id/rollback
toolCallsRouter.post("/:id/rollback", async (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const call = toolCallsStore.get(req.params.id);
  if (!call) return res.status(404).json({ error: "Tool call not found." });
  if (skillRunsStore.get(call.skillRunId)?.workspaceId !== ctx.workspaceId) {
    return res.status(404).json({ error: "Tool call not found." });
  }
  if (call.status !== "executed") {
    return res
      .status(409)
      .json({ error: `Cannot roll back a call with status='${call.status}'.` });
  }
  if (call.rollbackPayloadJson === undefined || call.rollbackPayloadJson === null) {
    return res
      .status(400)
      .json({ error: "This tool call has no rollback payload." });
  }

  const result = await rollbackToolCall(call.toolName, call.rollbackPayloadJson);
  const updated = toolCallsStore.update(call.id, {
    status: result.success ? "rolled_back" : "failed",
    verificationResult: result.result,
  });

  eventsStore.append("tool_rolled_back", {
    toolCallId: call.id,
    toolName: call.toolName,
    success: result.success,
  }, ctx.workspaceId);

  res.json({ result: result.result, toolCall: updated });
});

function readVerificationImpact(details: unknown): unknown {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return undefined;
  }
  return (details as Record<string, unknown>).impact;
}

function mergeOutputJson(
  current: unknown,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    return updates;
  }
  return { ...(current as Record<string, unknown>), ...updates };
}
