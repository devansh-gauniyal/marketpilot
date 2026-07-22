// Workspaces store. We're single-tenant for now, so this seeds one default
// workspace and exposes its id as a constant the rest of the code can pass
// around. When auth lands, swap in a real lookup.

import type { Workspace } from "./types";
import { getJson, listJson, putJson } from "./sqlite";

export const DEFAULT_WORKSPACE_ID = "ws_default";

// Seed the default workspace immediately so every other store can rely on it.
const defaultWorkspace: Workspace = {
  id: DEFAULT_WORKSPACE_ID,
  name: "MarketPilot",
  plan: "pro",
  createdAt: new Date().toISOString(),
};

if (!getJson<Workspace>("workspaces", DEFAULT_WORKSPACE_ID)) {
  putJson("workspaces", DEFAULT_WORKSPACE_ID, defaultWorkspace, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    createdAt: defaultWorkspace.createdAt,
  });
}

export const workspacesStore = {
  create(input: {
    id?: string;
    name: string;
    plan?: Workspace["plan"];
  }): Workspace {
    const workspace: Workspace = {
      id: input.id ?? crypto.randomUUID(),
      name: input.name,
      plan: input.plan ?? "pro",
      createdAt: new Date().toISOString(),
    };
    return putJson("workspaces", workspace.id, workspace, {
      workspaceId: workspace.id,
      createdAt: workspace.createdAt,
    });
  },

  get(id: string): Workspace | undefined {
    return getJson<Workspace>("workspaces", id);
  },

  getDefault(): Workspace {
    return this.get(DEFAULT_WORKSPACE_ID) ?? defaultWorkspace;
  },

  list(): Workspace[] {
    return listJson<Workspace>("workspaces");
  },
};
