const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

const DEFAULT_HEADERS = {
  "x-user-id": "user_devansh",
  "x-workspace-id": "ws_default",
};

const DEFAULT_WORKSPACE_ID = "ws_default";

export type ConnectionStatus = "active" | "expired" | "error" | "pending";

export type ConnectionType =
  | "site"
  | "ga4"
  | "gsc"
  | "google_ads"
  | "meta_ads"
  | "linkedin_ads"
  | "github"
  | "wordpress"
  | "webflow"
  | "email";

export type ConnectionRecord = {
  id: string;
  workspaceId: string;
  type: ConnectionType;
  configJson: Record<string, unknown>;
  status: ConnectionStatus;
  lastSyncedAt?: string;
};

export type GitHubOAuthSettings = {
  configured: boolean;
  clientId?: string;
  callbackUrl: string;
  scopes: string[];
  setupMessage?: string;
  connectedAccount?: string;
  hasToken: boolean;
};

export type GitHubRepository = {
  id: number;
  name: string;
  fullName: string;
  owner: string;
  repo: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
  canPush: boolean;
};

export type GitHubConnectionHealthCheck = {
  key: "account" | "repo" | "branch" | "write";
  label: string;
  ok: boolean;
  detail: string;
};

export type GitHubConnectionHealth = {
  ok: boolean;
  checkedAt: string;
  owner: string;
  repo: string;
  branch: string;
  tokenSource: "oauth" | "env" | "unknown";
  summary: string;
  checks: GitHubConnectionHealthCheck[];
};

export type BriefFieldType =
  | "text"
  | "textarea"
  | "url"
  | "select"
  | "number";

export type BriefField = {
  key: string;
  label: string;
  type: BriefFieldType;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  options?: string[];
};

export type SkillOption = {
  id: string;
  displayName: string;
  tagline: string;
  category: string;
  maturity: "draft-only" | "guided" | "executable" | "autonomous-safe";
  briefFields: BriefField[];
  comingSoonNote?: string;
};

export type AgentStartInput = {
  skillId: string;
  brief: Record<string, string>;
};

export type AgentStartResult = {
  taskId: string;
  status: string;
};

export async function listSkills(): Promise<SkillOption[]> {
  const data = await apiFetch<{ skills: SkillOption[] }>("/api/skills");
  return data.skills;
}

export async function startAgentRun(
  input: AgentStartInput,
): Promise<AgentStartResult> {
  return apiFetch<AgentStartResult>("/api/agent/start", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function listConnections(): Promise<ConnectionRecord[]> {
  const data = await apiFetch<{ connections: ConnectionRecord[] }>("/api/connections");
  return data.connections;
}

export async function createConnection(input: {
  type: ConnectionType;
  configJson: Record<string, unknown>;
}): Promise<ConnectionRecord> {
  return apiFetch<ConnectionRecord>("/api/connections", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateConnection(
  id: string,
  input: {
    configJson?: Record<string, unknown>;
    status?: ConnectionStatus;
  },
): Promise<ConnectionRecord> {
  return apiFetch<ConnectionRecord>(`/api/connections/${id}`, {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function getGitHubOAuthSettings(): Promise<GitHubOAuthSettings> {
  return apiFetch<GitHubOAuthSettings>("/api/connections/github/oauth/settings");
}

export function githubOAuthStartUrl(): string {
  const returnTo =
    typeof window === "undefined" ? "http://localhost:3000" : window.location.href;
  const url = new URL(`${BACKEND_URL}/api/connections/github/oauth/start`);
  url.searchParams.set("workspaceId", DEFAULT_WORKSPACE_ID);
  url.searchParams.set("returnTo", returnTo);
  return url.toString();
}

export async function listGitHubRepositories(): Promise<GitHubRepository[]> {
  const data = await apiFetch<{ repositories: GitHubRepository[] }>(
    "/api/connections/github/repos",
  );
  return data.repositories;
}

export async function checkGitHubConnectionHealth(): Promise<GitHubConnectionHealth> {
  return apiFetch<GitHubConnectionHealth>("/api/connections/github/health-check", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function disconnectGitHub(): Promise<ConnectionRecord> {
  return apiFetch<ConnectionRecord>("/api/connections/github/disconnect", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      ...DEFAULT_HEADERS,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!res.ok) {
    const message = await readErrorMessage(res);
    throw new Error(message || `HTTP ${res.status}`);
  }

  return (await res.json()) as T;
}

async function readErrorMessage(res: Response): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? "";
  } catch {
    return "";
  }
}
