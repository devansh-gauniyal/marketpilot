// /api/connections — list / create / update / delete the workspace's external
// service connections (site URL, GA4, GSC, Meta Ads, WordPress, GitHub, ...).
//
// Site and repo details live here so each workspace can point the agent at
// different websites/codebases. GitHub OAuth tokens are stored encrypted and
// redacted before anything is returned to the frontend.

import crypto from "node:crypto";
import { Router } from "express";
import {
  connectionsStore,
  type Connection,
  type ConnectionType,
} from "../lib/store";
import {
  resolveRequestContext,
  sendContextError,
} from "../lib/workspace/request-context";
import {
  redactConnection,
  sanitizeConnectionConfig,
  siteConfigFromConnection,
} from "../lib/connections/workspace-connections";
import {
  buildGitHubAuthorizeUrl,
  checkGitHubRepositoryHealth,
  exchangeGitHubOAuthCode,
  fetchGitHubViewer,
  githubOAuthSettings,
  listGitHubRepositories,
} from "../lib/connectors/github/oauth";
import { decryptSecret, encryptSecret } from "../lib/security/secrets";

export const connectionsRouter = Router();
const FRONTEND_URL = process.env.FRONTEND_URL ?? "http://localhost:3000";

const CONNECTION_TYPES: ConnectionType[] = [
  "site",
  "ga4",
  "gsc",
  "google_ads",
  "meta_ads",
  "linkedin_ads",
  "github",
  "wordpress",
  "webflow",
  "email",
];

connectionsRouter.get("/", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  res.json({
    connections: connectionsStore.list(ctx.workspaceId).map(redactConnection),
  });
});

connectionsRouter.post("/", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const body = req.body ?? {};
  if (!CONNECTION_TYPES.includes(body.type)) {
    return res.status(400).json({ error: `Unknown connection type: ${body.type}` });
  }
  const configJson = sanitizeConnectionConfig(body.type, body.configJson);
  if (body.type === "site") {
    const candidate = {
      id: "candidate",
      workspaceId: ctx.workspaceId,
      type: "site" as const,
      configJson,
      status: "active" as const,
    };
    if (!siteConfigFromConnection(candidate)) {
      return res.status(400).json({ error: "Site connection requires a valid http(s) URL." });
    }
    if (configJson.isPrimary === true) {
      clearOtherPrimarySites(ctx.workspaceId);
    }
  }
  const githubReady = body.type === "github" && githubConfigReady(configJson);
  const conn = connectionsStore.create({
    workspaceId: ctx.workspaceId,
    type: body.type,
    configJson,
    status: body.type === "github" && !githubReady ? "pending" : "active",
    lastSyncedAt: body.type === "github" && !githubReady ? undefined : new Date().toISOString(),
  });
  res.json(redactConnection(conn));
});

connectionsRouter.get("/github/oauth/settings", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const connection = connectionsStore.findByType("github", ctx.workspaceId);
  res.json({
    ...githubOAuthSettings(),
    connectedAccount: readConfigString(connection?.configJson.connectedAccount),
    hasToken: !!githubTokenForConnection(connection),
  });
});

connectionsRouter.get("/github/oauth/start", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const settings = githubOAuthSettings();
  const returnTo = safeReturnTo(readQueryString(req.query.returnTo));
  if (!settings.configured) {
    return res.redirect(withGithubStatus(returnTo, "setup_required"));
  }

  const state = crypto.randomUUID();
  const existing = connectionsStore.findByType("github", ctx.workspaceId);
  const nextConfig = {
    ...(existing?.configJson ?? {}),
    oauthState: state,
    oauthStartedAt: new Date().toISOString(),
    oauthReturnTo: returnTo,
    tokenSource: "oauth",
  };

  if (existing) {
    connectionsStore.update(existing.id, {
      configJson: nextConfig,
      status: "pending",
    });
  } else {
    connectionsStore.create({
      workspaceId: ctx.workspaceId,
      type: "github",
      configJson: nextConfig,
      status: "pending",
    });
  }

  res.redirect(buildGitHubAuthorizeUrl(state));
});

connectionsRouter.get("/github/oauth/callback", async (req, res) => {
  const state = readQueryString(req.query.state);
  const code = readQueryString(req.query.code);
  const oauthError = readQueryString(req.query.error);
  const connection = state ? connectionsStore.findGithubOAuthState(state) : undefined;
  const returnTo = safeReturnTo(readConfigString(connection?.configJson.oauthReturnTo));

  if (!connection) {
    return res.redirect(withGithubStatus(returnTo, "state_error"));
  }

  if (oauthError || !code) {
    connectionsStore.update(connection.id, {
      status: "error",
      configJson: clearOAuthState(connection.configJson),
    });
    return res.redirect(withGithubStatus(returnTo, "denied"));
  }

  try {
    const token = await exchangeGitHubOAuthCode(code);
    const viewer = await fetchGitHubViewer(token.accessToken);
    const configJson = {
      ...clearOAuthState(connection.configJson),
      accessTokenEncrypted: encryptSecret(token.accessToken),
      tokenSource: "oauth",
      connectedAccount: viewer.login,
      connectedAt: new Date().toISOString(),
      scopes: token.scopes,
    };

    connectionsStore.update(connection.id, {
      configJson,
      status: githubConfigReady(configJson) ? "active" : "pending",
      lastSyncedAt: new Date().toISOString(),
    });
    return res.redirect(withGithubStatus(returnTo, "connected"));
  } catch {
    connectionsStore.update(connection.id, {
      status: "error",
      configJson: clearOAuthState(connection.configJson),
    });
    return res.redirect(withGithubStatus(returnTo, "error"));
  }
});

connectionsRouter.get("/github/repos", async (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const connection = connectionsStore.findByType("github", ctx.workspaceId);
  const token = githubTokenForConnection(connection);
  if (!token) {
    return res.status(400).json({
      error: "Connect GitHub first, or set GITHUB_TOKEN for local development.",
    });
  }

  try {
    const repositories = await listGitHubRepositories(token);
    res.json({ repositories });
  } catch (err) {
    res.status(502).json({
      error: err instanceof Error ? err.message : "Could not load GitHub repositories.",
    });
  }
});

connectionsRouter.post("/github/health-check", async (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const connection = connectionsStore.findByType("github", ctx.workspaceId);
  const token = githubTokenForConnection(connection);
  const owner = readConfigString(connection?.configJson.owner);
  const repo = readConfigString(connection?.configJson.repo);
  const branch = readConfigString(connection?.configJson.defaultBranch) ?? "main";
  const tokenSource =
    readConfigString(connection?.configJson.tokenSource) === "oauth"
      ? "oauth"
      : process.env.GITHUB_TOKEN
        ? "env"
        : "unknown";

  if (!connection || !token || !owner || !repo) {
    return res.status(400).json({
      error: "Save a GitHub repo and connect GitHub before running the health check.",
    });
  }

  try {
    const health = await checkGitHubRepositoryHealth({
      accessToken: token,
      owner,
      repo,
      branch,
      tokenSource,
    });
    connectionsStore.update(connection.id, {
      status: health.ok ? "active" : "error",
      lastSyncedAt: health.checkedAt,
      configJson: {
        ...connection.configJson,
        healthStatus: health.ok ? "ready" : "attention",
        healthSummary: health.summary,
        healthCheckedAt: health.checkedAt,
      },
    });
    res.json(health);
  } catch (err) {
    connectionsStore.update(connection.id, {
      status: "error",
      configJson: {
        ...connection.configJson,
        healthStatus: "attention",
        healthSummary: err instanceof Error ? err.message : "GitHub health check failed.",
        healthCheckedAt: new Date().toISOString(),
      },
    });
    res.status(502).json({
      error: err instanceof Error ? err.message : "GitHub health check failed.",
    });
  }
});

connectionsRouter.post("/github/disconnect", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const connection = connectionsStore.findByType("github", ctx.workspaceId);
  if (!connection) {
    return res.status(404).json({ error: "GitHub connection not found." });
  }

  const configJson = clearGitHubToken(connection.configJson);
  const updated = connectionsStore.update(connection.id, {
    configJson,
    status: process.env.GITHUB_TOKEN && githubConfigReady(configJson) ? "active" : "pending",
    lastSyncedAt: undefined,
  });
  res.json(redactConnection(updated ?? connection));
});

connectionsRouter.put("/:id", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const body = req.body ?? {};
  const current = connectionsStore.get(req.params.id);
  if (!current || current.workspaceId !== ctx.workspaceId) {
    return res.status(404).json({ error: "Connection not found." });
  }

  const updates: Partial<Connection> = {};
  if (typeof body.status === "string") updates.status = body.status as Connection["status"];
  if (typeof body.configJson === "object") {
    const publicConfig = sanitizeConnectionConfig(current.type, body.configJson);
    const configJson =
      current.type === "github"
        ? preserveGitHubPrivateConfig(current.configJson, publicConfig)
        : publicConfig;
    if (current.type === "site") {
      const candidate = { ...current, configJson };
      if (!siteConfigFromConnection(candidate)) {
        return res.status(400).json({ error: "Site connection requires a valid http(s) URL." });
      }
      if (configJson.isPrimary === true) {
        clearOtherPrimarySites(ctx.workspaceId, current.id);
      }
    }
    updates.configJson = configJson;
    if (
      current.type === "github" &&
      githubConfigReady(configJson) &&
      updates.status === undefined
    ) {
      updates.status = "active";
      updates.lastSyncedAt = new Date().toISOString();
    }
  }
  if (typeof body.lastSyncedAt === "string") updates.lastSyncedAt = body.lastSyncedAt;
  const conn = connectionsStore.update(req.params.id, updates);
  if (!conn) return res.status(404).json({ error: "Connection not found." });
  res.json(redactConnection(conn));
});

function clearOtherPrimarySites(workspaceId: string, exceptId?: string): void {
  for (const connection of connectionsStore.list(workspaceId)) {
    if (connection.id === exceptId) continue;
    if (connection.type !== "site") continue;
    if (connection.configJson.isPrimary !== true) continue;

    connectionsStore.update(connection.id, {
      configJson: {
        ...connection.configJson,
        isPrimary: false,
      },
    });
  }
}

function githubConfigReady(configJson: Record<string, unknown>): boolean {
  return (
    typeof configJson.owner === "string" &&
    configJson.owner.trim().length > 0 &&
    typeof configJson.repo === "string" &&
    configJson.repo.trim().length > 0 &&
    (!!decryptSecret(configJson.accessTokenEncrypted) || !!process.env.GITHUB_TOKEN)
  );
}

function githubTokenForConnection(connection: Connection | undefined): string | undefined {
  return decryptSecret(connection?.configJson.accessTokenEncrypted) ?? process.env.GITHUB_TOKEN?.trim();
}

function preserveGitHubPrivateConfig(
  current: Record<string, unknown>,
  publicConfig: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...publicConfig,
    accessTokenEncrypted: current.accessTokenEncrypted,
    tokenSource: current.tokenSource ?? publicConfig.tokenSource,
    connectedAccount: current.connectedAccount ?? publicConfig.connectedAccount,
    connectedAt: current.connectedAt ?? publicConfig.connectedAt,
    scopes: current.scopes ?? publicConfig.scopes,
  };
}

function clearOAuthState(configJson: Record<string, unknown>): Record<string, unknown> {
  const { oauthState, oauthStartedAt, oauthReturnTo, ...rest } = configJson;
  void oauthState;
  void oauthStartedAt;
  void oauthReturnTo;
  return rest;
}

function clearGitHubToken(configJson: Record<string, unknown>): Record<string, unknown> {
  const {
    accessTokenEncrypted,
    connectedAccount,
    connectedAt,
    scopes,
    tokenSource,
    ...rest
  } = clearOAuthState(configJson);
  void accessTokenEncrypted;
  void connectedAccount;
  void connectedAt;
  void scopes;
  void tokenSource;
  return rest;
}

function readQueryString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readConfigString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function safeReturnTo(value: string | undefined): string {
  if (!value) return FRONTEND_URL;
  try {
    const candidate = new URL(value);
    const allowed = new URL(FRONTEND_URL);
    return candidate.origin === allowed.origin ? candidate.toString() : FRONTEND_URL;
  } catch {
    return FRONTEND_URL;
  }
}

function withGithubStatus(returnTo: string, status: string): string {
  const url = new URL(returnTo);
  url.searchParams.set("github", status);
  return url.toString();
}
