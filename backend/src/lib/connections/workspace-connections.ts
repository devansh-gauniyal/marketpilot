import {
  connectionsStore,
  productProfileStore,
  type Connection,
} from "../store";
import type { RepoConnectionConfig } from "../connectors";
import { decryptSecret } from "../security/secrets";

export type SiteConnectionConfig = {
  url: string;
  label?: string;
  isPrimary: boolean;
};

export type GithubConnectionConfig = RepoConnectionConfig & {
  tokenSource: "env" | "oauth";
  connectedAccount?: string;
  scopes?: string[];
};

export function listWorkspaceSites(workspaceId: string): SiteConnectionConfig[] {
  return connectionsStore
    .list(workspaceId)
    .filter((connection) => connection.type === "site")
    .map(siteConfigFromConnection)
    .filter((site): site is SiteConnectionConfig => site !== undefined);
}

export function primaryWorkspaceSiteUrl(workspaceId: string): string | undefined {
  const sites = listWorkspaceSites(workspaceId);
  const primary = sites.find((site) => site.isPrimary) ?? sites[0];
  if (primary?.url) return primary.url;

  const profile = productProfileStore.get(workspaceId);
  return profile?.siteUrl;
}

export function workspaceGithubRepo(workspaceId: string): GithubConnectionConfig | undefined {
  const connection = connectionsStore
    .list(workspaceId)
    .filter((item) => item.type === "github")
    .find((item) => item.status === "active" || item.status === "pending");
  const config = connection ? githubConfigFromConnection(connection) : undefined;
  if (config?.accessToken) return config;
  if (config && process.env.GITHUB_TOKEN?.trim()) {
    return {
      ...config,
      accessToken: process.env.GITHUB_TOKEN.trim(),
      tokenSource: "env",
    };
  }

  const owner = process.env.GITHUB_OWNER?.trim();
  const repo = process.env.GITHUB_REPO?.trim();
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!owner || !repo || !token) return undefined;
  if (owner === "demo-owner" || repo === "demo-repo") return undefined;
  return { owner, repo, accessToken: token, tokenSource: "env" };
}

export function siteConfigFromConnection(
  connection: Connection,
): SiteConnectionConfig | undefined {
  const url = readString(connection.configJson.url);
  if (!url || !/^https?:\/\//.test(url)) return undefined;
  return {
    url,
    label: readString(connection.configJson.label),
    isPrimary: connection.configJson.isPrimary === true,
  };
}

export function githubConfigFromConnection(
  connection: Connection,
): GithubConnectionConfig | undefined {
  const owner = readString(connection.configJson.owner);
  const repo = readString(connection.configJson.repo);
  if (!owner || !repo) return undefined;
  const accessToken = decryptSecret(connection.configJson.accessTokenEncrypted);
  const tokenSource = accessToken ? "oauth" : "env";
  return {
    owner,
    repo,
    defaultBranch: readString(connection.configJson.defaultBranch),
    accessToken,
    tokenSource,
    connectedAccount: readString(connection.configJson.connectedAccount),
    scopes: readStringArray(connection.configJson.scopes),
  };
}

export function sanitizeConnectionConfig(
  type: Connection["type"],
  configJson: unknown,
): Record<string, unknown> {
  const config = isRecord(configJson) ? configJson : {};
  if (type === "github") {
    return {
      owner: readString(config.owner) ?? "",
      repo: readString(config.repo) ?? "",
      defaultBranch: readString(config.defaultBranch),
      connectedAccount: readString(config.connectedAccount),
      tokenSource: readString(config.tokenSource),
      scopes: readStringArray(config.scopes),
      connectedAt: readString(config.connectedAt),
      healthStatus: readString(config.healthStatus),
      healthSummary: readString(config.healthSummary),
      healthCheckedAt: readString(config.healthCheckedAt),
    };
  }
  if (type === "site") {
    return {
      url: readString(config.url) ?? "",
      label: readString(config.label),
      isPrimary: config.isPrimary === true,
    };
  }
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !isSecretKey(key)),
  );
}

export function redactConnection(connection: Connection): Connection {
  return {
    ...connection,
    configJson: sanitizeConnectionConfig(connection.type, connection.configJson),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  return strings.length > 0 ? strings.map((item) => item.trim()) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  return /token|secret|password|api[_-]?key|refresh/i.test(key);
}
