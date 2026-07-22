import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  process.env.MARKETPILOT_DB_PATH = path.join(
    os.tmpdir(),
    "marketpilot-tests",
    `connections-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );
  process.env.GITHUB_OWNER = "";
  process.env.GITHUB_REPO = "";
  process.env.GITHUB_TOKEN = "";

  const {
    connectionsStore,
    productProfileStore,
    workspacesStore,
  } = await import("../../store/index.js");
  const { encryptSecret } = await import("../../security/secrets.js");
  const {
    listWorkspaceSites,
    primaryWorkspaceSiteUrl,
    sanitizeConnectionConfig,
    workspaceGithubRepo,
  } = await import("../workspace-connections.js");

  const workspace = workspacesStore.create({ name: "Multi-site Workspace" });
  productProfileStore.ensure(workspace.id, "Multi-site Product");

  connectionsStore.create({
    workspaceId: workspace.id,
    type: "site",
    configJson: {
      url: "https://docs.example.com",
      label: "Docs",
      isPrimary: false,
    },
    status: "active",
  });
  connectionsStore.create({
    workspaceId: workspace.id,
    type: "site",
    configJson: {
      url: "https://www.example.com",
      label: "Marketing site",
      isPrimary: true,
    },
    status: "active",
  });

  const sites = listWorkspaceSites(workspace.id);
  assert.equal(sites.length, 2, "workspace can store more than one site");
  assert.equal(
    primaryWorkspaceSiteUrl(workspace.id),
    "https://www.example.com",
    "primary workspace site is used before secondary sites",
  );

  const sanitizedGithub = sanitizeConnectionConfig("github", {
    owner: "devansh-gauniyal",
    repo: "demo-saas-website",
    defaultBranch: "main",
    token: "SECRET_TOKEN",
  });
  assert.equal(sanitizedGithub.owner, "devansh-gauniyal");
  assert.equal(sanitizedGithub.repo, "demo-saas-website");
  assert.equal(sanitizedGithub.defaultBranch, "main");
  assert.equal(
    "token" in sanitizedGithub,
    false,
    "GitHub connection config keeps repo details but strips plain secrets",
  );

  connectionsStore.create({
    workspaceId: workspace.id,
    type: "github",
    configJson: {
      ...sanitizedGithub,
      accessTokenEncrypted: encryptSecret("oauth-token"),
      connectedAccount: "devansh-gauniyal",
      tokenSource: "oauth",
    },
    status: "active",
  });

  assert.deepEqual(
    workspaceGithubRepo(workspace.id),
    {
      owner: "devansh-gauniyal",
      repo: "demo-saas-website",
      defaultBranch: "main",
      accessToken: "oauth-token",
      tokenSource: "oauth",
      connectedAccount: "devansh-gauniyal",
      scopes: undefined,
    },
    "workspace GitHub repo comes from the encrypted OAuth connection store",
  );

  console.log("Workspace connection tests passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
