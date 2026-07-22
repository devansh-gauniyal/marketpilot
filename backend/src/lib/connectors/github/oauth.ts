export type GitHubOAuthSettings = {
  configured: boolean;
  clientId?: string;
  callbackUrl: string;
  scopes: string[];
  setupMessage?: string;
};

export type GitHubOAuthToken = {
  accessToken: string;
  tokenType: string;
  scopes: string[];
};

export type GitHubViewer = {
  login: string;
  avatarUrl?: string;
  profileUrl: string;
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

type GitHubTokenResponse = {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
};

type GitHubUserResponse = {
  login?: string;
  avatar_url?: string;
  html_url?: string;
  message?: string;
};

type GitHubRepoResponse = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  owner: {
    login: string;
  };
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
  };
};

type GitHubBranchResponse = {
  name?: string;
  commit?: {
    sha?: string;
  };
  message?: string;
};

export function githubOAuthSettings(): GitHubOAuthSettings {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  const callbackUrl =
    process.env.GITHUB_OAUTH_CALLBACK_URL?.trim() ??
    "http://localhost:4000/api/connections/github/oauth/callback";
  const scopes = (process.env.GITHUB_OAUTH_SCOPES?.trim() || "repo read:user")
    .split(/\s+/)
    .filter(Boolean);

  return {
    configured: !!clientId && !!clientSecret,
    clientId,
    callbackUrl,
    scopes,
    setupMessage:
      clientId && clientSecret
        ? undefined
        : "Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET in backend/.env to enable one-click GitHub OAuth.",
  };
}

export function buildGitHubAuthorizeUrl(state: string): string {
  const settings = githubOAuthSettings();
  if (!settings.clientId) {
    throw new Error("GitHub OAuth client id is not configured.");
  }

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", settings.clientId);
  url.searchParams.set("redirect_uri", settings.callbackUrl);
  url.searchParams.set("scope", settings.scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

export async function exchangeGitHubOAuthCode(code: string): Promise<GitHubOAuthToken> {
  const settings = githubOAuthSettings();
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET?.trim();
  if (!settings.clientId || !clientSecret) {
    throw new Error("GitHub OAuth is not configured.");
  }

  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: settings.clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: settings.callbackUrl,
    }),
  });

  const data = (await res.json()) as GitHubTokenResponse;
  if (!res.ok || data.error || !data.access_token) {
    throw new Error(data.error_description ?? data.error ?? "GitHub OAuth token exchange failed.");
  }

  return {
    accessToken: data.access_token,
    tokenType: data.token_type ?? "bearer",
    scopes: parseScopes(data.scope),
  };
}

export async function fetchGitHubViewer(accessToken: string): Promise<GitHubViewer> {
  const data = await githubFetch<GitHubUserResponse>(
    "https://api.github.com/user",
    accessToken,
  );
  if (!data.login) {
    throw new Error(data.message ?? "GitHub account lookup failed.");
  }

  return {
    login: data.login,
    avatarUrl: data.avatar_url,
    profileUrl: data.html_url ?? `https://github.com/${data.login}`,
  };
}

export async function listGitHubRepositories(accessToken: string): Promise<GitHubRepository[]> {
  const url = new URL("https://api.github.com/user/repos");
  url.searchParams.set("per_page", "100");
  url.searchParams.set("sort", "updated");
  url.searchParams.set("affiliation", "owner,collaborator,organization_member");

  const repos = await githubFetch<GitHubRepoResponse[]>(url.toString(), accessToken);
  return repos
    .filter((repo) => repo.permissions?.push !== false)
    .map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      owner: repo.owner.login,
      repo: repo.name,
      private: repo.private,
      defaultBranch: repo.default_branch,
      htmlUrl: repo.html_url,
      canPush: repo.permissions?.push ?? true,
    }));
}

export async function checkGitHubRepositoryHealth(input: {
  accessToken: string;
  owner: string;
  repo: string;
  branch?: string;
  tokenSource?: "oauth" | "env" | "unknown";
}): Promise<GitHubConnectionHealth> {
  const checkedAt = new Date().toISOString();
  const checks: GitHubConnectionHealthCheck[] = [];
  const branch = input.branch?.trim() || "main";

  try {
    const viewer = await fetchGitHubViewer(input.accessToken);
    checks.push({
      key: "account",
      label: "Account access",
      ok: true,
      detail: `Connected as @${viewer.login}.`,
    });
  } catch (err) {
    checks.push({
      key: "account",
      label: "Account access",
      ok: false,
      detail: err instanceof Error ? err.message : "Could not read GitHub account.",
    });
    return healthResult(input, branch, checkedAt, checks);
  }

  let repoData: GitHubRepoResponse | undefined;
  try {
    repoData = await githubFetch<GitHubRepoResponse>(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`,
      input.accessToken,
    );
    checks.push({
      key: "repo",
      label: "Repo access",
      ok: true,
      detail: `Can read ${repoData.full_name}.`,
    });
  } catch (err) {
    checks.push({
      key: "repo",
      label: "Repo access",
      ok: false,
      detail: err instanceof Error ? err.message : "Could not read selected repository.",
    });
    return healthResult(input, branch, checkedAt, checks);
  }

  try {
    const branchData = await githubFetch<GitHubBranchResponse>(
      `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/branches/${encodeURIComponent(branch)}`,
      input.accessToken,
    );
    checks.push({
      key: "branch",
      label: "Branch access",
      ok: true,
      detail: `Can read ${branchData.name ?? branch}.`,
    });
  } catch (err) {
    checks.push({
      key: "branch",
      label: "Branch access",
      ok: false,
      detail: err instanceof Error ? err.message : `Could not read branch ${branch}.`,
    });
  }

  const canWrite =
    repoData.permissions?.push === true ||
    repoData.permissions?.maintain === true ||
    repoData.permissions?.admin === true;
  checks.push({
    key: "write",
    label: "Write permission",
    ok: canWrite,
    detail: canWrite
      ? "Token can push branches, so PR creation is ready."
      : "Token can read the repo but cannot push branches. PR creation may fail.",
  });

  return healthResult(input, branch, checkedAt, checks);
}

async function githubFetch<T>(url: string, accessToken: string): Promise<T> {
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  const data = (await res.json()) as T & { message?: string };
  if (!res.ok) {
    throw new Error(data.message ?? `GitHub request failed with HTTP ${res.status}.`);
  }
  return data;
}

function parseScopes(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);
}

function healthResult(
  input: {
    owner: string;
    repo: string;
    tokenSource?: "oauth" | "env" | "unknown";
  },
  branch: string,
  checkedAt: string,
  checks: GitHubConnectionHealthCheck[],
): GitHubConnectionHealth {
  const ok = checks.length >= 4 && checks.every((check) => check.ok);
  return {
    ok,
    checkedAt,
    owner: input.owner,
    repo: input.repo,
    branch,
    tokenSource: input.tokenSource ?? "unknown",
    summary: ok
      ? "GitHub repo is ready for agent-created PRs."
      : "GitHub connection needs attention before reliable PR creation.",
    checks,
  };
}
