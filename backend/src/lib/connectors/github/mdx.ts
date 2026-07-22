// GitHub-MDX site connector.
//
// Goal: open a Pull Request that fixes alt-text on images in MDX/MD files
// living in a GitHub repo. PR-based writes are framework rule §5.8's preferred
// path because rollback is automatic — closing or reverting the PR undoes
// everything.
//
// === Simulation mode (current) ===
// Until you connect GitHub OAuth or set a local GITHUB_TOKEN, this connector SIMULATES PRs.
// It builds the same payloads a real call would, logs them to console, and
// returns a fake PR URL as `changeId`. The rest of the agent (tier gate, tool
// calls store, rollback flow, UI) treats it as if real. Swap the body of
// `fixAltText` / `rollback` for an @octokit/rest call when credentials land —
// no callers change.

import type {
  AltTextGap,
  AltTextPatch,
  CopyRewriteGap,
  CopyRewritePatch,
  CtaRewriteGap,
  CtaRewritePatch,
  ExternalWriteStatus,
  ExpectedChangeCheck,
  FaqSectionGap,
  FaqSectionPatch,
  InteractiveConversionUpgradeGap,
  InteractiveConversionUpgradePatch,
  PageMetadataGap,
  PageMetadataPatch,
  RepoConnectionConfig,
  RepoNavigationLink,
  ProductionSiteUpgradeGap,
  ProductionSiteUpgradePatch,
  RepoPageRole,
  RepoPageSummary,
  RepoStructureAnalysis,
  RepoStructureIssue,
  SeoFixVerificationInput,
  SeoFixVerificationResult,
  SiteCapabilities,
  SiteConnector,
  VisibleContentGap,
  VisibleContentPatch,
  VisualUpgradeGap,
  VisualUpgradePatch,
  WriteResult,
} from "../types";
import type { CrawledPage } from "../types";
import type { Octokit } from "@octokit/rest" with { "resolution-mode": "import" };
import { connectionsStore } from "../../store";
import { decryptSecret } from "../../security/secrets";

const CAPABILITIES: SiteCapabilities = {
  canCrawl: false,
  canReadCompetitor: false,
  canScanSource: true,
  canAnalyzeRepoStructure: true,
  canWriteMeta: true,
  canWriteCopy: true,
  canPublishPosts: true,
  canFixAltText: true,
  canFixPageMetadata: true,
  canImproveVisibleContent: true,
  canRewriteVisibleCopy: true,
  canImproveCtas: true,
  canAddFaqSections: true,
  canApplyVisualUpgrades: true,
  canApplyProductionSiteUpgrades: true,
  canApplyInteractiveConversionUpgrades: true,
  writesViaPR: true,
};

// Audit thresholds — kept in lock-step with the live-page audit checks so the
// "this needs fixing" verdict is consistent across the source scan and the
// crawl-based audit. Update both places together if you change them.
const TITLE_MIN = 25;
const TITLE_MAX = 65;
const DESC_MIN = 70;
const DESC_MAX = 165;

// Build a quiet Octokit client. The default client logs every 4xx response to
// stderr — including the harmless 404s we get while probing optional scan
// paths (`app`, `pages`, `src` may not exist on every repo). Silencing them
// keeps the backend logs readable. Real errors still throw and propagate.
async function makeOctokit(token: string): Promise<Octokit> {
  const { Octokit } = await import("@octokit/rest");
  return new Octokit({
    auth: token,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  });
}

// Config read from env. When you connect a real repo, populate these via
// the Connections store and the connector reads them from there instead.
function repoConfig(override?: RepoConnectionConfig): { owner: string; repo: string; defaultBranch?: string } {
  return {
    owner: override?.owner ?? process.env.GITHUB_OWNER ?? "demo-owner",
    repo: override?.repo ?? process.env.GITHUB_REPO ?? "demo-repo",
    defaultBranch: override?.defaultBranch,
  };
}

function githubToken(repo?: Pick<RepoConnectionConfig, "owner" | "repo" | "accessToken">): string | undefined {
  if (repo?.accessToken) return repo.accessToken;
  const storedToken = repo?.owner && repo?.repo ? tokenFromConnectionStore(repo.owner, repo.repo) : undefined;
  return storedToken ?? process.env.GITHUB_TOKEN?.trim() ?? undefined;
}

function tokenFromConnectionStore(owner: string, repo: string): string | undefined {
  const match = connectionsStore.listAll().find((connection) => {
    if (connection.type !== "github") return false;
    return connection.configJson.owner === owner && connection.configJson.repo === repo;
  });
  return decryptSecret(match?.configJson.accessTokenEncrypted);
}

// The rollback payload we save on every PR-producing write. The route can
// hand this back to `rollback()` to (later) close the PR via the GitHub API.
type AltTextRollbackPayload = {
  kind: "alt-text";
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  patches: AltTextPatch[];
  simulated: boolean;
};

type PullRequestRollbackPayload = {
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  simulated: boolean;
};

const SOURCE_EXTENSIONS = [
  ".mdx",
  ".md",
  ".html",
  ".tsx",
  ".jsx",
  ".ts",
  ".js",
  ".css",
  ".json",
  ".svg",
];
const DEFAULT_SCAN_PATHS = ["", "content", "app", "pages", "src", "blog"];
const DEFAULT_MAX_FILES = 80;

type RepoFile = {
  path: string;
  sha: string;
};

export const githubMdxConnector: SiteConnector = {
  type: "site:github-mdx",
  capabilities: CAPABILITIES,

  // GitHub-MDX doesn't crawl live URLs — that's the cheerio connector's job.
  // We still satisfy the SiteConnector interface, but throw a structured error.
  async crawl(_url: string): Promise<CrawledPage> {
    throw new Error("github-mdx connector cannot crawl live URLs. Use cheerioSiteConnector.");
  },

  async scanAltTextGaps(options): Promise<AltTextGap[]> {
    const { owner, repo, defaultBranch } = repoConfig(options?.repo);
    const token = githubToken(options?.repo);
    if (!token || owner === "demo-owner" || repo === "demo-repo") {
      throw new Error("scanAltTextGaps requires a connected GitHub repo and token.");
    }

    const octokit = await makeOctokit(token);
    const repoMeta = await octokit.rest.repos.get({ owner, repo });
    const ref = defaultBranch ?? repoMeta.data.default_branch;
    const paths = options?.paths && options.paths.length > 0
      ? options.paths
      : DEFAULT_SCAN_PATHS;
    const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

    const files: RepoFile[] = [];
    for (const scanPath of paths) {
      await collectSourceFiles(octokit, owner, repo, ref, scanPath, files, maxFiles);
      if (files.length >= maxFiles) break;
    }

    const gaps: AltTextGap[] = [];
    for (const file of uniqueFiles(files).slice(0, maxFiles)) {
      const content = await readRepoFile(octokit, owner, repo, file.path, ref);
      gaps.push(...findMissingAltText(content, file.path));
    }

    return gaps;
  },

  async fixAltText(patches: AltTextPatch[]): Promise<WriteResult> {
    if (!patches || patches.length === 0) {
      return { success: false, changeId: "", rollbackPayload: null };
    }

    const { owner, repo, defaultBranch } = repoConfig();
    const token = githubToken({ owner, repo });

    // === Real path: token present + owner/repo set → use Octokit ===
    if (token && owner !== "demo-owner" && repo !== "demo-repo") {
      try {
        const octokit = await makeOctokit(token);

        // 1. Get the default branch + its head SHA.
        const repoMeta = await octokit.rest.repos.get({ owner, repo });
        const baseBranch = defaultBranch ?? repoMeta.data.default_branch;
        const baseRef = await octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${baseBranch}`,
        });
        const baseSha = baseRef.data.object.sha;

        // 2. Create a new branch off the default branch.
        const branch = `agent/alt-text-${Date.now()}`;
        await octokit.rest.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        });

        // 3. For each patch: fetch the file, replace the matching <img>'s
        //    missing alt attribute, commit the change.
        const editedFiles: string[] = [];
        for (const p of patches) {
          try {
            const file = await octokit.rest.repos.getContent({
              owner,
              repo,
              path: p.filepath,
              ref: branch,
            });
            if (Array.isArray(file.data) || file.data.type !== "file") continue;
            const original = Buffer.from(file.data.content, "base64").toString(
              "utf8",
            );
            const next = applyAltTextPatch(original, p);
            if (next === original) continue;

            await octokit.rest.repos.createOrUpdateFileContents({
              owner,
              repo,
              path: p.filepath,
              message: `chore(agent): add alt-text to ${p.imageSrc} in ${p.filepath}`,
              content: Buffer.from(next, "utf8").toString("base64"),
              branch,
              sha: file.data.sha,
            });
            editedFiles.push(p.filepath);
          } catch (e) {
            console.error(
              `[github-mdx] failed to patch ${p.filepath}:`,
              e instanceof Error ? e.message : e,
            );
          }
        }

        // 4. Open the PR.
        const pr = await octokit.rest.pulls.create({
          owner,
          repo,
          base: baseBranch,
          head: branch,
          title: `agent: add alt-text to ${patches.length} image${patches.length === 1 ? "" : "s"}`,
          body: [
            "Opened by MarketPilot AI.",
            "",
            "Patches:",
            ...patches.map((p) => `- \`${p.filepath}\` :: \`${p.imageSrc}\` → "${p.altText}"`),
            "",
            "Close or revert this PR to roll back.",
          ].join("\n"),
        });

        const rollbackPayload: AltTextRollbackPayload = {
          kind: "alt-text",
          owner,
          repo,
          prNumber: pr.data.number,
          prUrl: pr.data.html_url,
          branch,
          patches,
          simulated: false,
        };

        console.log(
          `[github-mdx] OPENED PR ${pr.data.html_url} (${editedFiles.length}/${patches.length} files patched)`,
        );

        return {
          success: true,
          changeId: pr.data.html_url,
          rollbackPayload,
          previewUrl: pr.data.html_url,
        };
      } catch (err) {
        console.error(
          "[github-mdx] real PR failed, falling back to simulation:",
          err instanceof Error ? err.message : err,
        );
        // Fall through to simulation so the agent loop doesn't choke.
      }
    }

    // === Simulation fallback: no token, or real PR threw ===
    const prNumber = Math.floor(1000 + Math.random() * 9000);
    const branch = `agent/alt-text-${Date.now()}`;
    const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
    const rollbackPayload: AltTextRollbackPayload = {
      kind: "alt-text",
      owner,
      repo,
      prNumber,
      prUrl,
      branch,
      patches,
      simulated: true,
    };
    console.log(
      `[github-mdx] SIMULATED PR ${prUrl} on branch ${branch}: ${patches.length} alt-text patch(es)`,
    );
    for (const p of patches) {
      console.log(`  · ${p.filepath} :: ${p.imageSrc} → "${p.altText}"`);
    }
    return { success: true, changeId: prUrl, rollbackPayload, previewUrl: prUrl };
  },

  async analyzeRepoStructure(options): Promise<RepoStructureAnalysis> {
    const { owner, repo, defaultBranch } = repoConfig(options?.repo);
    const token = githubToken(options?.repo);
    if (!token || owner === "demo-owner" || repo === "demo-repo") {
      throw new Error("analyzeRepoStructure requires a connected GitHub repo and token.");
    }

    const octokit = await makeOctokit(token);
    const repoMeta = await octokit.rest.repos.get({ owner, repo });
    const ref = defaultBranch ?? repoMeta.data.default_branch;
    const paths = options?.paths && options.paths.length > 0
      ? options.paths
      : DEFAULT_SCAN_PATHS;
    const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

    const files: RepoFile[] = [];
    for (const scanPath of paths) {
      await collectSourceFiles(octokit, owner, repo, ref, scanPath, files, maxFiles);
      if (files.length >= maxFiles) break;
    }

    const unique = uniqueFiles(files).slice(0, maxFiles);
    const contents = new Map<string, string>();
    for (const file of unique) {
      contents.set(file.path, await readRepoFile(octokit, owner, repo, file.path, ref));
    }

    return analyzeRepoFiles(unique.map((file) => file.path), contents);
  },

  async scanPageMetadata(options): Promise<PageMetadataGap[]> {
    const { owner, repo, defaultBranch } = repoConfig(options?.repo);
    const token = githubToken(options?.repo);
    if (!token || owner === "demo-owner" || repo === "demo-repo") {
      throw new Error("scanPageMetadata requires a connected GitHub repo and token.");
    }

    const octokit = await makeOctokit(token);
    const repoMeta = await octokit.rest.repos.get({ owner, repo });
    const ref = defaultBranch ?? repoMeta.data.default_branch;
    const paths = options?.paths && options.paths.length > 0
      ? options.paths
      : DEFAULT_SCAN_PATHS;
    const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

    const files: RepoFile[] = [];
    for (const scanPath of paths) {
      await collectSourceFiles(octokit, owner, repo, ref, scanPath, files, maxFiles);
      if (files.length >= maxFiles) break;
    }

    const gaps: PageMetadataGap[] = [];
    for (const file of uniqueFiles(files).slice(0, maxFiles)) {
      const content = await readRepoFile(octokit, owner, repo, file.path, ref);
      const gap = inspectPageMetadata(content, file.path);
      if (gap) gaps.push(gap);
    }
    return gaps;
  },

  async fixPageMetadata(patches: PageMetadataPatch[]): Promise<WriteResult> {
    if (!patches || patches.length === 0) {
      return { success: false, changeId: "", rollbackPayload: null };
    }
    return openSeoFixPr(
      undefined,
      patches,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "page-metadata only",
    );
  },

  async scanVisibleContentGaps(options): Promise<VisibleContentGap[]> {
    const { owner, repo, defaultBranch } = repoConfig(options?.repo);
    const token = githubToken(options?.repo);
    if (!token || owner === "demo-owner" || repo === "demo-repo") {
      throw new Error("scanVisibleContentGaps requires a connected GitHub repo and token.");
    }

    const octokit = await makeOctokit(token);
    const repoMeta = await octokit.rest.repos.get({ owner, repo });
    const ref = defaultBranch ?? repoMeta.data.default_branch;
    const paths = options?.paths && options.paths.length > 0
      ? options.paths
      : DEFAULT_SCAN_PATHS;
    const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

    const files: RepoFile[] = [];
    for (const scanPath of paths) {
      await collectSourceFiles(octokit, owner, repo, ref, scanPath, files, maxFiles);
      if (files.length >= maxFiles) break;
    }

    const visibleFiles = prioritizeVisibleContentFiles(uniqueFiles(files)).slice(0, maxFiles);

    const gaps: VisibleContentGap[] = [];
    for (const file of visibleFiles) {
      const content = await readRepoFile(octokit, owner, repo, file.path, ref);
      const gap = inspectVisibleContentOpportunity(content, file.path);
      if (gap) gaps.push(gap);
      if (gaps.length >= 3) break;
    }
    return gaps;
  },

  async scanCopyRewriteGaps(options): Promise<CopyRewriteGap[]> {
    const { owner, repo, defaultBranch } = repoConfig(options?.repo);
    const token = githubToken(options?.repo);
    if (!token || owner === "demo-owner" || repo === "demo-repo") {
      throw new Error("scanCopyRewriteGaps requires a connected GitHub repo and token.");
    }

    const octokit = await makeOctokit(token);
    const repoMeta = await octokit.rest.repos.get({ owner, repo });
    const ref = defaultBranch ?? repoMeta.data.default_branch;
    const paths = options?.paths && options.paths.length > 0
      ? options.paths
      : DEFAULT_SCAN_PATHS;
    const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

    const files: RepoFile[] = [];
    for (const scanPath of paths) {
      await collectSourceFiles(octokit, owner, repo, ref, scanPath, files, maxFiles);
      if (files.length >= maxFiles) break;
    }

    const visibleFiles = prioritizeVisibleContentFiles(uniqueFiles(files)).slice(0, maxFiles);
    const gaps: CopyRewriteGap[] = [];
    for (const file of visibleFiles) {
      const content = await readRepoFile(octokit, owner, repo, file.path, ref);
      gaps.push(...inspectCopyRewriteOpportunities(content, file.path));
      if (gaps.length >= 5) break;
    }
    return gaps.slice(0, 5);
  },

  async scanCtaRewriteGaps(options): Promise<CtaRewriteGap[]> {
    const { owner, repo, defaultBranch } = repoConfig(options?.repo);
    const token = githubToken(options?.repo);
    if (!token || owner === "demo-owner" || repo === "demo-repo") {
      throw new Error("scanCtaRewriteGaps requires a connected GitHub repo and token.");
    }

    const octokit = await makeOctokit(token);
    const repoMeta = await octokit.rest.repos.get({ owner, repo });
    const ref = defaultBranch ?? repoMeta.data.default_branch;
    const paths = options?.paths && options.paths.length > 0
      ? options.paths
      : DEFAULT_SCAN_PATHS;
    const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

    const files: RepoFile[] = [];
    for (const scanPath of paths) {
      await collectSourceFiles(octokit, owner, repo, ref, scanPath, files, maxFiles);
      if (files.length >= maxFiles) break;
    }

    const visibleFiles = prioritizeVisibleContentFiles(uniqueFiles(files)).slice(0, maxFiles);
    const gaps: CtaRewriteGap[] = [];
    for (const file of visibleFiles) {
      const content = await readRepoFile(octokit, owner, repo, file.path, ref);
      gaps.push(...inspectCtaRewriteOpportunities(content, file.path));
      if (gaps.length >= 4) break;
    }
    return gaps.slice(0, 4);
  },

  async scanFaqSectionGaps(options): Promise<FaqSectionGap[]> {
    const { owner, repo, defaultBranch } = repoConfig(options?.repo);
    const token = githubToken(options?.repo);
    if (!token || owner === "demo-owner" || repo === "demo-repo") {
      throw new Error("scanFaqSectionGaps requires a connected GitHub repo and token.");
    }

    const octokit = await makeOctokit(token);
    const repoMeta = await octokit.rest.repos.get({ owner, repo });
    const ref = defaultBranch ?? repoMeta.data.default_branch;
    const paths = options?.paths && options.paths.length > 0
      ? options.paths
      : DEFAULT_SCAN_PATHS;
    const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

    const files: RepoFile[] = [];
    for (const scanPath of paths) {
      await collectSourceFiles(octokit, owner, repo, ref, scanPath, files, maxFiles);
      if (files.length >= maxFiles) break;
    }

    const visibleFiles = prioritizeVisibleContentFiles(uniqueFiles(files)).slice(0, maxFiles);
    const gaps: FaqSectionGap[] = [];
    for (const file of visibleFiles) {
      const content = await readRepoFile(octokit, owner, repo, file.path, ref);
      const gap = inspectFaqSectionOpportunity(content, file.path);
      if (gap) gaps.push(gap);
      if (gaps.length >= 3) break;
    }
    return gaps;
  },

  async scanVisualUpgradeGaps(options): Promise<VisualUpgradeGap[]> {
    const { owner, repo, defaultBranch } = repoConfig(options?.repo);
    const token = githubToken(options?.repo);
    if (!token || owner === "demo-owner" || repo === "demo-repo") {
      throw new Error("scanVisualUpgradeGaps requires a connected GitHub repo and token.");
    }

    const octokit = await makeOctokit(token);
    const repoMeta = await octokit.rest.repos.get({ owner, repo });
    const ref = defaultBranch ?? repoMeta.data.default_branch;
    const paths = options?.paths && options.paths.length > 0
      ? options.paths
      : DEFAULT_SCAN_PATHS;
    const maxFiles = options?.maxFiles ?? DEFAULT_MAX_FILES;

    const files: RepoFile[] = [];
    for (const scanPath of paths) {
      await collectSourceFiles(octokit, owner, repo, ref, scanPath, files, maxFiles);
      if (files.length >= maxFiles) break;
    }

    const visibleFiles = prioritizeVisibleContentFiles(uniqueFiles(files)).slice(0, maxFiles);
    const gaps: VisualUpgradeGap[] = [];
    for (const file of visibleFiles) {
      const content = await readRepoFile(octokit, owner, repo, file.path, ref);
      const gap = inspectVisualUpgradeOpportunity(content, file.path);
      if (gap) gaps.push(gap);
      if (gaps.length >= 2) break;
    }
    return gaps;
  },

  async scanProductionSiteUpgradeGaps(options): Promise<ProductionSiteUpgradeGap[]> {
    const analysis = options?.analysis ?? (await this.analyzeRepoStructure!(options));
    if (analysis.projectKind !== "static-html") return [];

    return analysis.pages
      .filter((page) => page.filepath.toLowerCase().endsWith(".html"))
      .filter((page) => page.stylesheetPaths.length > 0)
      .filter((page) => page.issues.length > 0)
      .sort((a, b) => productionPagePriority(a) - productionPagePriority(b))
      .slice(0, 3)
      .map((page) => {
        const brokenLocalLinks = page.localLinks
          .filter((href) => page.issues.includes(`broken-link:${href}`))
          .map((href) => ({
            href,
            suggestedHref: suggestReplacementHref(href, analysis.sourceFiles),
          }));

        return {
          filepath: page.filepath,
          style: "static-html-page-css",
          pageRole: page.role,
          stylesheetPath: page.stylesheetPaths[0],
          reason: productionUpgradeReason(page),
          issues: page.issues,
          existingHeadings: [...page.h1s, ...page.h2s].slice(0, 8),
          brokenLocalLinks,
        } satisfies ProductionSiteUpgradeGap;
      });
  },

  async scanInteractiveConversionUpgradeGaps(options): Promise<InteractiveConversionUpgradeGap[]> {
    const analysis = options?.analysis ?? (await this.analyzeRepoStructure!(options));
    if (analysis.projectKind !== "static-html") return [];

    return analysis.pages
      .filter((page) => page.filepath.toLowerCase().endsWith(".html"))
      .filter((page) => page.stylesheetPaths.length > 0)
      .filter((page) => page.hasMain)
      .filter((page) => page.role === "home" || page.role === "features" || page.role === "pricing")
      .filter((page) => !page.issues.includes("has-interactive-conversion-upgrade"))
      .sort((a, b) => interactiveConversionPagePriority(a) - interactiveConversionPagePriority(b))
      .slice(0, 2)
      .map((page) => ({
        filepath: page.filepath,
        style: "static-html-interactive-css",
        pageRole: page.role,
        stylesheetPath: page.stylesheetPaths[0],
        reason: interactiveConversionUpgradeReason(page),
        existingHeadings: [...page.h1s, ...page.h2s].slice(0, 8),
        ctaTexts: page.ctaTexts.slice(0, 6),
      } satisfies InteractiveConversionUpgradeGap));
  },

  // Bundled: open ONE PR containing alt-text + metadata fixes. The orchestrator
  // uses this so the user reviews a single, complete change set per run.
  async applySeoFixes(input): Promise<WriteResult> {
    const altText = input?.altText ?? [];
    const pageMetadata = input?.pageMetadata ?? [];
    const visibleContent = input?.visibleContent ?? [];
    const copyRewrite = input?.copyRewrite ?? [];
    const ctaRewrite = input?.ctaRewrite ?? [];
    const faqSection = input?.faqSection ?? [];
    const visualUpgrade = input?.visualUpgrade ?? [];
    const productionUpgrade = input?.productionUpgrade ?? [];
    const interactiveConversionUpgrade = input?.interactiveConversionUpgrade ?? [];
    if (
      altText.length === 0 &&
      pageMetadata.length === 0 &&
      visibleContent.length === 0 &&
      copyRewrite.length === 0 &&
      ctaRewrite.length === 0 &&
      faqSection.length === 0 &&
      visualUpgrade.length === 0 &&
      productionUpgrade.length === 0 &&
      interactiveConversionUpgrade.length === 0
    ) {
      return { success: false, changeId: "", rollbackPayload: null };
    }
    return openSeoFixPr(
      altText,
      pageMetadata,
      visibleContent,
      copyRewrite,
      ctaRewrite,
      faqSection,
      visualUpgrade,
      productionUpgrade,
      interactiveConversionUpgrade,
      input?.reason,
      input?.repo,
    );
  },

  async verifySeoFixes(
    input: SeoFixVerificationInput,
  ): Promise<SeoFixVerificationResult> {
    const { owner, repo, defaultBranch } = repoConfig(input.repo);
    const token = githubToken(input.repo);
    if (!token || owner === "demo-owner" || repo === "demo-repo") {
      throw new Error("verifySeoFixes requires a connected GitHub repo and token.");
    }

    const octokit = await makeOctokit(token);
    const repoMeta = await octokit.rest.repos.get({ owner, repo });
    const ref = defaultBranch ?? repoMeta.data.default_branch;
    const filePaths = collectSeoFixVerificationFilepaths(input);
    const contents = new Map<string, string | undefined>();

    for (const filepath of filePaths) {
      contents.set(
        filepath,
        await readRepoFileIfExists(octokit, owner, repo, filepath, ref),
      );
    }

    const expectedChecks = buildSeoFixExpectedChecks(input, contents);
    const passedCount = expectedChecks.filter((check) => check.passed).length;
    const analysis = await githubMdxConnector.analyzeRepoStructure!({ repo: input.repo });
    const beforeIssueCount = input.plan?.repoAnalysis?.issues.length;
    const afterIssueCount = analysis.issues.length;
    const ok = expectedChecks.length > 0 && passedCount === expectedChecks.length;

    return {
      ok,
      checkedAt: new Date().toISOString(),
      summary: ok
        ? `Verified ${passedCount}/${expectedChecks.length} expected repo change(s) on ${repoMeta.data.default_branch}.`
        : `Only ${passedCount}/${expectedChecks.length} expected repo change(s) were found on ${repoMeta.data.default_branch}.`,
      expectedChecks,
      repo: {
        projectKind: analysis.projectKind,
        beforeIssueCount,
        afterIssueCount,
        issuesImproved:
          beforeIssueCount === undefined
            ? undefined
            : afterIssueCount <= beforeIssueCount,
        recommendedFocus: analysis.recommendedFocus,
      },
    };
  },

  async inspectWriteStatus(rollbackPayload: unknown): Promise<ExternalWriteStatus> {
    const payload = rollbackPayload as Partial<PullRequestRollbackPayload>;
    const checkedAt = new Date().toISOString();
    if (!payload || !payload.owner || !payload.repo || !payload.prNumber) {
      return {
        provider: "github",
        kind: "unknown",
        state: "unknown",
        checkedAt,
        summary: "This write does not include enough PR data to check GitHub.",
      };
    }

    if (payload.simulated) {
      return {
        provider: "github",
        kind: "simulated",
        state: "simulated",
        checkedAt,
        changeId: payload.prUrl,
        summary: "This was a simulated PR, so GitHub merge status cannot be checked.",
      };
    }

    const token = githubToken({ owner: payload.owner, repo: payload.repo });
    if (!token) {
      return {
        provider: "github",
        kind: "pull_request",
        state: "unknown",
        checkedAt,
        changeId: payload.prUrl,
        summary: "A GitHub token is missing, so GitHub merge status cannot be checked.",
      };
    }

    try {
      const octokit = await makeOctokit(token);
      const pr = await octokit.rest.pulls.get({
        owner: payload.owner,
        repo: payload.repo,
        pull_number: payload.prNumber,
      });
      const state = pr.data.merged_at
        ? "merged"
        : pr.data.state === "open"
          ? "open"
          : "closed";

      return {
        provider: "github",
        kind: "pull_request",
        state,
        checkedAt,
        changeId: pr.data.html_url,
        summary: summarizePullRequestStatus(state, pr.data.html_url),
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        return {
          provider: "github",
          kind: "pull_request",
          state: "not_found",
          checkedAt,
          changeId: payload.prUrl,
          summary: "GitHub could not find this pull request.",
        };
      }
      throw err;
    }
  },

  async rollback(kind: string, rollbackPayload: unknown): Promise<WriteResult> {
    if (kind !== "alt-text" && kind !== "seo-fixes") {
      return { success: false, changeId: "", rollbackPayload: null };
    }
    const payload = rollbackPayload as AltTextRollbackPayload;

    const rollbackToken = githubToken({ owner: payload.owner, repo: payload.repo });
    if (!payload.simulated && rollbackToken) {
      try {
        const octokit = await makeOctokit(rollbackToken);
        await octokit.rest.pulls.update({
          owner: payload.owner,
          repo: payload.repo,
          pull_number: payload.prNumber,
          state: "closed",
        });
        console.log(`[github-mdx] CLOSED PR ${payload.prUrl}`);
        return {
          success: true,
          changeId: `${payload.prUrl} (closed)`,
          rollbackPayload: null,
        };
      } catch (err) {
        console.error(
          "[github-mdx] real rollback failed, marking as failed:",
          err instanceof Error ? err.message : err,
        );
        return { success: false, changeId: "", rollbackPayload: null };
      }
    }

    // Simulated rollback path (matches the simulated PR path).
    console.log(`[github-mdx] SIMULATED rollback — closing PR ${payload.prUrl}`);
    return {
      success: true,
      changeId: `${payload.prUrl} (closed)`,
      rollbackPayload: null,
    };
  },
};

// ============================================================================
//  PR builder — bundles alt-text + page-metadata patches into one branch and
//  opens one PR. Falls back to simulation when no token is present, matching
//  the existing fixAltText behavior so the agent loop never crashes on a
//  missing connection.
// ============================================================================

type SeoFixRollbackPayload = {
  kind: "seo-fixes";
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  branch: string;
  altText: AltTextPatch[];
  pageMetadata: PageMetadataPatch[];
  visibleContent: VisibleContentPatch[];
  copyRewrite: CopyRewritePatch[];
  ctaRewrite: CtaRewritePatch[];
  faqSection: FaqSectionPatch[];
  visualUpgrade: VisualUpgradePatch[];
  productionUpgrade: ProductionSiteUpgradePatch[];
  interactiveConversionUpgrade: InteractiveConversionUpgradePatch[];
  simulated: boolean;
};

async function openSeoFixPr(
  altText: AltTextPatch[] = [],
  pageMetadata: PageMetadataPatch[] = [],
  visibleContent: VisibleContentPatch[] = [],
  copyRewrite: CopyRewritePatch[] = [],
  ctaRewrite: CtaRewritePatch[] = [],
  faqSection: FaqSectionPatch[] = [],
  visualUpgrade: VisualUpgradePatch[] = [],
  productionUpgrade: ProductionSiteUpgradePatch[] = [],
  interactiveConversionUpgrade: InteractiveConversionUpgradePatch[] = [],
  reason?: string,
  repoOverride?: RepoConnectionConfig,
): Promise<WriteResult> {
  const { owner, repo, defaultBranch } = repoConfig(repoOverride);
  const token = githubToken(repoOverride ?? { owner, repo });

  if (token && owner !== "demo-owner" && repo !== "demo-repo") {
    try {
      const octokit = await makeOctokit(token);

      const repoMeta = await octokit.rest.repos.get({ owner, repo });
      const baseBranch = defaultBranch ?? repoMeta.data.default_branch;
      const baseRef = await octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${baseBranch}`,
      });
      const baseSha = baseRef.data.object.sha;

      const branch = `agent/seo-fixes-${Date.now()}`;
      await octokit.rest.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: baseSha,
      });

      // Group patches by filepath so we make at most one commit per file
      // (otherwise GitHub returns the wrong SHA on the second hit).
      type FileWork = {
        altText: AltTextPatch[];
        metadata: PageMetadataPatch[];
        visibleContent: VisibleContentPatch[];
        copyRewrite: CopyRewritePatch[];
        ctaRewrite: CtaRewritePatch[];
        faqSection: FaqSectionPatch[];
        visualUpgrade: VisualUpgradePatch[];
        productionUpgrade: ProductionSiteUpgradePatch[];
        interactiveConversionUpgrade: InteractiveConversionUpgradePatch[];
        addVisualUpgradeStyles: boolean;
        addProductionUpgradeStyles: boolean;
        addInteractiveConversionStyles: boolean;
      };
      const byFile = new Map<string, FileWork>();
      for (const p of altText) {
        const f = byFile.get(p.filepath) ?? emptyFileWork();
        f.altText.push(p);
        byFile.set(p.filepath, f);
      }
      for (const p of pageMetadata) {
        const f = byFile.get(p.filepath) ?? emptyFileWork();
        f.metadata.push(p);
        byFile.set(p.filepath, f);
      }
      for (const p of visibleContent) {
        const f = byFile.get(p.filepath) ?? emptyFileWork();
        f.visibleContent.push(p);
        byFile.set(p.filepath, f);
      }
      for (const p of copyRewrite) {
        const f = byFile.get(p.filepath) ?? emptyFileWork();
        f.copyRewrite.push(p);
        byFile.set(p.filepath, f);
      }
      for (const p of ctaRewrite) {
        const f = byFile.get(p.filepath) ?? emptyFileWork();
        f.ctaRewrite.push(p);
        byFile.set(p.filepath, f);
      }
      for (const p of faqSection) {
        const f = byFile.get(p.filepath) ?? emptyFileWork();
        f.faqSection.push(p);
        byFile.set(p.filepath, f);
      }
      for (const p of visualUpgrade) {
        const pageWork = byFile.get(p.filepath) ?? emptyFileWork();
        pageWork.visualUpgrade.push(p);
        byFile.set(p.filepath, pageWork);

        const styleWork = byFile.get(p.stylesheetPath) ?? emptyFileWork();
        styleWork.addVisualUpgradeStyles = true;
        byFile.set(p.stylesheetPath, styleWork);
      }
      for (const p of productionUpgrade) {
        const pageWork = byFile.get(p.filepath) ?? emptyFileWork();
        pageWork.productionUpgrade.push(p);
        byFile.set(p.filepath, pageWork);

        const styleWork = byFile.get(p.stylesheetPath) ?? emptyFileWork();
        styleWork.addProductionUpgradeStyles = true;
        byFile.set(p.stylesheetPath, styleWork);
      }
      for (const p of interactiveConversionUpgrade) {
        const pageWork = byFile.get(p.filepath) ?? emptyFileWork();
        pageWork.interactiveConversionUpgrade.push(p);
        byFile.set(p.filepath, pageWork);

        const styleWork = byFile.get(p.stylesheetPath) ?? emptyFileWork();
        styleWork.addInteractiveConversionStyles = true;
        byFile.set(p.stylesheetPath, styleWork);
      }

      const edited: string[] = [];
      for (const [filepath, work] of byFile) {
        try {
          const file = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: filepath,
            ref: branch,
          });
          if (Array.isArray(file.data) || file.data.type !== "file") continue;
          const original = Buffer.from(file.data.content, "base64").toString("utf8");
          let next = original;
          for (const p of work.altText) next = applyAltTextPatch(next, p);
          for (const p of work.metadata) next = applyPageMetadataPatch(next, p);
          for (const p of work.copyRewrite) next = applyCopyRewritePatch(next, p);
          for (const p of work.ctaRewrite) next = applyCtaRewritePatch(next, p);
          for (const p of work.visibleContent) next = applyVisibleContentPatch(next, p);
          for (const p of work.faqSection) next = applyFaqSectionPatch(next, p);
          for (const p of work.visualUpgrade) next = applyVisualUpgradePatch(next, p);
          for (const p of work.productionUpgrade) next = applyProductionSiteUpgradePatch(next, p);
          for (const p of work.interactiveConversionUpgrade) next = applyInteractiveConversionUpgradePatch(next, p);
          if (work.addVisualUpgradeStyles) next = applyVisualUpgradeStyles(next);
          if (work.addProductionUpgradeStyles) next = applyProductionSiteUpgradeStyles(next);
          if (work.addInteractiveConversionStyles) next = applyInteractiveConversionUpgradeStyles(next);
          if (next === original) continue;

          const messageParts: string[] = [];
          if (work.altText.length > 0) messageParts.push(`alt-text x${work.altText.length}`);
          if (work.metadata.length > 0) messageParts.push("page metadata");
          if (work.copyRewrite.length > 0) messageParts.push(`copy rewrite x${work.copyRewrite.length}`);
          if (work.ctaRewrite.length > 0) messageParts.push(`CTA rewrite x${work.ctaRewrite.length}`);
          if (work.visibleContent.length > 0) messageParts.push(`visible content x${work.visibleContent.length}`);
          if (work.faqSection.length > 0) messageParts.push(`FAQ section x${work.faqSection.length}`);
          if (work.visualUpgrade.length > 0) messageParts.push(`visual upgrade x${work.visualUpgrade.length}`);
          if (work.productionUpgrade.length > 0) messageParts.push(`production upgrade x${work.productionUpgrade.length}`);
          if (work.interactiveConversionUpgrade.length > 0) messageParts.push(`interactive upgrade x${work.interactiveConversionUpgrade.length}`);
          if (work.addVisualUpgradeStyles) messageParts.push("visual upgrade styles");
          if (work.addProductionUpgradeStyles) messageParts.push("production upgrade styles");
          if (work.addInteractiveConversionStyles) messageParts.push("interactive upgrade styles");

          await octokit.rest.repos.createOrUpdateFileContents({
            owner,
            repo,
            path: filepath,
            message: `chore(agent): SEO fixes (${messageParts.join(", ")}) in ${filepath}`,
            content: Buffer.from(next, "utf8").toString("base64"),
            branch,
            sha: file.data.sha,
          });
          edited.push(filepath);
        } catch (e) {
          console.error(
            `[github-mdx] failed to patch ${filepath}:`,
            e instanceof Error ? e.message : e,
          );
        }
      }

      if (edited.length === 0) {
        return { success: false, changeId: "", rollbackPayload: null };
      }

      const titleParts: string[] = [];
      if (altText.length > 0) titleParts.push(`${altText.length} alt-text`);
      if (pageMetadata.length > 0) titleParts.push(`${pageMetadata.length} page-metadata`);
      if (copyRewrite.length > 0) titleParts.push(`${copyRewrite.length} copy-rewrite`);
      if (ctaRewrite.length > 0) titleParts.push(`${ctaRewrite.length} CTA-rewrite`);
      if (visibleContent.length > 0) titleParts.push(`${visibleContent.length} visible-content`);
      if (faqSection.length > 0) titleParts.push(`${faqSection.length} FAQ-section`);
      if (visualUpgrade.length > 0) titleParts.push(`${visualUpgrade.length} visual-upgrade`);
      if (productionUpgrade.length > 0) titleParts.push(`${productionUpgrade.length} production-upgrade`);
      if (interactiveConversionUpgrade.length > 0) titleParts.push(`${interactiveConversionUpgrade.length} interactive-upgrade`);

      const pr = await octokit.rest.pulls.create({
        owner,
        repo,
        base: baseBranch,
        head: branch,
        title: `agent: SEO fixes — ${titleParts.join(", ")}`,
        body: [
          "Opened by MarketPilot AI.",
          "",
          ...(reason ? ["**Why:**", reason] : []),
          "",
          ...(altText.length > 0
            ? ["**Alt-text patches:**", ...altText.map(p => `- \`${p.filepath}\` :: \`${p.imageSrc}\` → "${p.altText}"`)]
            : []),
          "",
          ...(pageMetadata.length > 0
            ? [
                "**Page-metadata patches:**",
                ...pageMetadata.map(p => {
                  const parts: string[] = [];
                  if (p.title) parts.push(`title="${p.title}"`);
                  if (p.description) parts.push(`description="${p.description}"`);
                  return `- \`${p.filepath}\` (${p.style}) → ${parts.join(", ")}`;
                }),
              ]
            : []),
          "",
          ...(visibleContent.length > 0
            ? [
                "**Visible content patches:**",
                ...visibleContent.map(p => `- \`${p.filepath}\` (${p.style}) → section "${p.heading}"`),
              ]
            : []),
          "",
          ...(copyRewrite.length > 0
            ? [
                "**Existing copy rewrites:**",
                ...copyRewrite.map(p => `- \`${p.filepath}\` → "${p.currentText}" → "${p.replacementText}"`),
              ]
            : []),
          "",
          ...(ctaRewrite.length > 0
            ? [
                "**CTA text rewrites:**",
                ...ctaRewrite.map(p => `- \`${p.filepath}\` → "${p.currentText}" → "${p.replacementText}"`),
              ]
            : []),
          "",
          ...(faqSection.length > 0
            ? [
                "**FAQ section patches:**",
                ...faqSection.map(p => `- \`${p.filepath}\` (${p.style}) → section "${p.heading}" with ${p.faqs.length} question(s)`),
              ]
            : []),
          "",
          ...(visualUpgrade.length > 0
            ? [
                "**Visual upgrade patches:**",
                ...visualUpgrade.map(p => `- \`${p.filepath}\` + \`${p.stylesheetPath}\` → polished section "${p.heading}"`),
              ]
            : []),
          "",
          ...(productionUpgrade.length > 0
            ? [
                "**Production site upgrade patches:**",
                ...productionUpgrade.map(p => `- \`${p.filepath}\` + \`${p.stylesheetPath}\` → ${p.pageRole} page upgrade "${p.section.heading}"`),
              ]
            : []),
          "",
          ...(interactiveConversionUpgrade.length > 0
            ? [
                "**Interactive conversion upgrade patches:**",
                ...interactiveConversionUpgrade.map(p => `- \`${p.filepath}\` + \`${p.stylesheetPath}\` → ${p.pageRole} calculator section "${p.section.heading}"`),
              ]
            : []),
          "",
          "Close or revert this PR to roll back.",
        ].filter(Boolean).join("\n"),
      });

      const rollbackPayload: SeoFixRollbackPayload = {
        kind: "seo-fixes",
        owner,
        repo,
        prNumber: pr.data.number,
        prUrl: pr.data.html_url,
        branch,
        altText,
        pageMetadata,
        visibleContent,
        copyRewrite,
        ctaRewrite,
        faqSection,
        visualUpgrade,
        productionUpgrade,
        interactiveConversionUpgrade,
        simulated: false,
      };

      console.log(
        `[github-mdx] OPENED SEO-FIXES PR ${pr.data.html_url} (${edited.length} files)`,
      );

      return {
        success: true,
        changeId: pr.data.html_url,
        rollbackPayload,
        previewUrl: pr.data.html_url,
      };
    } catch (err) {
      console.error(
        "[github-mdx] real SEO-fixes PR failed, falling back to simulation:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Simulation fallback.
  const prNumber = Math.floor(1000 + Math.random() * 9000);
  const branch = `agent/seo-fixes-${Date.now()}`;
  const prUrl = `https://github.com/${owner}/${repo}/pull/${prNumber}`;
  const rollbackPayload: SeoFixRollbackPayload = {
    kind: "seo-fixes",
    owner,
    repo,
    prNumber,
    prUrl,
    branch,
    altText,
    pageMetadata,
    visibleContent,
    copyRewrite,
    ctaRewrite,
    faqSection,
    visualUpgrade,
    productionUpgrade,
    interactiveConversionUpgrade,
    simulated: true,
  };
  console.log(
    `[github-mdx] SIMULATED SEO-fixes PR ${prUrl}: ${altText.length} alt-text + ${pageMetadata.length} metadata + ${copyRewrite.length} copy-rewrite + ${ctaRewrite.length} CTA-rewrite + ${visibleContent.length} visible-content + ${faqSection.length} FAQ-section + ${visualUpgrade.length} visual-upgrade + ${productionUpgrade.length} production-upgrade + ${interactiveConversionUpgrade.length} interactive-upgrade`,
  );
  return { success: true, changeId: prUrl, rollbackPayload, previewUrl: prUrl };
}

function emptyFileWork(): {
  altText: AltTextPatch[];
  metadata: PageMetadataPatch[];
  visibleContent: VisibleContentPatch[];
  copyRewrite: CopyRewritePatch[];
  ctaRewrite: CtaRewritePatch[];
  faqSection: FaqSectionPatch[];
  visualUpgrade: VisualUpgradePatch[];
  productionUpgrade: ProductionSiteUpgradePatch[];
  interactiveConversionUpgrade: InteractiveConversionUpgradePatch[];
  addVisualUpgradeStyles: boolean;
  addProductionUpgradeStyles: boolean;
  addInteractiveConversionStyles: boolean;
} {
  return {
    altText: [],
    metadata: [],
    visibleContent: [],
    copyRewrite: [],
    ctaRewrite: [],
    faqSection: [],
    visualUpgrade: [],
    productionUpgrade: [],
    interactiveConversionUpgrade: [],
    addVisualUpgradeStyles: false,
    addProductionUpgradeStyles: false,
    addInteractiveConversionStyles: false,
  };
}

// ============================================================================
//  Repo analysis — Step 4 intelligence layer.
//  This is intentionally conservative: classify the repo, summarize pages, and
//  surface issues that our connector can safely fix through PR patches.
// ============================================================================

export function analyzeRepoFiles(
  paths: string[],
  contents: Map<string, string>,
): RepoStructureAnalysis {
  const normalizedPaths = Array.from(new Set(paths.map((path) => path.replace(/\\/g, "/"))));
  const pathSet = new Set(normalizedPaths.map((path) => path.toLowerCase()));
  const projectKind = classifyProject(normalizedPaths, contents);
  const rawPages = normalizedPaths
    .filter((path) => isAnalyzablePage(path))
    .map((path) => summarizeRepoPage(path, contents.get(path) ?? "", pathSet));
  const navigationLinks = rawPages.flatMap((page) =>
    collectNavigationLinks(page.filepath, contents.get(page.filepath) ?? "", pathSet),
  );
  const pages = addInboundLinks(rawPages, navigationLinks);
  const orphanPages = pages
    .filter((page) => page.role !== "home")
    .filter((page) => page.inboundInternalLinks.length === 0)
    .map((page) => page.filepath);
  const primaryNav = navigationLinks
    .filter((link) => link.status === "ok" && (link.area === "header" || link.area === "nav"))
    .slice(0, 8);
  const footerNav = navigationLinks
    .filter((link) => link.status === "ok" && link.area === "footer")
    .slice(0, 12);
  const brokenLinkCount = navigationLinks.filter((link) => link.status === "broken").length;

  const issues = collectRepoIssues(projectKind, pages);
  return {
    projectKind,
    sourceFiles: normalizedPaths.sort(),
    pages,
    stylesheets: normalizedPaths.filter((path) => path.toLowerCase().endsWith(".css")).sort(),
    assets: normalizedPaths.filter((path) => /\.(svg|png|jpe?g|webp|gif)$/i.test(path)).sort(),
    navigationLinks,
    primaryNav,
    footerNav,
    orphanPages,
    importantPages: importantPagesFor(pages),
    brokenLinkCount,
    issues,
    recommendedFocus: recommendedRepoFocus(projectKind, issues),
  };
}

function classifyProject(paths: string[], contents: Map<string, string>): RepoStructureAnalysis["projectKind"] {
  const lowerPaths = paths.map((path) => path.toLowerCase());
  const packagePath = paths.find((path) => path.toLowerCase().endsWith("package.json"));
  const packageJson = packagePath ? contents.get(packagePath) ?? "" : "";

  if (lowerPaths.some((path) => path.includes("next.config")) || /"next"\s*:/.test(packageJson)) {
    return "nextjs";
  }
  if (/"react"\s*:/.test(packageJson) || lowerPaths.some((path) => path.endsWith("src/app.jsx") || path.endsWith("src/app.tsx"))) {
    return "react";
  }
  if (lowerPaths.some((path) => path.endsWith(".html"))) return "static-html";
  if (lowerPaths.some((path) => path.endsWith(".mdx") || path.endsWith(".md"))) return "content-site";
  return "unknown";
}

function isAnalyzablePage(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".html") ||
    lower.endsWith(".mdx") ||
    lower.endsWith(".md") ||
    lower.endsWith("page.tsx") ||
    lower.endsWith("page.jsx")
  );
}

function summarizeRepoPage(
  filepath: string,
  content: string,
  pathSet: Set<string>,
): RepoPageSummary {
  const lower = filepath.toLowerCase();
  const isHtml = lower.endsWith(".html");
  const h1s = extractTagTexts(content, "h1");
  const h2s = extractTagTexts(content, "h2");
  const localLinks = extractLocalLinks(content);
  const stylesheetPaths = isHtml
    ? extractStylesheetPaths(content, filepath)
    : [];
  const brokenLinks = localLinks.filter((href) => !localHrefExists(filepath, href, pathSet));
  const issues: string[] = [];

  if (isHtml && !/<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(content)) {
    issues.push("missing-viewport");
  }
  if (h1s.length > 1) issues.push("duplicate-h1");
  for (const href of brokenLinks) issues.push(`broken-link:${href}`);
  if (pageRole(filepath) === "pricing" && !/<table\b/i.test(content)) {
    issues.push("weak-pricing-structure");
  }
  if (isHtml && hasPlainGeneratedSection(content)) {
    issues.push("plain-generated-section");
  }
  if (isHtml && /class=["'][^"']*\binteractive-conversion\b/i.test(content)) {
    issues.push("has-interactive-conversion-upgrade");
  }
  if (isHtml && !/class=["'][^"']*\b(agent-visual-upgrade|production-upgrade|interactive-conversion)\b/i.test(content)) {
    issues.push("basic-static-layout");
  }

  return {
    filepath,
    role: pageRole(filepath),
    routePath: routePathFor(filepath),
    depth: routeDepthFor(filepath),
    title: isHtml ? readHtmlHead(content)?.title : readMdxFrontmatter(content)?.title,
    h1s,
    h2s,
    sections: extractPageSections(content).slice(0, 10),
    stylesheetPaths,
    localLinks,
    inboundInternalLinks: [],
    ctaTexts: extractCtaTexts(content),
    wordCount: countWords(content),
    hasMain: /<main\b[^>]*>[\s\S]*<\/main>/i.test(content),
    issues,
  };
}

function collectRepoIssues(
  projectKind: RepoStructureAnalysis["projectKind"],
  pages: RepoPageSummary[],
): RepoStructureIssue[] {
  const issues: RepoStructureIssue[] = [];
  if (projectKind === "unknown") {
    issues.push({
      severity: "info",
      code: "unknown-project",
      message: "The connector could not confidently identify the website framework.",
    });
  }

  for (const page of pages) {
    if (page.issues.includes("duplicate-h1")) {
      issues.push({
        severity: "warning",
        code: "duplicate-h1",
        filepath: page.filepath,
        message: `${page.filepath} has more than one H1, which weakens page structure.`,
      });
    }
    if (page.issues.includes("missing-viewport")) {
      issues.push({
        severity: "warning",
        code: "missing-viewport",
        filepath: page.filepath,
        message: `${page.filepath} is missing a viewport meta tag for mobile layout.`,
      });
    }
    if (page.issues.includes("weak-pricing-structure")) {
      issues.push({
        severity: "warning",
        code: "weak-pricing-structure",
        filepath: page.filepath,
        message: `${page.filepath} has pricing cards but no comparison table or decision support.`,
      });
    }
    if (page.issues.includes("plain-generated-section")) {
      issues.push({
        severity: "warning",
        code: "plain-generated-section",
        filepath: page.filepath,
        message: `${page.filepath} contains a plain generated content block that should be replaced with a designed section.`,
      });
    }
    if (page.issues.includes("basic-static-layout")) {
      issues.push({
        severity: "info",
        code: "basic-static-layout",
        filepath: page.filepath,
        message: `${page.filepath} uses a basic static layout that can be upgraded with stronger visual hierarchy.`,
      });
    }
    for (const issue of page.issues.filter((item) => item.startsWith("broken-link:"))) {
      const href = issue.replace("broken-link:", "");
      issues.push({
        severity: "critical",
        code: "broken-local-link",
        filepath: page.filepath,
        message: `${page.filepath} links to missing local page ${href}.`,
      });
    }
  }

  return issues;
}

function recommendedRepoFocus(
  projectKind: RepoStructureAnalysis["projectKind"],
  issues: RepoStructureIssue[],
): string {
  const critical = issues.find((issue) => issue.severity === "critical");
  if (critical) return `Fix repo functionality first: ${critical.message}`;
  const pricing = issues.find((issue) => issue.code === "weak-pricing-structure");
  if (pricing) return "Improve the pricing page structure and buyer decision support.";
  const plainGenerated = issues.find((issue) => issue.code === "plain-generated-section");
  if (plainGenerated) return "Replace plain generated content blocks with designed page sections.";
  const duplicate = issues.find((issue) => issue.code === "duplicate-h1");
  if (duplicate) return "Clean up page heading structure before adding more content.";
  if (projectKind === "static-html") return "Upgrade the static HTML pages with stronger layout and trust signals.";
  return "Map the repo structure before applying production changes.";
}

function productionPagePriority(page: RepoPageSummary): number {
  if (page.issues.some((issue) => issue.startsWith("broken-link:"))) return 0;
  if (page.role === "pricing" && page.issues.includes("weak-pricing-structure")) return 1;
  if (page.issues.includes("plain-generated-section")) return 2;
  if (page.role === "home") return 2;
  if (page.role === "features") return 3;
  return 9;
}

function productionUpgradeReason(page: RepoPageSummary): string {
  if (page.issues.some((issue) => issue.startsWith("broken-link:"))) {
    return "Page has broken local navigation links and should be repaired while improving the layout.";
  }
  if (page.role === "pricing" && page.issues.includes("weak-pricing-structure")) {
    return "Pricing page needs stronger buyer decision support, clearer hierarchy, and comparison content.";
  }
  if (page.issues.includes("plain-generated-section")) {
    return "Page contains a plain generated content block that should be replaced with a designed section.";
  }
  if (page.issues.includes("duplicate-h1")) {
    return "Page heading structure needs cleanup before the page can feel production-ready.";
  }
  return "Page has a basic static layout and can be improved with a structured production section.";
}

function interactiveConversionPagePriority(page: RepoPageSummary): number {
  if (page.role === "home") return 0;
  if (page.role === "pricing") return 1;
  if (page.role === "features") return 2;
  return 9;
}

function interactiveConversionUpgradeReason(page: RepoPageSummary): string {
  if (page.role === "pricing") {
    return "Pricing page can be improved with an interactive decision helper that makes plan value easier to estimate.";
  }
  if (page.role === "features") {
    return "Features page can better show product value with a lightweight interactive planning experience.";
  }
  return "Homepage can be improved with an interactive calculator that turns interest into a clearer next step.";
}

function addInboundLinks(
  pages: RepoPageSummary[],
  navigationLinks: RepoNavigationLink[],
): RepoPageSummary[] {
  return pages.map((page) => {
    const inboundInternalLinks = navigationLinks
      .filter((link) => link.status === "ok")
      .filter((link) => link.resolvedPath?.toLowerCase() === page.filepath.toLowerCase())
      .map((link) => link.sourceFilepath)
      .filter((sourceFilepath) => sourceFilepath !== page.filepath);

    return {
      ...page,
      inboundInternalLinks: Array.from(new Set(inboundInternalLinks)).sort(),
    };
  });
}

function importantPagesFor(pages: RepoPageSummary[]): string[] {
  return [...pages]
    .sort((a, b) => pageImportance(a) - pageImportance(b))
    .map((page) => page.filepath)
    .slice(0, 8);
}

function pageImportance(page: RepoPageSummary): number {
  if (page.role === "home") return 0;
  if (page.role === "pricing") return 1;
  if (page.role === "features") return 2;
  if (page.inboundInternalLinks.length > 0) return 3 + page.depth;
  if (page.role === "blog") return 7 + page.depth;
  if (page.role === "content") return 8 + page.depth;
  return 10 + page.depth;
}

function routePathFor(filepath: string): string {
  const normalized = filepath.replace(/\\/g, "/");
  if (isRepoHomeFile(normalized)) return "/";

  const route = normalized
    .replace(/^content\/pages\//i, "")
    .replace(/^content\//i, "")
    .replace(/^pages\//i, "")
    .replace(/^app\//i, "")
    .replace(/\.(html|mdx|md|tsx|jsx)$/i, "")
    .replace(/\/page$/i, "")
    .replace(/\/index$/i, "");

  if (!route || route.toLowerCase() === "home") return "/";
  return `/${route.replace(/^\/+/, "")}`;
}

function routeDepthFor(filepath: string): number {
  return routePathFor(filepath).split("/").filter(Boolean).length;
}

function collectNavigationLinks(
  filepath: string,
  content: string,
  pathSet: Set<string>,
): RepoNavigationLink[] {
  const links: RepoNavigationLink[] = [];
  const linkRegex = /<a\b([^>]*)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of content.matchAll(linkRegex)) {
    const href = match[2].trim();
    if (!href || href.startsWith("#")) continue;
    if (/^(https?:|mailto:|tel:)/i.test(href)) continue;

    const attrs = `${match[1]} ${match[3]}`;
    const resolvedPath = resolveRepoRelativePath(filepath, href);
    const status = localHrefExists(filepath, href, pathSet) ? "ok" : "broken";
    const text = normalizeVisibleText(match[4]) || href;

    links.push({
      sourceFilepath: filepath,
      area: navigationAreaFor(content, match.index ?? 0, attrs),
      text: text.slice(0, 80),
      href,
      resolvedPath,
      status,
    });
  }

  return links;
}

function navigationAreaFor(
  content: string,
  index: number,
  attrs: string,
): RepoNavigationLink["area"] {
  const lower = content.toLowerCase();
  const before = lower.slice(0, index);
  const isInside = (tagName: "header" | "nav" | "main" | "footer") => {
    return before.lastIndexOf(`<${tagName}`) > before.lastIndexOf(`</${tagName}>`);
  };

  if (isInside("footer")) return "footer";
  if (isInside("nav")) return "nav";
  if (isInside("header")) return "header";
  if (isInside("main")) return "main";
  if (/\bfooter\b/i.test(attrs)) return "footer";
  if (/\bnav|menu\b/i.test(attrs)) return "nav";
  if (/\bheader\b/i.test(attrs)) return "header";
  return "unknown";
}

function extractPageSections(content: string): RepoPageSummary["sections"] {
  const sections = Array.from(content.matchAll(/<section\b([^>]*)>([\s\S]*?)<\/section>/gi))
    .map((match, index) => {
      const attrs = match[1] ?? "";
      const body = match[2] ?? "";
      const className = attrs.match(/\bclass\s*=\s*["']([^"']+)["']/i)?.[1];

      return {
        index,
        kind: sectionKindFor(body, className, firstHeadingText(body)),
        heading: firstHeadingText(body),
        className,
        wordCount: countWords(body),
        hasCta: /<(a|button)\b/i.test(body),
      };
    });

  if (sections.length > 0) return sections;

  return extractTagTexts(content, "h2").slice(0, 6).map((heading, index) => ({
    index,
    kind: sectionKindFor(heading, undefined, heading),
    heading,
    wordCount: countWords(heading),
    hasCta: false,
  }));
}

function firstHeadingText(content: string): string | undefined {
  const match = content.match(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i);
  const heading = match ? normalizeVisibleText(match[1]) : "";
  return heading || undefined;
}

function sectionKindFor(
  body: string,
  className?: string,
  heading?: string,
): RepoPageSummary["sections"][number]["kind"] {
  const signal = `${className ?? ""} ${heading ?? ""} ${normalizeVisibleText(body)}`.toLowerCase();

  if (/\b(content-improvement|faq-improvement)\b/.test(signal)) return "generated";
  if (/\bhero\b|above the fold|launchpilot ai/.test(signal)) return "hero";
  if (/\bpricing|plan|starter|growth|scale\b/.test(signal)) return "pricing";
  if (/\bfaq|frequently asked|questions\b/.test(signal)) return "faq";
  if (/\bcta|call to action|get started|book a demo|start free\b/.test(signal)) return "cta";
  if (countWords(body) >= 20) return "content";
  return "unknown";
}

function suggestReplacementHref(href: string, sourceFiles: string[]): string {
  const lowerFiles = new Set(sourceFiles.map((file) => file.toLowerCase()));
  if (href.toLowerCase().includes("case") && lowerFiles.has("features.html")) {
    return "features.html";
  }
  if (lowerFiles.has("features.html")) return "features.html";
  if (lowerFiles.has("index.html")) return "index.html";
  return "#";
}

function pageRole(filepath: string): RepoPageRole {
  const lower = filepath.toLowerCase();
  if (isRepoHomeFile(filepath)) return "home";
  if (lower.includes("pricing")) return "pricing";
  if (lower.includes("feature")) return "features";
  if (lower.includes("blog")) return "blog";
  if (lower.endsWith(".md") || lower.endsWith(".mdx")) return "content";
  return "unknown";
}

function isRepoHomeFile(filepath: string): boolean {
  const normalized = filepath.replace(/\\/g, "/").toLowerCase();
  return (
    normalized === "index.html" ||
    normalized.endsWith("/index.html") ||
    normalized.includes("content/pages/home.") ||
    normalized.includes("app/page.")
  );
}

function extractTagTexts(content: string, tagName: "h1" | "h2"): string[] {
  return Array.from(content.matchAll(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "gi")))
    .map((match) => normalizeVisibleText(match[1]))
    .filter(Boolean);
}

function extractLocalLinks(content: string): string[] {
  const links: string[] = [];
  for (const match of content.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    const href = match[1].trim();
    if (!href || href.startsWith("#")) continue;
    if (/^(https?:|mailto:|tel:)/i.test(href)) continue;
    links.push(href);
  }
  return Array.from(new Set(links));
}

function extractStylesheetPaths(content: string, filepath: string): string[] {
  return Array.from(content.matchAll(/<link\b[^>]*>/gi))
    .map((match) => {
      const tag = match[0];
      if (!/\brel\s*=\s*["'][^"']*stylesheet[^"']*["']/i.test(tag)) return "";
      const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1] ?? "";
      if (!href || /^https?:\/\//i.test(href)) return "";
      return resolveRepoRelativePath(filepath, href);
    })
    .filter(Boolean);
}

function extractCtaTexts(content: string): string[] {
  const main = readMainHtml(content);
  return Array.from(main.matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>/gi))
    .map((match) => normalizeVisibleText(match[2]))
    .filter((text) => text.length > 0 && text.length <= 80)
    .slice(0, 8);
}

function countWords(content: string): number {
  const text = normalizeVisibleText(content);
  return text ? text.split(/\s+/).length : 0;
}

function localHrefExists(filepath: string, href: string, pathSet: Set<string>): boolean {
  const target = resolveRepoRelativePath(filepath, href).toLowerCase();
  if (!target) return true;
  if (pathSet.has(target)) return true;
  if (target.endsWith("/")) return pathSet.has(`${target}index.html`);
  return false;
}

// ============================================================================
//  Patch helpers — pure string transforms, easy to unit-test.
//  Each one returns the modified content, or the original string when no
//  matching pattern was found. Callers compare next === original to skip
//  no-op commits.
// ============================================================================

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Apply a single alt-text patch to file content. Tries (in order):
//   1. HTML <img src="..."> → add alt= or replace empty alt=""
//   2. JSX <Image src="..."> → same
//   3. Markdown ![](src) → fill the empty alt slot
export function applyAltTextPatch(content: string, p: AltTextPatch): string {
  const escapedSrc = escapeRegex(p.imageSrc);
  const altHtml = p.altText.replace(/"/g, "&quot;");

  // 1+2: HTML <img> / JSX <Image>
  const tagRegex = new RegExp(
    `(<(?:img|Image)\\b[^>]*?src=["']${escapedSrc}["'][^>]*?)(/?>)`,
    "g",
  );
  let next = content.replace(tagRegex, (full, head, close) => {
    const altLiteral = full.match(/\balt\s*=\s*["']([^"']*)["']/i);
    const altExpression = /\balt\s*=\s*\{[^}]+\}/i.test(full);
    if (altExpression) return full; // already has JSX expression alt
    if (altLiteral && altLiteral[1].trim().length > 0) return full;
    if (altLiteral) {
      return full.replace(
        /\balt\s*=\s*["'][^"']*["']/i,
        `alt="${altHtml}"`,
      );
    }
    // Trim any trailing whitespace on head so we don't end up with double
    // spaces like `<img  alt="…">`.
    return `${head.replace(/\s+$/, "")} alt="${altHtml}"${close}`;
  });
  if (next !== content) return next;

  // 3: Markdown ![](src)
  const mdRegex = new RegExp(
    `!\\[(\\s*)\\]\\(${escapedSrc}(\\s+"[^"]*")?\\)`,
    "g",
  );
  next = content.replace(mdRegex, (_full, _ws, titleSuffix = "") => {
    return `![${p.altText}](${p.imageSrc}${titleSuffix})`;
  });
  return next;
}

// ----------------------------------------------------------------------------
//  Page metadata — title + description in three file types.
// ----------------------------------------------------------------------------

// Inspect a single file and decide whether it has actionable title/description
// issues. Returns undefined if the file isn't a metadata-bearing source file.
export function inspectPageMetadata(
  content: string,
  filepath: string,
): PageMetadataGap | undefined {
  const lower = filepath.toLowerCase();

  if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
    const fm = readMdxFrontmatter(content);
    if (!fm) return undefined; // no frontmatter at all → not metadata-style
    const issues = scoreTitleDescription(fm.title, fm.description);
    if (issues.length === 0) return undefined;
    return {
      filepath,
      style: "mdx-frontmatter",
      currentTitle: fm.title,
      currentDescription: fm.description,
      issues,
    };
  }

  if (lower.endsWith(".ts") || lower.endsWith(".tsx") || lower.endsWith(".js") || lower.endsWith(".jsx")) {
    const meta = readNextMetadata(content);
    if (!meta) return undefined; // file has no `export const metadata`
    const issues = scoreTitleDescription(meta.title, meta.description);
    if (issues.length === 0) return undefined;
    return {
      filepath,
      style: "nextjs-metadata",
      currentTitle: meta.title,
      currentDescription: meta.description,
      issues,
    };
  }

  if (lower.endsWith(".html")) {
    const meta = readHtmlHead(content);
    if (!meta) return undefined; // no <head> block at all
    const issues = scoreTitleDescription(meta.title, meta.description);
    if (issues.length === 0) return undefined;
    return {
      filepath,
      style: "html-head",
      currentTitle: meta.title,
      currentDescription: meta.description,
      issues,
    };
  }

  return undefined;
}

function scoreTitleDescription(title?: string, description?: string): string[] {
  const issues: string[] = [];
  if (!title || title.trim().length === 0) issues.push("missing-title");
  else if (title.length < TITLE_MIN || title.length > TITLE_MAX) issues.push("title-length");
  if (!description || description.trim().length === 0) issues.push("missing-description");
  else if (description.length < DESC_MIN || description.length > DESC_MAX) issues.push("description-length");
  return issues;
}

function readMdxFrontmatter(content: string): { title?: string; description?: string } | undefined {
  // Frontmatter is at the very top: ---\n...\n---
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return undefined;
  const block = match[1];
  return {
    title: yamlScalarField(block, "title"),
    description: yamlScalarField(block, "description"),
  };
}

function yamlScalarField(block: string, key: string): string | undefined {
  // Conservative: only handles `key: "value"`, `key: 'value'`, `key: value`.
  // Multi-line / list values are intentionally not parsed — we'll leave those
  // alone rather than mangle them.
  const rx = new RegExp(`^${key}\\s*:\\s*(.*)$`, "mi");
  const m = block.match(rx);
  if (!m) return undefined;
  const raw = m[1].trim();
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

function readNextMetadata(content: string): { title?: string; description?: string } | undefined {
  // Match an export of a metadata-ish constant. We accept any of:
  //   export const metadata = { ... }
  //   export const metadata: Metadata = { ... }
  //   export const generateMetadata = ... (we skip these — they're functions)
  const match = content.match(
    /export\s+const\s+metadata(?:\s*:\s*[^=]+)?\s*=\s*\{([\s\S]*?)\}\s*(?:;|$)/m,
  );
  if (!match) return undefined;
  const block = match[1];
  return {
    title: jsStringField(block, "title"),
    description: jsStringField(block, "description"),
  };
}

function jsStringField(block: string, key: string): string | undefined {
  // Handles "key": "value", key: 'value', key: `value`. Skips nested objects.
  const rx = new RegExp(
    `(?:^|[,\\{])\\s*["']?${key}["']?\\s*:\\s*(["'\\\`])((?:\\\\.|(?!\\1).)*?)\\1`,
    "m",
  );
  const m = block.match(rx);
  return m ? m[2] : undefined;
}

function readHtmlHead(content: string): { title?: string; description?: string } | undefined {
  const headMatch = content.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  if (!headMatch) return undefined;
  const head = headMatch[1];
  const title = head.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  const desc = head.match(/<meta\b[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1];
  return { title, description: desc };
}

// Apply a metadata patch to file content. Dispatches by `style`. Returns the
// original string if no matching block was found (caller treats that as a
// no-op).
export function applyPageMetadataPatch(content: string, p: PageMetadataPatch): string {
  if (p.style === "mdx-frontmatter") return patchMdxFrontmatter(content, p);
  if (p.style === "nextjs-metadata") return patchNextMetadata(content, p);
  if (p.style === "html-head") return patchHtmlHead(content, p);
  return content;
}

function patchMdxFrontmatter(content: string, p: PageMetadataPatch): string {
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    // No frontmatter → insert one. Only safe for .md/.mdx; we already know
    // style is mdx-frontmatter so trust the caller.
    const lines = [
      "---",
      ...(p.title ? [`title: "${escapeYaml(p.title)}"`] : []),
      ...(p.description ? [`description: "${escapeYaml(p.description)}"`] : []),
      "---",
      "",
    ];
    return lines.join("\n") + content;
  }
  let block = fmMatch[1];
  if (p.title !== undefined) block = upsertYamlField(block, "title", p.title);
  if (p.description !== undefined) block = upsertYamlField(block, "description", p.description);
  return content.replace(fmMatch[0], `---\n${block}\n---`);
}

function upsertYamlField(block: string, key: string, value: string): string {
  const line = `${key}: "${escapeYaml(value)}"`;
  const rx = new RegExp(`^${key}\\s*:\\s*.*$`, "mi");
  if (rx.test(block)) return block.replace(rx, line);
  // Append on a new line at end of frontmatter block.
  return block.endsWith("\n") ? `${block}${line}` : `${block}\n${line}`;
}

function escapeYaml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function patchNextMetadata(content: string, p: PageMetadataPatch): string {
  const match = content.match(
    /(export\s+const\s+metadata(?:\s*:\s*[^=]+)?\s*=\s*\{)([\s\S]*?)(\}\s*(?:;|$))/m,
  );
  if (!match) return content; // can't insert if no metadata export
  let body = match[2];
  if (p.title !== undefined) body = upsertJsStringField(body, "title", p.title);
  if (p.description !== undefined) body = upsertJsStringField(body, "description", p.description);
  return content.replace(match[0], `${match[1]}${body}${match[3]}`);
}

function upsertJsStringField(body: string, key: string, value: string): string {
  const literal = `${key}: "${escapeJsString(value)}"`;
  const rx = new RegExp(
    `(["']?${key}["']?\\s*:\\s*)(["'\`])((?:\\\\.|(?!\\2).)*?)\\2`,
    "m",
  );
  if (rx.test(body)) return body.replace(rx, `${key}: "${escapeJsString(value)}"`);
  // Insert as the first field. Keep formatting tolerable — newline + comma.
  if (body.trim().length === 0) return `\n  ${literal},\n`;
  return `\n  ${literal},${body}`;
}

function escapeJsString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, " ");
}

function patchHtmlHead(content: string, p: PageMetadataPatch): string {
  const headMatch = content.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  if (!headMatch) return content;
  let head = headMatch[1];
  const descEscaped = p.description ? p.description.replace(/"/g, "&quot;") : undefined;
  if (p.title !== undefined) {
    const titleRx = /<title\b[^>]*>[\s\S]*?<\/title>/i;
    const titleTag = `<title>${escapeHtml(p.title)}</title>`;
    if (titleRx.test(head)) head = head.replace(titleRx, titleTag);
    else head = `${titleTag}\n${head}`;
  }
  if (descEscaped !== undefined) {
    const descRx = /<meta\b[^>]*name=["']description["'][^>]*>/i;
    const descTag = `<meta name="description" content="${descEscaped}">`;
    if (descRx.test(head)) head = head.replace(descRx, descTag);
    else head = `${descTag}\n${head}`;
  }
  return content.replace(headMatch[0], `<head>${head}</head>`);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ----------------------------------------------------------------------------
//  Visible content — safe page-body additions.
// ----------------------------------------------------------------------------

export function inspectVisibleContentOpportunity(
  content: string,
  filepath: string,
): VisibleContentGap | undefined {
  const lower = filepath.toLowerCase();
  if (isReadmeFile(lower)) return undefined;

  const headings = extractHeadings(content);
  const hasFaq = headings.some((h) => /\bfaq\b|frequently asked/i.test(h));

  if (hasFaq) return undefined;
  if (/class=["'][^"']*\bcontent-improvement\b/i.test(content)) return undefined;

  // Static HTML pages need designed sections with CSS, not bare text blocks.
  // Production/visual/interactive upgrade scanners handle those pages.
  if (lower.endsWith(".html")) return undefined;

  if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
    return {
      filepath,
      style: "mdx-section",
      reason: "No FAQ or next-step section was found in the visible markdown content.",
      existingHeadings: headings.slice(0, 8),
    };
  }

  return undefined;
}

export function applyVisibleContentPatch(
  content: string,
  p: VisibleContentPatch,
): string {
  if (!p.heading.trim() || !p.body.trim()) return content;
  if (p.style === "html-main") return patchHtmlVisibleSection(content, p);
  if (p.style === "mdx-section") return patchMdxVisibleSection(content, p);
  return content;
}

function patchHtmlVisibleSection(content: string, p: VisibleContentPatch): string {
  const section = [
    "",
    '    <section class="content-improvement">',
    `      <h2>${escapeHtml(p.heading)}</h2>`,
    `      <p>${escapeHtml(p.body)}</p>`,
    ...(p.bullets && p.bullets.length > 0
      ? [
          "      <ul>",
          ...p.bullets
            .filter((b) => b.trim().length > 0)
            .slice(0, 4)
            .map((b) => `        <li>${escapeHtml(b)}</li>`),
          "      </ul>",
        ]
      : []),
    "    </section>",
    "",
  ].join("\n");

  return content.replace(/<\/main>/i, `${section}</main>`);
}

function patchMdxVisibleSection(content: string, p: VisibleContentPatch): string {
  const bullets = (p.bullets ?? [])
    .filter((b) => b.trim().length > 0)
    .slice(0, 4)
    .map((b) => `- ${b.trim()}`);
  const section = [
    "",
    `## ${p.heading.trim()}`,
    "",
    p.body.trim(),
    "",
    ...bullets,
    "",
  ].join("\n");
  return `${content.replace(/\s+$/, "")}\n${section}`;
}

function extractHeadings(content: string): string[] {
  const out: string[] = [];
  for (const m of content.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)) {
    const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) out.push(text);
  }
  for (const m of content.matchAll(/^#{1,3}\s+(.+)$/gm)) {
    const text = m[1].replace(/[#`*_]/g, "").trim();
    if (text) out.push(text);
  }
  return Array.from(new Set(out));
}

// ----------------------------------------------------------------------------
//  Existing copy rewrites — safe edits to text already visible on HTML pages.
// ----------------------------------------------------------------------------

export function inspectCopyRewriteOpportunities(
  content: string,
  filepath: string,
): CopyRewriteGap[] {
  if (!isHtmlWebsitePage(filepath)) return [];

  const main = stripGeneratedSections(readMainHtml(content));
  if (!main) return [];

  const candidates: CopyRewriteGap[] = [];
  let index = 0;
  for (const match of main.matchAll(/<(h1|h2|p)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const tagName = match[1].toLowerCase() as "h1" | "h2" | "p";
    const attrs = match[2] ?? "";
    const text = normalizeVisibleText(match[3]);
    if (!isSafeRewriteTarget(tagName, attrs, text)) continue;

    candidates.push({
      filepath,
      style: "html-text",
      targetId: `copy:${tagName}:${index}`,
      tagName,
      currentText: text,
      reason: copyRewriteReason(tagName, filepath),
    });
    index++;
  }

  const h1 = candidates.find((c) => c.tagName === "h1");
  const firstParagraph = candidates.find((c) => c.tagName === "p");
  const firstH2 = candidates.find((c) => c.tagName === "h2");

  return [h1, firstParagraph, firstH2]
    .filter((c): c is CopyRewriteGap => Boolean(c))
    .slice(0, 2);
}

export function applyCopyRewritePatch(
  content: string,
  p: CopyRewritePatch,
): string {
  if (!isSafeReplacement(p.currentText, p.replacementText)) return content;

  const target = parseCopyTargetId(p.targetId);
  if (!target || target.tagName !== p.tagName) return content;
  const mainMatch = content.match(/(<main\b[^>]*>)([\s\S]*?)(<\/main>)/i);
  if (!mainMatch) return content;

  let currentIndex = 0;
  let changed = false;
  const tagRegex = new RegExp(
    `<${p.tagName}\\b([^>]*)>([\\s\\S]*?)<\\/${p.tagName}>`,
    "gi",
  );

  const nextMain = mainMatch[2].replace(tagRegex, (full, attrs: string, inner: string) => {
    if (changed) return full;
    if (!isSafeRewriteTarget(p.tagName, attrs, normalizeVisibleText(inner))) {
      return full;
    }

    const normalizedInner = normalizeVisibleText(inner);
    const isTarget = currentIndex === target.index && normalizedInner === p.currentText.trim();
    currentIndex++;
    if (!isTarget) return full;

    changed = true;
    return `<${p.tagName}${attrs}>${escapeHtml(p.replacementText.trim())}</${p.tagName}>`;
  });
  if (!changed) return content;
  return content.replace(mainMatch[0], `${mainMatch[1]}${nextMain}${mainMatch[3]}`);
}

// ----------------------------------------------------------------------------
//  CTA rewrites — safe edits to button/link text already visible in <main>.
// ----------------------------------------------------------------------------

export function inspectCtaRewriteOpportunities(
  content: string,
  filepath: string,
): CtaRewriteGap[] {
  if (!isHtmlWebsitePage(filepath)) return [];

  const main = stripGeneratedSections(readMainHtml(content));
  if (!main) return [];

  const candidates: CtaRewriteGap[] = [];
  let index = 0;
  for (const match of main.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gi)) {
    const element = match[1].toLowerCase() as "a" | "button";
    const attrs = match[2] ?? "";
    const text = normalizeVisibleText(match[3]);
    if (!isSafeCtaTarget(attrs, text)) continue;

    candidates.push({
      filepath,
      style: "html-cta",
      targetId: `cta:${element}:${index}`,
      element,
      currentText: text,
      reason: ctaRewriteReason(text, filepath),
    });
    index++;
  }

  return candidates.slice(0, 2);
}

export function applyCtaRewritePatch(
  content: string,
  p: CtaRewritePatch,
): string {
  if (!isSafeCtaReplacement(p.currentText, p.replacementText)) return content;

  const target = parseCtaTargetId(p.targetId);
  if (!target || target.element !== p.element) return content;
  const mainMatch = content.match(/(<main\b[^>]*>)([\s\S]*?)(<\/main>)/i);
  if (!mainMatch) return content;

  let currentIndex = 0;
  let changed = false;
  const ctaRegex = new RegExp(
    `<${p.element}\\b([^>]*)>([\\s\\S]*?)<\\/${p.element}>`,
    "gi",
  );

  const nextMain = mainMatch[2].replace(ctaRegex, (full, attrs: string, inner: string) => {
    if (changed) return full;
    const normalizedInner = normalizeVisibleText(inner);
    if (!isSafeCtaTarget(attrs, normalizedInner)) return full;

    const isTarget = currentIndex === target.index && normalizedInner === p.currentText.trim();
    currentIndex++;
    if (!isTarget) return full;

    changed = true;
    return `<${p.element}${attrs}>${escapeHtml(p.replacementText.trim())}</${p.element}>`;
  });

  if (!changed) return content;
  return content.replace(mainMatch[0], `${mainMatch[1]}${nextMain}${mainMatch[3]}`);
}

function isSafeCtaTarget(attrs: string, text: string): boolean {
  if (!text) return false;
  if (text.length < 3 || text.length > 70) return false;
  if (/<|>/.test(text)) return false;
  if (/\b(nav|footer|social|legal|privacy|terms|copyright|icon)\b/i.test(attrs)) {
    return false;
  }
  if (/[₹$€£]\s?\d|\d+\s?(usd|eur|gbp|inr)\b/i.test(text)) return false;
  if (/\b(terms|privacy|copyright|refund|guarantee)\b/i.test(text)) return false;
  return true;
}

function isSafeCtaReplacement(currentText: string, replacementText: string): boolean {
  const next = replacementText.trim();
  if (!next || next === currentText.trim()) return false;
  if (next.length > 70) return false;
  if (/<|>/.test(next)) return false;
  if (/[₹$€£]\s?\d|\d+\s?(usd|eur|gbp|inr)\b/i.test(next)) return false;
  if (/\b(terms|privacy|copyright|refund|guarantee)\b/i.test(next)) return false;
  return true;
}

function parseCtaTargetId(targetId: string): { element: "a" | "button"; index: number } | undefined {
  const match = targetId.match(/^cta:(a|button):(\d+)$/);
  if (!match) return undefined;
  return {
    element: match[1] as "a" | "button",
    index: Number(match[2]),
  };
}

function ctaRewriteReason(currentText: string, filepath: string): string {
  if (/\b(start|try|get|book|demo|launch)\b/i.test(currentText)) {
    return "CTA can be more specific about what happens after the click.";
  }
  if (filepath.toLowerCase().includes("pricing")) {
    return "Pricing CTA can set clearer expectations without changing plan or price details.";
  }
  return "CTA text can be clearer and more action-oriented for visitors.";
}

// ----------------------------------------------------------------------------
//  FAQ additions — visible buyer questions added as a small section.
// ----------------------------------------------------------------------------

export function inspectFaqSectionOpportunity(
  content: string,
  filepath: string,
): FaqSectionGap | undefined {
  const lower = filepath.toLowerCase();
  if (isReadmeFile(lower)) return undefined;

  const headings = extractHeadings(content);
  const hasFaq = headings.some((h) => /\bfaq\b|frequently asked/i.test(h));
  if (hasFaq) return undefined;
  if (/class=["'][^"']*\bfaq-improvement\b/i.test(content)) return undefined;

  // Static HTML pages need designed sections with CSS, not bare FAQ blocks.
  // Production/visual/interactive upgrade scanners handle those pages.
  if (lower.endsWith(".html")) return undefined;

  if (lower.endsWith(".md") || lower.endsWith(".mdx")) {
    return {
      filepath,
      style: "mdx-section",
      reason: "No FAQ section was found in the visible markdown content.",
      existingHeadings: headings.slice(0, 8),
    };
  }

  return undefined;
}

export function applyFaqSectionPatch(
  content: string,
  p: FaqSectionPatch,
): string {
  const faqs = p.faqs.filter((faq) => faq.question.trim() && faq.answer.trim()).slice(0, 4);
  if (!p.heading.trim() || faqs.length === 0) return content;
  if (p.style === "html-main") return patchHtmlFaqSection(content, p, faqs);
  if (p.style === "mdx-section") return patchMdxFaqSection(content, p, faqs);
  return content;
}

function patchHtmlFaqSection(
  content: string,
  p: FaqSectionPatch,
  faqs: Array<{ question: string; answer: string }>,
): string {
  const section = [
    "",
    '    <section class="content-improvement faq-improvement">',
    `      <h2>${escapeHtml(p.heading)}</h2>`,
    ...faqs.flatMap((faq) => [
      '      <div class="faq-item">',
      `        <h3>${escapeHtml(faq.question)}</h3>`,
      `        <p>${escapeHtml(faq.answer)}</p>`,
      "      </div>",
    ]),
    "    </section>",
    "",
  ].join("\n");

  return content.replace(/<\/main>/i, `${section}</main>`);
}

function patchMdxFaqSection(
  content: string,
  p: FaqSectionPatch,
  faqs: Array<{ question: string; answer: string }>,
): string {
  const section = [
    "",
    `## ${p.heading.trim()}`,
    "",
    ...faqs.flatMap((faq) => [
      `### ${faq.question.trim()}`,
      "",
      faq.answer.trim(),
      "",
    ]),
  ].join("\n");
  return `${content.replace(/\s+$/, "")}\n${section}`;
}

// ----------------------------------------------------------------------------
//  Visual upgrades — structured HTML plus CSS for stronger page presentation.
// ----------------------------------------------------------------------------

export function inspectVisualUpgradeOpportunity(
  content: string,
  filepath: string,
): VisualUpgradeGap | undefined {
  if (!isHtmlWebsitePage(filepath)) return undefined;
  if (!/<main\b[^>]*>[\s\S]*<\/main>/i.test(content)) return undefined;
  if (/class=["'][^"']*\bagent-visual-upgrade\b/i.test(content)) return undefined;

  const stylesheetPath = findStylesheetPath(content, filepath);
  if (!stylesheetPath) return undefined;

  return {
    filepath,
    style: "html-main-css",
    stylesheetPath,
    reason:
      "Page has basic content but no polished conversion-focused visual section with metrics, workflow, and CTA.",
    existingHeadings: extractHeadings(content).slice(0, 8),
  };
}

export function applyVisualUpgradePatch(
  content: string,
  p: VisualUpgradePatch,
): string {
  const metrics = p.metrics
    .filter((metric) => metric.value.trim() && metric.label.trim())
    .slice(0, 3);
  const steps = p.steps
    .filter((step) => step.title.trim() && step.body.trim())
    .slice(0, 3);

  if (!p.heading.trim() || !p.body.trim() || metrics.length === 0 || steps.length === 0) {
    return content;
  }
  if (!isSafeVisualUpgradeCopy(p)) return content;
  const cleaned = removePlainGeneratedSections(content);
  if (/class=["'][^"']*\bagent-visual-upgrade\b/i.test(cleaned)) return cleaned;

  const section = [
    "",
    '    <section class="agent-visual-upgrade" aria-labelledby="agent-visual-upgrade-title">',
    "      <div>",
    `        <p class="upgrade-eyebrow">${escapeHtml(p.eyebrow)}</p>`,
    `        <h2 id="agent-visual-upgrade-title">${escapeHtml(p.heading)}</h2>`,
    `        <p>${escapeHtml(p.body)}</p>`,
    `        <a class="button primary upgrade-cta" href="${escapeHtml(p.ctaHref)}">${escapeHtml(p.ctaText)}</a>`,
    "      </div>",
    '      <div class="upgrade-panel">',
    '        <div class="upgrade-metrics">',
    ...metrics.map((metric) => [
      "          <div>",
      `            <strong>${escapeHtml(metric.value)}</strong>`,
      `            <span>${escapeHtml(metric.label)}</span>`,
      "          </div>",
    ].join("\n")),
    "        </div>",
    '        <ol class="upgrade-steps">',
    ...steps.map((step) => [
      "          <li>",
      `            <strong>${escapeHtml(step.title)}</strong>`,
      `            <span>${escapeHtml(step.body)}</span>`,
      "          </li>",
    ].join("\n")),
    "        </ol>",
    "      </div>",
    "    </section>",
    "",
  ].join("\n");

  return cleaned.replace(/<\/main>/i, `${section}</main>`);
}

export function applyVisualUpgradeStyles(content: string): string {
  if (/MarketPilot agent visual upgrade/i.test(content)) return content;

  const css = [
    "",
    "/* MarketPilot agent visual upgrade */",
    ".agent-visual-upgrade {",
    "  display: grid;",
    "  grid-template-columns: minmax(0, 0.9fr) minmax(320px, 1.1fr);",
    "  gap: 28px;",
    "  align-items: stretch;",
    "  margin: 24px 7vw 72px;",
    "  padding: 32px;",
    "  border: 1px solid rgba(49, 87, 213, 0.18);",
    "  border-radius: 18px;",
    "  background: linear-gradient(135deg, #f8fbff 0%, #eef4ff 100%);",
    "  box-shadow: 0 24px 60px rgba(23, 32, 51, 0.08);",
    "}",
    "",
    ".agent-visual-upgrade h2 {",
    "  margin: 0;",
    "  max-width: 680px;",
    "  font-size: 34px;",
    "  line-height: 1.12;",
    "}",
    "",
    ".agent-visual-upgrade p {",
    "  color: var(--muted);",
    "  font-size: 17px;",
    "  line-height: 1.65;",
    "}",
    "",
    ".upgrade-eyebrow {",
    "  margin: 0 0 10px;",
    "  color: var(--brand);",
    "  font-size: 12px;",
    "  font-weight: 800;",
    "  letter-spacing: 0.08em;",
    "  text-transform: uppercase;",
    "}",
    "",
    ".upgrade-cta {",
    "  margin-top: 14px;",
    "}",
    "",
    ".upgrade-panel {",
    "  display: grid;",
    "  gap: 18px;",
    "}",
    "",
    ".upgrade-metrics {",
    "  display: grid;",
    "  grid-template-columns: repeat(3, minmax(0, 1fr));",
    "  gap: 12px;",
    "}",
    "",
    ".upgrade-metrics div,",
    ".upgrade-steps li {",
    "  border: 1px solid rgba(49, 87, 213, 0.16);",
    "  border-radius: 14px;",
    "  background: rgba(255, 255, 255, 0.82);",
    "  padding: 16px;",
    "}",
    "",
    ".upgrade-metrics strong {",
    "  display: block;",
    "  color: var(--brand-dark);",
    "  font-size: 26px;",
    "  line-height: 1;",
    "}",
    "",
    ".upgrade-metrics span,",
    ".upgrade-steps span {",
    "  display: block;",
    "  margin-top: 6px;",
    "  color: var(--muted);",
    "  font-size: 14px;",
    "  line-height: 1.5;",
    "}",
    "",
    ".upgrade-steps {",
    "  display: grid;",
    "  gap: 12px;",
    "  margin: 0;",
    "  padding: 0;",
    "  list-style: none;",
    "  counter-reset: upgrade-step;",
    "}",
    "",
    ".upgrade-steps li {",
    "  counter-increment: upgrade-step;",
    "}",
    "",
    ".upgrade-steps strong::before {",
    "  content: counter(upgrade-step);",
    "  display: inline-flex;",
    "  align-items: center;",
    "  justify-content: center;",
    "  width: 24px;",
    "  height: 24px;",
    "  margin-right: 10px;",
    "  border-radius: 999px;",
    "  color: #ffffff;",
    "  background: var(--brand);",
    "  font-size: 12px;",
    "}",
    "",
    "@media (max-width: 760px) {",
    "  .agent-visual-upgrade,",
    "  .upgrade-metrics {",
    "    grid-template-columns: 1fr;",
    "  }",
    "",
    "  .agent-visual-upgrade {",
    "    margin: 20px 5vw 52px;",
    "    padding: 22px;",
    "  }",
    "}",
    "",
  ].join("\n");

  return `${content.replace(/\s+$/, "")}\n${css}`;
}

function isSafeVisualUpgradeCopy(p: VisualUpgradePatch): boolean {
  const values = [
    p.eyebrow,
    p.heading,
    p.body,
    p.ctaText,
    p.ctaHref,
    ...p.metrics.flatMap((metric) => [metric.value, metric.label]),
    ...p.steps.flatMap((step) => [step.title, step.body]),
  ];
  return values.every((value) => {
    const text = value.trim();
    if (!text) return false;
    if (/<|>/.test(text)) return false;
    if (text.length > 220) return false;
    if (/[₹$€£]\s?\d|\d+\s?(usd|eur|gbp|inr)\b/i.test(text)) return false;
    if (/\b(refund|guarantee|legal|privacy|terms|copyright)\b/i.test(text)) return false;
    return true;
  });
}

function findStylesheetPath(content: string, filepath: string): string | undefined {
  for (const match of content.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    if (!/\brel\s*=\s*["'][^"']*stylesheet[^"']*["']/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href || /^https?:\/\//i.test(href) || href.startsWith("#")) continue;
    return resolveRepoRelativePath(filepath, href);
  }
  return undefined;
}

function resolveRepoRelativePath(filepath: string, href: string): string {
  const cleanHref = href.split("?")[0].split("#")[0];
  if (cleanHref.startsWith("/")) return cleanHref.replace(/^\/+/, "");

  const folder = filepath.includes("/")
    ? filepath.split("/").slice(0, -1).join("/")
    : "";
  const parts = [...folder.split("/").filter(Boolean), ...cleanHref.split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") resolved.pop();
    else resolved.push(part);
  }
  return resolved.join("/");
}

// ----------------------------------------------------------------------------
//  Production site upgrades — repo-aware static HTML + CSS + link fixes.
// ----------------------------------------------------------------------------

export function applyProductionSiteUpgradePatch(
  content: string,
  p: ProductionSiteUpgradePatch,
): string {
  if (!isSafeProductionUpgradeCopy(p)) return content;

  let next = removePlainGeneratedSections(content);
  for (const repair of p.linkRepairs ?? []) {
    next = replaceHref(next, repair.currentHref, repair.replacementHref);
  }
  if (p.fixDuplicateH1?.replacementLead) {
    next = replaceExtraH1sWithLead(next, p.fixDuplicateH1.replacementLead);
  }

  const section = buildProductionUpgradeSection(p);
  if (!section) return next;
  if (/class=["'][^"']*\bproduction-upgrade\b/i.test(next)) return next;
  return insertBeforeGeneratedSectionOrMainEnd(next, section);
}

export function applyProductionSiteUpgradeStyles(content: string): string {
  if (/MarketPilot production site upgrade/i.test(content)) return content;

  const css = [
    "",
    "/* MarketPilot production site upgrade */",
    ".page-lede {",
    "  max-width: 780px;",
    "  color: var(--muted);",
    "  font-size: 18px;",
    "  line-height: 1.65;",
    "}",
    "",
    ".production-upgrade {",
    "  margin: 28px 7vw 72px;",
    "  padding: 34px;",
    "  border: 1px solid rgba(23, 32, 51, 0.1);",
    "  border-radius: 18px;",
    "  background: #ffffff;",
    "  box-shadow: 0 22px 70px rgba(23, 32, 51, 0.08);",
    "}",
    "",
    ".production-upgrade__header {",
    "  display: grid;",
    "  grid-template-columns: minmax(0, 1fr) auto;",
    "  gap: 24px;",
    "  align-items: end;",
    "}",
    "",
    ".production-upgrade__eyebrow {",
    "  margin: 0 0 10px;",
    "  color: var(--brand);",
    "  font-size: 12px;",
    "  font-weight: 800;",
    "  letter-spacing: 0.08em;",
    "  text-transform: uppercase;",
    "}",
    "",
    ".production-upgrade h2 {",
    "  margin: 0;",
    "  max-width: 720px;",
    "  font-size: 34px;",
    "  line-height: 1.14;",
    "}",
    "",
    ".production-upgrade p {",
    "  color: var(--muted);",
    "  font-size: 16px;",
    "  line-height: 1.65;",
    "}",
    "",
    ".production-highlights,",
    ".production-comparison {",
    "  margin-top: 24px;",
    "}",
    "",
    ".production-highlights {",
    "  display: grid;",
    "  grid-template-columns: repeat(3, minmax(0, 1fr));",
    "  gap: 14px;",
    "}",
    "",
    ".production-highlights article {",
    "  border-radius: 14px;",
    "  background: var(--soft);",
    "}",
    "",
    ".production-comparison {",
    "  width: 100%;",
    "  border-collapse: collapse;",
    "  overflow: hidden;",
    "  border-radius: 14px;",
    "  font-size: 14px;",
    "}",
    "",
    ".production-comparison th,",
    ".production-comparison td {",
    "  padding: 14px;",
    "  border-bottom: 1px solid var(--line);",
    "  text-align: left;",
    "  vertical-align: top;",
    "}",
    "",
    ".production-comparison th {",
    "  background: var(--soft);",
    "  color: var(--ink);",
    "}",
    "",
    ".production-comparison tr:last-child td {",
    "  border-bottom: 0;",
    "}",
    "",
    "@media (max-width: 760px) {",
    "  .production-upgrade__header,",
    "  .production-highlights {",
    "    grid-template-columns: 1fr;",
    "  }",
    "",
    "  .production-upgrade {",
    "    margin: 20px 5vw 52px;",
    "    padding: 22px;",
    "  }",
    "",
    "  .production-comparison {",
    "    display: block;",
    "    overflow-x: auto;",
    "  }",
    "}",
    "",
  ].join("\n");

  return `${content.replace(/\s+$/, "")}\n${css}`;
}

export function applyInteractiveConversionUpgradePatch(
  content: string,
  p: InteractiveConversionUpgradePatch,
): string {
  if (!isSafeInteractiveConversionUpgradeCopy(p)) return content;
  const cleaned = removePlainGeneratedSections(content);
  if (/class=["'][^"']*\binteractive-conversion\b/i.test(cleaned)) return cleaned;

  const section = buildInteractiveConversionUpgradeSection(p);
  if (!section) return cleaned;
  return insertBeforeGeneratedSectionOrMainEnd(cleaned, section);
}

export function applyInteractiveConversionUpgradeStyles(content: string): string {
  if (/MarketPilot interactive conversion upgrade/i.test(content)) return content;

  const css = [
    "",
    "/* MarketPilot interactive conversion upgrade */",
    ".interactive-conversion {",
    "  margin: 28px 7vw 72px;",
    "  padding: 34px;",
    "  border: 1px solid rgba(49, 87, 213, 0.16);",
    "  border-radius: 18px;",
    "  background: linear-gradient(135deg, #ffffff 0%, #f8fbff 100%);",
    "  box-shadow: 0 24px 80px rgba(23, 32, 51, 0.1);",
    "}",
    "",
    ".interactive-conversion__grid {",
    "  display: grid;",
    "  grid-template-columns: minmax(0, 1fr) minmax(300px, 420px);",
    "  gap: 28px;",
    "  align-items: start;",
    "}",
    "",
    ".interactive-conversion__eyebrow {",
    "  margin: 0 0 10px;",
    "  color: var(--brand);",
    "  font-size: 12px;",
    "  font-weight: 800;",
    "  letter-spacing: 0.08em;",
    "  text-transform: uppercase;",
    "}",
    "",
    ".interactive-conversion h2 {",
    "  margin: 0;",
    "  max-width: 720px;",
    "  font-size: 34px;",
    "  line-height: 1.14;",
    "}",
    "",
    ".interactive-conversion p {",
    "  color: var(--muted);",
    "  line-height: 1.65;",
    "}",
    "",
    ".conversion-calculator {",
    "  display: grid;",
    "  gap: 14px;",
    "  padding: 22px;",
    "  border: 1px solid var(--line);",
    "  border-radius: 16px;",
    "  background: #ffffff;",
    "}",
    "",
    ".conversion-calculator h3 {",
    "  margin: 0;",
    "  font-size: 18px;",
    "}",
    "",
    ".conversion-field {",
    "  display: grid;",
    "  gap: 6px;",
    "  color: var(--ink);",
    "  font-size: 13px;",
    "  font-weight: 700;",
    "}",
    "",
    ".conversion-field input {",
    "  width: 100%;",
    "  box-sizing: border-box;",
    "  border: 1px solid var(--line);",
    "  border-radius: 12px;",
    "  padding: 11px 12px;",
    "  color: var(--ink);",
    "  font: inherit;",
    "}",
    "",
    ".conversion-result {",
    "  display: block;",
    "  border-radius: 14px;",
    "  background: var(--ink);",
    "  color: #ffffff;",
    "  padding: 16px;",
    "  font-size: 18px;",
    "  font-weight: 800;",
    "}",
    "",
    ".conversion-recommendations {",
    "  display: grid;",
    "  grid-template-columns: repeat(3, minmax(0, 1fr));",
    "  gap: 12px;",
    "  margin-top: 22px;",
    "}",
    "",
    ".conversion-recommendations article {",
    "  border-radius: 14px;",
    "  background: #ffffff;",
    "  border: 1px solid var(--line);",
    "}",
    "",
    "@media (max-width: 860px) {",
    "  .interactive-conversion__grid,",
    "  .conversion-recommendations {",
    "    grid-template-columns: 1fr;",
    "  }",
    "",
    "  .interactive-conversion {",
    "    margin: 20px 5vw 52px;",
    "    padding: 22px;",
    "  }",
    "}",
    "",
  ].join("\n");

  return `${content.replace(/\s+$/, "")}\n${css}`;
}

function buildInteractiveConversionUpgradeSection(
  p: InteractiveConversionUpgradePatch,
): string {
  const recommendations = p.section.recommendations
    .filter((item) => item.title.trim() && item.body.trim())
    .slice(0, 3);
  if (
    !p.section.heading.trim() ||
    !p.section.body.trim() ||
    !p.section.calculatorTitle.trim() ||
    recommendations.length === 0
  ) {
    return "";
  }

  return [
    "",
    '    <section class="interactive-conversion" aria-labelledby="interactive-conversion-title">',
    '      <div class="interactive-conversion__grid">',
    "        <div>",
    `          <p class="interactive-conversion__eyebrow">${escapeHtml(p.section.eyebrow)}</p>`,
    `          <h2 id="interactive-conversion-title">${escapeHtml(p.section.heading)}</h2>`,
    `          <p>${escapeHtml(p.section.body)}</p>`,
    '          <div class="conversion-recommendations">',
    ...recommendations.map((item) => [
      "            <article>",
      `              <h3>${escapeHtml(item.title)}</h3>`,
      `              <p>${escapeHtml(item.body)}</p>`,
      "            </article>",
    ].join("\n")),
    "          </div>",
    "        </div>",
    '        <form class="conversion-calculator" data-conversion-calculator>',
    `          <h3>${escapeHtml(p.section.calculatorTitle)}</h3>`,
    "          <label class=\"conversion-field\">",
    `            ${escapeHtml(p.section.inputLabels.visitors)}`,
    '            <input type="number" min="0" step="100" value="1200" data-conversion-visitors />',
    "          </label>",
    "          <label class=\"conversion-field\">",
    `            ${escapeHtml(p.section.inputLabels.conversionRate)}`,
    '            <input type="number" min="0" max="100" step="0.1" value="2.5" data-conversion-rate />',
    "          </label>",
    "          <label class=\"conversion-field\">",
    `            ${escapeHtml(p.section.inputLabels.averageValue)}`,
    '            <input type="number" min="0" step="10" value="75" data-conversion-value />',
    "          </label>",
    `          <output class="conversion-result" data-conversion-result aria-live="polite">${escapeHtml(p.section.resultLabel)}: $2,250</output>`,
    `          <a class="button primary" href="${escapeHtml(p.section.ctaHref)}">${escapeHtml(p.section.ctaText)}</a>`,
    "        </form>",
    "      </div>",
    "      <script>",
    "        (() => {",
    "          const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });",
    "          document.querySelectorAll('[data-conversion-calculator]').forEach((form) => {",
    "            const visitors = form.querySelector('[data-conversion-visitors]');",
    "            const rate = form.querySelector('[data-conversion-rate]');",
    "            const value = form.querySelector('[data-conversion-value]');",
    "            const result = form.querySelector('[data-conversion-result]');",
    "            const update = () => {",
    "              const visitorCount = Number(visitors.value) || 0;",
    "              const conversionRate = Number(rate.value) || 0;",
    "              const averageValue = Number(value.value) || 0;",
    "              const monthlyValue = visitorCount * (conversionRate / 100) * averageValue;",
    `              result.textContent = '${escapeJsString(p.section.resultLabel)}: ' + currency.format(monthlyValue);`,
    "            };",
    "            form.addEventListener('input', update);",
    "            form.addEventListener('submit', (event) => event.preventDefault());",
    "            update();",
    "          });",
    "        })();",
    "      </script>",
    "    </section>",
    "",
  ].join("\n");
}

function buildProductionUpgradeSection(p: ProductionSiteUpgradePatch): string {
  const highlights = p.section.highlights
    .filter((item) => item.title.trim() && item.body.trim())
    .slice(0, 3);
  if (!p.section.heading.trim() || !p.section.body.trim() || highlights.length === 0) {
    return "";
  }

  const comparisonRows = (p.section.comparisonRows ?? [])
    .filter((row) => row.feature.trim() && row.starter.trim() && row.growth.trim() && row.scale.trim())
    .slice(0, 5);

  return [
    "",
    '    <section class="production-upgrade" aria-labelledby="production-upgrade-title">',
    '      <div class="production-upgrade__header">',
    "        <div>",
    `          <p class="production-upgrade__eyebrow">${escapeHtml(p.section.eyebrow)}</p>`,
    `          <h2 id="production-upgrade-title">${escapeHtml(p.section.heading)}</h2>`,
    `          <p>${escapeHtml(p.section.body)}</p>`,
    "        </div>",
    `        <a class="button primary" href="${escapeHtml(p.section.ctaHref)}">${escapeHtml(p.section.ctaText)}</a>`,
    "      </div>",
    '      <div class="production-highlights">',
    ...highlights.map((item) => [
      "        <article>",
      `          <h3>${escapeHtml(item.title)}</h3>`,
      `          <p>${escapeHtml(item.body)}</p>`,
      "        </article>",
    ].join("\n")),
    "      </div>",
    ...(comparisonRows.length > 0
      ? [
          '      <table class="production-comparison">',
          "        <thead>",
          "          <tr><th>Feature</th><th>Starter</th><th>Growth</th><th>Scale</th></tr>",
          "        </thead>",
          "        <tbody>",
          ...comparisonRows.map((row) =>
            `          <tr><td>${escapeHtml(row.feature)}</td><td>${escapeHtml(row.starter)}</td><td>${escapeHtml(row.growth)}</td><td>${escapeHtml(row.scale)}</td></tr>`,
          ),
          "        </tbody>",
          "      </table>",
        ]
      : []),
    "    </section>",
    "",
  ].join("\n");
}

function replaceHref(content: string, currentHref: string, replacementHref: string): string {
  if (!currentHref || !replacementHref) return content;
  const escaped = escapeRegex(currentHref);
  return content.replace(
    new RegExp(`href=(["'])${escaped}\\1`, "g"),
    `href="${replacementHref}"`,
  );
}

function replaceExtraH1sWithLead(content: string, replacementLead: string): string {
  const mainMatch = content.match(/(<main\b[^>]*>)([\s\S]*?)(<\/main>)/i);
  if (!mainMatch) return content;

  let h1Count = 0;
  let changed = false;
  const nextMain = mainMatch[2].replace(/<h1\b([^>]*)>([\s\S]*?)<\/h1>/gi, (full) => {
    h1Count++;
    if (h1Count === 1) return full;
    changed = true;
    return `<p class="page-lede">${escapeHtml(replacementLead)}</p>`;
  });

  if (!changed) return content;
  return content.replace(mainMatch[0], `${mainMatch[1]}${nextMain}${mainMatch[3]}`);
}

function insertBeforeGeneratedSectionOrMainEnd(content: string, section: string): string {
  const generated = content.match(/\s*<section\b[^>]*class=["'][^"']*\bcontent-improvement\b[^"']*["'][^>]*>/i);
  if (generated?.index !== undefined) {
    return `${content.slice(0, generated.index)}${section}${content.slice(generated.index)}`;
  }
  return content.replace(/<\/main>/i, `${section}</main>`);
}

function isSafeProductionUpgradeCopy(p: ProductionSiteUpgradePatch): boolean {
  const values = [
    p.filepath,
    p.stylesheetPath,
    p.fixDuplicateH1?.replacementLead ?? "safe",
    ...(p.linkRepairs ?? []).flatMap((repair) => [repair.currentHref, repair.replacementHref]),
    p.section.eyebrow,
    p.section.heading,
    p.section.body,
    p.section.ctaText,
    p.section.ctaHref,
    ...p.section.highlights.flatMap((item) => [item.title, item.body]),
    ...(p.section.comparisonRows ?? []).flatMap((row) => [
      row.feature,
      row.starter,
      row.growth,
      row.scale,
    ]),
  ];

  return values.every((value) => {
    const text = value.trim();
    if (!text) return false;
    if (/<|>/.test(text)) return false;
    if (text.length > 240) return false;
    if (/[₹€£]\s?\d|\d+\s?(eur|gbp|inr)\b/i.test(text)) return false;
    if (/\b(refund|guarantee|legal|privacy|terms|copyright)\b/i.test(text)) return false;
    return true;
  });
}

function isSafeInteractiveConversionUpgradeCopy(
  p: InteractiveConversionUpgradePatch,
): boolean {
  const values = [
    p.filepath,
    p.stylesheetPath,
    p.section.eyebrow,
    p.section.heading,
    p.section.body,
    p.section.calculatorTitle,
    p.section.inputLabels.visitors,
    p.section.inputLabels.conversionRate,
    p.section.inputLabels.averageValue,
    p.section.resultLabel,
    p.section.ctaText,
    p.section.ctaHref,
    ...p.section.recommendations.flatMap((item) => [item.title, item.body]),
  ];

  return values.every((value) => {
    const text = value.trim();
    if (!text) return false;
    if (/<|>/.test(text)) return false;
    if (text.length > 220) return false;
    if (/[₹€£]\s?\d|\d+\s?(eur|gbp|inr)\b/i.test(text)) return false;
    if (/\b(refund|guarantee|legal|privacy|terms|copyright)\b/i.test(text)) return false;
    return true;
  });
}

function readMainHtml(content: string): string {
  return content.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1] ?? "";
}

function stripGeneratedSections(html: string): string {
  return removePlainGeneratedSections(html);
}

function hasPlainGeneratedSection(content: string): boolean {
  return /<section\b[^>]*class=["'][^"']*\b(content-improvement|faq-improvement)\b[^"']*["'][^>]*>/i.test(content);
}

function removePlainGeneratedSections(content: string): string {
  return content.replace(
    /\s*<section\b[^>]*class=["'][^"']*\b(?:content-improvement|faq-improvement)\b[^"']*["'][^>]*>[\s\S]*?<\/section>\s*/gi,
    "\n",
  );
}

function normalizeVisibleText(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSafeRewriteTarget(
  tagName: "h1" | "h2" | "p",
  attrs: string,
  text: string,
): boolean {
  if (!text) return false;
  if (/\b(nav|footer|button|price|legal|disclaimer)\b/i.test(attrs)) return false;
  if (/[₹$€£]\s?\d|\d+\s?(usd|eur|gbp|inr)\b/i.test(text)) return false;
  if (/\b(terms|privacy|copyright|refund|guarantee)\b/i.test(text)) return false;

  if (tagName === "p") return text.length >= 30 && text.length <= 240;
  return text.length >= 4 && text.length <= 100;
}

function isSafeReplacement(currentText: string, replacementText: string): boolean {
  const next = replacementText.trim();
  if (!next || next === currentText.trim()) return false;
  if (next.length > 180) return false;
  if (/[₹$€£]\s?\d|\d+\s?(usd|eur|gbp|inr)\b/i.test(next)) return false;
  if (/<|>/.test(next)) return false;
  return true;
}

function parseCopyTargetId(targetId: string): { tagName: "h1" | "h2" | "p"; index: number } | undefined {
  const match = targetId.match(/^copy:(h1|h2|p):(\d+)$/);
  if (!match) return undefined;
  return {
    tagName: match[1] as "h1" | "h2" | "p",
    index: Number(match[2]),
  };
}

function copyRewriteReason(tagName: "h1" | "h2" | "p", filepath: string): string {
  if (tagName === "h1") return "Hero headline can be clearer and more benefit-led.";
  if (tagName === "h2") return "Section heading can be more specific and outcome-focused.";
  if (filepath.toLowerCase().includes("pricing")) {
    return "Pricing explanation can be clearer without changing prices or plan details.";
  }
  return "Intro paragraph can explain the value more clearly.";
}

async function collectSourceFiles(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  currentPath: string,
  out: RepoFile[],
  maxFiles: number,
): Promise<void> {
  if (out.length >= maxFiles) return;

  try {
    const content = await octokit.rest.repos.getContent({
      owner,
      repo,
      path: currentPath,
      ref,
    });

    if (Array.isArray(content.data)) {
      for (const item of content.data) {
        if (out.length >= maxFiles) break;
        if (item.type === "dir") {
          await collectSourceFiles(octokit, owner, repo, ref, item.path, out, maxFiles);
        } else if (item.type === "file" && isSourceFile(item.path)) {
          out.push({ path: item.path, sha: item.sha });
        }
      }
      return;
    }

    if (content.data.type === "file" && isSourceFile(content.data.path)) {
      out.push({ path: content.data.path, sha: content.data.sha });
    }
  } catch (err) {
    // Missing folders are normal across different frameworks; skip them.
    const status = (err as { status?: number }).status;
    if (status !== 404) throw err;
  }
}

async function readRepoFile(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string> {
  const file = await octokit.rest.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(file.data) || file.data.type !== "file") return "";
  return Buffer.from(file.data.content, "base64").toString("utf8");
}

async function readRepoFileIfExists(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string | undefined> {
  try {
    return await readRepoFile(octokit, owner, repo, path, ref);
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404) return undefined;
    throw err;
  }
}

function collectSeoFixVerificationFilepaths(
  input: SeoFixVerificationInput,
): string[] {
  const paths = new Set<string>();
  for (const patch of input.altText ?? []) paths.add(patch.filepath);
  for (const patch of input.pageMetadata ?? []) paths.add(patch.filepath);
  for (const patch of input.visibleContent ?? []) paths.add(patch.filepath);
  for (const patch of input.copyRewrite ?? []) paths.add(patch.filepath);
  for (const patch of input.ctaRewrite ?? []) paths.add(patch.filepath);
  for (const patch of input.faqSection ?? []) paths.add(patch.filepath);
  for (const patch of input.visualUpgrade ?? []) {
    paths.add(patch.filepath);
    paths.add(patch.stylesheetPath);
  }
  for (const patch of input.productionUpgrade ?? []) {
    paths.add(patch.filepath);
    paths.add(patch.stylesheetPath);
  }
  for (const patch of input.interactiveConversionUpgrade ?? []) {
    paths.add(patch.filepath);
    paths.add(patch.stylesheetPath);
  }
  return Array.from(paths);
}

function buildSeoFixExpectedChecks(
  input: SeoFixVerificationInput,
  contents: Map<string, string | undefined>,
): ExpectedChangeCheck[] {
  const checks: ExpectedChangeCheck[] = [];

  for (const patch of input.altText ?? []) {
    const content = contents.get(patch.filepath);
    addContentCheck(checks, {
      kind: "altText",
      filepath: patch.filepath,
      target: patch.imageSrc,
      content,
      expected: [patch.imageSrc, patch.altText],
      successMessage: `Found alt text for ${patch.imageSrc}.`,
      failureMessage: `Could not find the image source and new alt text for ${patch.imageSrc}.`,
    });
  }

  for (const patch of input.pageMetadata ?? []) {
    const expected = [patch.title, patch.description].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );
    if (expected.length === 0) continue;
    addContentCheck(checks, {
      kind: "pageMetadata",
      filepath: patch.filepath,
      target: "title-description",
      content: contents.get(patch.filepath),
      expected,
      successMessage: "Found the expected title/description text.",
      failureMessage: "Could not find the expected title/description text.",
    });
  }

  for (const patch of input.visibleContent ?? []) {
    addContentCheck(checks, {
      kind: "visibleContent",
      filepath: patch.filepath,
      target: patch.heading,
      content: contents.get(patch.filepath),
      expected: [patch.heading, patch.body],
      successMessage: `Found visible section "${patch.heading}".`,
      failureMessage: `Could not find visible section "${patch.heading}".`,
    });
  }

  for (const patch of input.copyRewrite ?? []) {
    addContentCheck(checks, {
      kind: "copyRewrite",
      filepath: patch.filepath,
      target: patch.targetId,
      content: contents.get(patch.filepath),
      expected: [patch.replacementText],
      successMessage: `Found rewritten copy for ${patch.targetId}.`,
      failureMessage: `Could not find rewritten copy for ${patch.targetId}.`,
    });
  }

  for (const patch of input.ctaRewrite ?? []) {
    addContentCheck(checks, {
      kind: "ctaRewrite",
      filepath: patch.filepath,
      target: patch.targetId,
      content: contents.get(patch.filepath),
      expected: [patch.replacementText],
      successMessage: `Found rewritten CTA for ${patch.targetId}.`,
      failureMessage: `Could not find rewritten CTA for ${patch.targetId}.`,
    });
  }

  for (const patch of input.faqSection ?? []) {
    addContentCheck(checks, {
      kind: "faqSection",
      filepath: patch.filepath,
      target: patch.heading,
      content: contents.get(patch.filepath),
      expected: [
        patch.heading,
        ...patch.faqs.map((faq) => faq.question),
      ],
      successMessage: `Found FAQ section "${patch.heading}".`,
      failureMessage: `Could not find FAQ section "${patch.heading}".`,
    });
  }

  for (const patch of input.visualUpgrade ?? []) {
    addContentCheck(checks, {
      kind: "visualUpgrade",
      filepath: patch.filepath,
      target: patch.heading,
      content: contents.get(patch.filepath),
      expected: ["agent-visual-upgrade", patch.heading, patch.ctaText],
      successMessage: `Found visual upgrade section "${patch.heading}".`,
      failureMessage: `Could not find visual upgrade section "${patch.heading}".`,
    });
    addContentCheck(checks, {
      kind: "visualUpgradeStyles",
      filepath: patch.stylesheetPath,
      target: "agent-visual-upgrade CSS",
      content: contents.get(patch.stylesheetPath),
      expected: ["MarketPilot agent visual upgrade", ".agent-visual-upgrade"],
      successMessage: "Found visual upgrade CSS.",
      failureMessage: "Could not find visual upgrade CSS.",
    });
  }

  for (const patch of input.productionUpgrade ?? []) {
    const expectedPageText = [
      "production-upgrade",
      patch.section.heading,
      patch.section.ctaText,
      patch.fixDuplicateH1?.replacementLead,
      ...(patch.linkRepairs ?? []).map((repair) => repair.replacementHref),
    ].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    );

    addContentCheck(checks, {
      kind: "productionUpgrade",
      filepath: patch.filepath,
      target: patch.section.heading,
      content: contents.get(patch.filepath),
      expected: expectedPageText,
      successMessage: `Found production upgrade section "${patch.section.heading}".`,
      failureMessage: `Could not find production upgrade section "${patch.section.heading}".`,
    });
    addContentCheck(checks, {
      kind: "productionUpgradeStyles",
      filepath: patch.stylesheetPath,
      target: "production-upgrade CSS",
      content: contents.get(patch.stylesheetPath),
      expected: ["MarketPilot production site upgrade", ".production-upgrade"],
      successMessage: "Found production upgrade CSS.",
      failureMessage: "Could not find production upgrade CSS.",
    });
  }

  for (const patch of input.interactiveConversionUpgrade ?? []) {
    addContentCheck(checks, {
      kind: "interactiveConversionUpgrade",
      filepath: patch.filepath,
      target: patch.section.heading,
      content: contents.get(patch.filepath),
      expected: [
        "interactive-conversion",
        "data-conversion-calculator",
        patch.section.heading,
        patch.section.calculatorTitle,
        patch.section.ctaText,
      ],
      successMessage: `Found interactive conversion section "${patch.section.heading}".`,
      failureMessage: `Could not find interactive conversion section "${patch.section.heading}".`,
    });
    addContentCheck(checks, {
      kind: "interactiveConversionUpgradeStyles",
      filepath: patch.stylesheetPath,
      target: "interactive-conversion CSS",
      content: contents.get(patch.stylesheetPath),
      expected: ["MarketPilot interactive conversion upgrade", ".interactive-conversion"],
      successMessage: "Found interactive conversion CSS.",
      failureMessage: "Could not find interactive conversion CSS.",
    });
  }

  return checks;
}

function addContentCheck(
  checks: ExpectedChangeCheck[],
  input: {
    kind: string;
    filepath: string;
    target: string;
    content: string | undefined;
    expected: string[];
    successMessage: string;
    failureMessage: string;
  },
): void {
  const content = input.content;
  const passed =
    content !== undefined &&
    input.expected.every((expected) => contentIncludes(content, expected));
  checks.push({
    kind: input.kind,
    filepath: input.filepath,
    target: input.target,
    passed,
    message:
      content === undefined
        ? `Could not read ${input.filepath} from the default branch.`
        : passed
          ? input.successMessage
          : input.failureMessage,
  });
}

function contentIncludes(content: string, expected: string): boolean {
  return normalizeForVerification(content).includes(
    normalizeForVerification(expected),
  );
}

function normalizeForVerification(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

function summarizePullRequestStatus(
  state: ExternalWriteStatus["state"],
  prUrl: string,
): string {
  if (state === "merged") return `GitHub says this pull request was merged: ${prUrl}`;
  if (state === "open") return `GitHub says this pull request is still open: ${prUrl}`;
  if (state === "closed") {
    return `GitHub says this pull request was closed without a merge: ${prUrl}`;
  }
  return `GitHub pull request status is ${state}: ${prUrl}`;
}

function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSIONS.some((ext) => path.toLowerCase().endsWith(ext));
}

function prioritizeVisibleContentFiles(files: RepoFile[]): RepoFile[] {
  const htmlFiles = files.filter((file) => isHtmlWebsitePage(file.path));
  const candidates = htmlFiles.length > 0
    ? htmlFiles
    : files.filter((file) => isVisibleMdxWebsitePage(file.path));

  return candidates.sort((a, b) => {
    const ap = visibleContentPriority(a.path);
    const bp = visibleContentPriority(b.path);
    if (ap !== bp) return ap - bp;
    return a.path.localeCompare(b.path);
  });
}

function isHtmlWebsitePage(path: string): boolean {
  const lower = normalizeRepoPath(path);
  if (!lower.endsWith(".html")) return false;
  if (lower.includes("/node_modules/") || lower.includes("/dist/")) return false;
  return true;
}

function isVisibleMdxWebsitePage(path: string): boolean {
  const lower = normalizeRepoPath(path);
  if (isReadmeFile(lower)) return false;
  if (!lower.endsWith(".md") && !lower.endsWith(".mdx")) return false;
  return (
    lower === "content/pages/home.mdx" ||
    lower === "content/pages/index.mdx" ||
    lower === "pages/index.mdx" ||
    lower === "app/page.mdx"
  );
}

function visibleContentPriority(path: string): number {
  const lower = normalizeRepoPath(path);
  if (lower === "index.html") return 0;
  if (/^[^/]+\.html$/.test(lower)) return 10;
  if (lower.startsWith("blog/") && lower.endsWith(".html")) return 20;
  if (lower.endsWith(".html")) return 30;
  if (lower.includes("home") || lower.includes("index")) return 40;
  return 99;
}

function normalizeRepoPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function isReadmeFile(path: string): boolean {
  const lower = normalizeRepoPath(path);
  return lower === "readme.md" || lower.endsWith("/readme.md");
}

function uniqueFiles(files: RepoFile[]): RepoFile[] {
  const seen = new Set<string>();
  const out: RepoFile[] = [];
  for (const file of files) {
    if (seen.has(file.path)) continue;
    seen.add(file.path);
    out.push(file);
  }
  return out;
}

// Scan a source file for images missing alt text. Handles three patterns:
//
//   1. Raw HTML <img src="..."> (no alt or empty alt)
//   2. JSX <Image src="..." /> from next/image (no alt or empty alt)
//   3. Markdown ![alt](src) where the alt is empty: ![](src) or ![ ](src)
//
// Previously only #1 was caught, so MDX/markdown sites slipped through with
// "no gaps found" — that's a chunk of the "sometimes works, sometimes not"
// flakiness in the SEO flow.
export function findMissingAltText(
  content: string,
  filepath: string,
): AltTextGap[] {
  const gaps: AltTextGap[] = [];

  // 1. HTML <img ...>  and  2. JSX <Image ... />
  // We accept either tag and check the alt attribute. JSX is permissive about
  // quoting (alt={"..."}) — we treat any non-empty alt attribute as "has alt"
  // so we don't second-guess valid JSX.
  const tagRegex = /<(img|Image)\b[^>]*>/gi;
  const srcRegex = /\bsrc\s*=\s*["']([^"']+)["']/i;
  const altLiteralRegex = /\balt\s*=\s*["']([^"']*)["']/i;
  const altExpressionRegex = /\balt\s*=\s*\{[^}]+\}/i;

  for (const match of content.matchAll(tagRegex)) {
    const tag = match[0];
    const src = tag.match(srcRegex)?.[1];
    if (!src) continue;

    // alt={...} JSX expression — assume non-empty if it exists.
    if (altExpressionRegex.test(tag)) continue;
    const altMatch = tag.match(altLiteralRegex);
    if (altMatch && altMatch[1].trim().length > 0) continue;

    gaps.push({
      filepath,
      imageSrc: src,
      line: lineNumberAt(content, match.index ?? 0),
    });
  }

  // 3. Markdown ![alt](src) — only flag if the alt slot is empty/whitespace.
  // Anchored on ! so links like [text](url) don't match. We allow optional
  // "title" suffixes like ![](src "title").
  const mdImageRegex = /!\[(.*?)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of content.matchAll(mdImageRegex)) {
    const alt = match[1] ?? "";
    const src = match[2];
    if (!src) continue;
    if (alt.trim().length > 0) continue;
    gaps.push({
      filepath,
      imageSrc: src,
      line: lineNumberAt(content, match.index ?? 0),
    });
  }

  return gaps;
}

function lineNumberAt(content: string, index: number): number {
  return content.slice(0, index).split(/\r?\n/).length;
}
