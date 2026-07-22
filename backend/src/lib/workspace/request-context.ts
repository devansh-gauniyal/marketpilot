import type { Request, Response } from "express";
import {
  DEFAULT_USER_ID,
  DEFAULT_WORKSPACE_ID,
  usersStore,
  workspaceMembersStore,
  workspacesStore,
  type User,
  type Workspace,
  type WorkspaceMembership,
} from "../store";

export type RequestContext = {
  userId: string;
  workspaceId: string;
  user: User;
  workspace: Workspace;
  membership: WorkspaceMembership;
};

type RequestContextError = {
  error: {
    status: number;
    message: string;
  };
};

export function resolveRequestContext(req: Request): RequestContext | RequestContextError {
  const userId = readStringHeader(req, "x-user-id") ?? DEFAULT_USER_ID;
  const user = usersStore.get(userId);
  if (!user) {
    return { error: { status: 401, message: "Unknown user." } };
  }

  const requestedWorkspaceId =
    readStringHeader(req, "x-workspace-id") ??
    readWorkspaceIdFromQuery(req) ??
    readWorkspaceIdFromBody(req);

  const workspaceId = requestedWorkspaceId ?? firstWorkspaceForUser(user.id) ?? DEFAULT_WORKSPACE_ID;
  const workspace = workspacesStore.get(workspaceId);
  if (!workspace) {
    return { error: { status: 404, message: "Workspace not found." } };
  }

  const membership = workspaceMembersStore.get(user.id, workspace.id);
  if (!membership) {
    return { error: { status: 403, message: "User does not have access to this workspace." } };
  }

  return {
    userId: user.id,
    workspaceId: workspace.id,
    user,
    workspace,
    membership,
  };
}

export function sendContextError(
  res: Response,
  result: RequestContext | RequestContextError,
): result is RequestContextError {
  if (!("error" in result)) return false;
  res.status(result.error.status).json({ error: result.error.message });
  return true;
}

function firstWorkspaceForUser(userId: string): string | undefined {
  return workspaceMembersStore.listForUser(userId)[0]?.workspaceId;
}

function readStringHeader(req: Request, name: string): string | undefined {
  const value = req.header(name);
  return value?.trim() || undefined;
}

function readWorkspaceIdFromQuery(req: Request): string | undefined {
  return typeof req.query.workspaceId === "string" && req.query.workspaceId.trim()
    ? req.query.workspaceId.trim()
    : undefined;
}

function readWorkspaceIdFromBody(req: Request): string | undefined {
  const body = req.body as { workspaceId?: unknown } | undefined;
  return typeof body?.workspaceId === "string" && body.workspaceId.trim()
    ? body.workspaceId.trim()
    : undefined;
}
