import { Router } from "express";
import {
  productProfileStore,
  workspaceMembersStore,
  workspacesStore,
} from "../lib/store";
import {
  resolveRequestContext,
  sendContextError,
} from "../lib/workspace/request-context";

export const workspacesRouter = Router();

workspacesRouter.get("/", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const workspaces = workspaceMembersStore
    .listForUser(ctx.userId)
    .map((membership) => ({
      membership,
      workspace: workspacesStore.get(membership.workspaceId),
    }))
    .filter((item) => item.workspace);

  res.json({
    currentWorkspaceId: ctx.workspaceId,
    user: ctx.user,
    workspaces,
  });
});

workspacesRouter.get("/current", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  res.json({
    user: ctx.user,
    workspace: ctx.workspace,
    membership: ctx.membership,
  });
});

workspacesRouter.post("/", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const body = req.body ?? {};
  const name = typeof body.name === "string" && body.name.trim()
    ? body.name.trim()
    : "";

  if (!name) {
    return res.status(400).json({ error: "Workspace name is required." });
  }

  const workspace = workspacesStore.create({
    name,
    plan: "pro",
  });
  const membership = workspaceMembersStore.add({
    userId: ctx.userId,
    workspaceId: workspace.id,
    role: "owner",
  });
  productProfileStore.ensure(workspace.id, name);

  res.status(201).json({ workspace, membership });
});
