// Connections store. Holds the workspace's links to external services
// (site URL, GA4, GSC, Meta Ads, WordPress, etc.). Connectors read config
// from here; the actual transport lives under lib/connectors/.

import type { Connection, ConnectionType } from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspaces";
import { getJson, listJson, putJson } from "./sqlite";

// Seed default connections so the UI has something to display. These represent
// "intent" — the user added them — not actual auth. Real OAuth flows land
// per-connector. Status flips to "active" only when credentials exist.
const seed: Array<{ id: string; type: Connection["type"]; configJson: Record<string, unknown>; status: Connection["status"] }> = [
  {
    id: "conn_default_site",
    type: "site",
    configJson: {
      url: process.env.SCHEDULED_AUDIT_URL ?? "https://example.com",
      label: "Primary site",
      isPrimary: true,
    },
    status: "active",
  },
  { id: "conn_default_ga4", type: "ga4", configJson: { propertyId: "" }, status: "pending" },
  { id: "conn_default_gsc", type: "gsc", configJson: { siteUrl: "" }, status: "pending" },
  {
    id: "conn_default_github",
    type: "github",
    configJson: { owner: process.env.GITHUB_OWNER ?? "", repo: process.env.GITHUB_REPO ?? "" },
    status: process.env.GITHUB_TOKEN && process.env.GITHUB_OWNER && process.env.GITHUB_REPO ? "active" : "pending",
  },
  { id: "conn_default_meta_ads", type: "meta_ads", configJson: {}, status: "pending" },
  { id: "conn_default_wordpress", type: "wordpress", configJson: { siteUrl: "" }, status: "pending" },
  { id: "conn_default_email", type: "email", configJson: { provider: "resend" }, status: "pending" },
];

for (const s of seed) {
  if (getJson<Connection>("connections", s.id)) continue;
  const connection: Connection = {
    id: s.id,
    workspaceId: DEFAULT_WORKSPACE_ID,
    type: s.type,
    configJson: s.configJson,
    status: s.status,
    lastSyncedAt: s.status === "active" ? new Date().toISOString() : undefined,
  };
  putJson("connections", connection.id, connection, {
    workspaceId: connection.workspaceId,
    status: connection.status,
    type: connection.type,
  });
}

export const connectionsStore = {
  create(input: Omit<Connection, "id">): Connection {
    const conn: Connection = { id: crypto.randomUUID(), ...input };
    return putJson("connections", conn.id, conn, {
      workspaceId: conn.workspaceId,
      status: conn.status,
      type: conn.type,
    });
  },

  get(id: string): Connection | undefined {
    return getJson<Connection>("connections", id);
  },

  list(workspaceId: string = DEFAULT_WORKSPACE_ID): Connection[] {
    return listJson<Connection>("connections", { workspaceId });
  },

  listAll(): Connection[] {
    return listJson<Connection>("connections");
  },

  findByType(
    type: ConnectionType,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): Connection | undefined {
    return listJson<Connection>("connections", { workspaceId, type })[0];
  },

  findGithubOAuthState(state: string): Connection | undefined {
    return listJson<Connection>("connections", { type: "github" }).find(
      (connection) => connection.configJson.oauthState === state,
    );
  },

  update(id: string, updates: Partial<Connection>): Connection | undefined {
    const conn = this.get(id);
    if (!conn) return undefined;
    const next = { ...conn, ...updates };
    return putJson("connections", id, next, {
      workspaceId: next.workspaceId,
      status: next.status,
      type: next.type,
    });
  },
};
