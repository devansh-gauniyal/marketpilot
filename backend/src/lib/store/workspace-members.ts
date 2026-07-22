import { DEFAULT_USER_ID } from "./users";
import { DEFAULT_WORKSPACE_ID } from "./workspaces";
import type { WorkspaceMembership, WorkspaceRole } from "./types";
import { getJson, listJson, putJson } from "./sqlite";

const defaultMembershipId = `${DEFAULT_USER_ID}:${DEFAULT_WORKSPACE_ID}`;

const defaultMembership: WorkspaceMembership = {
  id: defaultMembershipId,
  userId: DEFAULT_USER_ID,
  workspaceId: DEFAULT_WORKSPACE_ID,
  role: "owner",
  createdAt: new Date().toISOString(),
};

if (!getJson<WorkspaceMembership>("workspace_members", defaultMembershipId)) {
  putJson("workspace_members", defaultMembershipId, defaultMembership, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    status: defaultMembership.role,
    createdAt: defaultMembership.createdAt,
  });
}

export const workspaceMembersStore = {
  add(input: {
    userId: string;
    workspaceId: string;
    role: WorkspaceRole;
  }): WorkspaceMembership {
    const membership: WorkspaceMembership = {
      id: `${input.userId}:${input.workspaceId}`,
      userId: input.userId,
      workspaceId: input.workspaceId,
      role: input.role,
      createdAt: new Date().toISOString(),
    };
    return putJson("workspace_members", membership.id, membership, {
      workspaceId: membership.workspaceId,
      status: membership.role,
      createdAt: membership.createdAt,
    });
  },

  get(userId: string, workspaceId: string): WorkspaceMembership | undefined {
    return getJson<WorkspaceMembership>("workspace_members", `${userId}:${workspaceId}`);
  },

  listForUser(userId: string): WorkspaceMembership[] {
    return listJson<WorkspaceMembership>("workspace_members").filter(
      (membership) => membership.userId === userId,
    );
  },

  listForWorkspace(workspaceId: string): WorkspaceMembership[] {
    return listJson<WorkspaceMembership>("workspace_members", { workspaceId });
  },

  hasAccess(userId: string, workspaceId: string): boolean {
    return this.get(userId, workspaceId) !== undefined;
  },
};
