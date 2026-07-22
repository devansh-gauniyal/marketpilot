"use client";

/**
 * MarketPilot AI — main dashboard page.
 *
 * Single-file UI that matches the Stitch design with 3 screens:
 *   1. Dashboard           (default home)
 *   2. Campaigns           (agent run detail / SEO audit trace)
 *   3. Product Profile     (setup form)
 *
 * Other sidebar items render a friendly placeholder so the nav feels complete.
 *
 * Per AGENTS.md: mock data only, simple/readable React, no new packages.
 * Backend wiring (calling /api/agent) will be added in a follow-up.
 */

import { useEffect, useState, type ReactNode } from "react";
import type {
  CompetitorProfileOutput,
  StructuredOutput,
} from "./lib/output-types";
import { StructuredOutputList } from "./components/structured-output";
import {
  checkGitHubConnectionHealth,
  createConnection,
  disconnectGitHub,
  getGitHubOAuthSettings,
  githubOAuthStartUrl,
  listSkills,
  listConnections,
  listGitHubRepositories,
  startAgentRun,
  updateConnection,
  type BriefField,
  type ConnectionRecord,
  type GitHubConnectionHealth,
  type GitHubOAuthSettings,
  type GitHubRepository,
  type SkillOption,
} from "./lib/api";

/* =====================================================================
   API CONFIG
   ===================================================================== */

const BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ?? "http://localhost:4000";

/* =====================================================================
   TYPES
   ===================================================================== */

type NavId =
  | "dashboard"
  | "campaigns"
  | "agents"
  | "drafts"
  | "proposed-actions"
  | "seo-reports"
  | "product-profile"
  | "integrations"
  | "settings";

type TopTab = "workspace" | "intel" | "setup";

type ApprovalProposedAction = SeoFixInput & {
  actionId?: string;
  type?: string;
  title?: string;
  description?: string;
  toolName?: string;
  reason?: string;
  requiresApproval?: boolean;
};

// Backend approval record (matches backend/src/lib/store/types.ts → Approval)
type Approval = {
  id: string;
  workspaceId: string;
  skillRunId: string;
  toolCallId: string;
  title: string;
  summary: string;
  reasoning: string;
  proposedActionJson: ApprovalProposedAction;
  expectedImpact: string;
  rollbackPlan: string;
  status: "pending" | "approved" | "rejected" | "modified" | "expired";
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  createdAt: string;
};

/* =====================================================================
   MOCK DATA
   ===================================================================== */

// "Acme Growth 2024" campaign card on the dashboard.
const featuredCampaign = {
  name: "Acme Growth 2024",
  skills: ["SEO", "CRO", "PAID"],
  note: "SEO Audit will read your sitemap + GSC data and recommend structural changes.",
};

// Console-style trace lines for the SEO Audit run detail page.
const traceLines = [
  { t: "12:30:01", kind: "system", text: "Initializing agent 'MarketPilot-SEO-V4'" },
  { t: "12:30:04", kind: "call", text: 'tool_call: fetch_sitemap(url="acme.so")' },
  {
    t: "12:30:18",
    kind: "result",
    text: "tool_result: 142 pages found successfully. Mapping structures…",
  },
  {
    t: "12:31:12",
    kind: "call",
    text: 'tool_call: analyze_keywords(competitors=["globo.ai", "zenith.co"])',
  },
  {
    t: "12:32:45",
    kind: "thought",
    text:
      "thought: Observed gap in long-tail 'autonomous scheduling' queries. Acme.so lacks dedicated landing pages for enterprise API integrations.",
  },
  { t: "12:34:22", kind: "call", text: "tool_call: crawl_technical_seo(depth=3)" },
  {
    t: "12:34:55",
    kind: "error",
    text:
      "tool_result: Critical error: 14 pages returning 404. Metadata missing on 22 assets.",
  },
  { t: "12:35:10", kind: "live", text: "Reading competitor pricing strategy…" },
];

// Stats shown next to the trace on the run detail page.
const runStats = [
  { label: "HEALTH SCORE", value: "84", delta: "+4%" },
  { label: "KEYWORD GAP", value: "1.2k", delta: "↗" },
  { label: "PRIORITY FIXES", value: "12", delta: "High" },
];

// Competitor keyword opportunities.
const keywordOpps = [
  {
    id: "01",
    title: '"Autonomous Workflow Engine"',
    note: "Competitor Globo.ai ranks #1. Acme.so not found.",
  },
  {
    id: "02",
    title: '"Enterprise Marketing Automation V4"',
    note: "Zenith.co gaining 15% traffic share weekly.",
  },
];

// Technical fix tiles.
const techFixes = [
  {
    id: "tf1",
    sev: "CRITICAL",
    title: "Broken Backlinks",
    body: "14 high-authority internal links lead to 404 pages.",
    cta: "View All →",
  },
  {
    id: "tf2",
    sev: "MEDIUM",
    title: "Alt-Text Missing",
    body: "22 visual assets missing descriptive metadata for SEO.",
    cta: "Auto-Fix ✦",
  },
];

/* =====================================================================
   ROOT COMPONENT
   ===================================================================== */

export default function Home() {
  const [nav, setNav] = useState<NavId>("dashboard");
  const [topTab, setTopTab] = useState<TopTab>("workspace");
  const [newRunOpen, setNewRunOpen] = useState(false);
  const pendingCount = usePendingApprovalsCount();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <div className="flex min-h-screen">
        <Sidebar
          nav={nav}
          onNav={setNav}
          pendingCount={pendingCount}
          onNewRun={() => setNewRunOpen(true)}
        />

        <div className="flex flex-1 flex-col">
          <TopBar nav={nav} topTab={topTab} onTopTab={setTopTab} />

          <main className="flex-1 px-8 py-6">
            {nav === "dashboard" && (
              <DashboardView onNewRun={() => setNewRunOpen(true)} />
            )}
            {nav === "campaigns" && <RunDetailView />}
            {nav === "product-profile" && <ProductProfileView />}
            {nav === "proposed-actions" && <ApprovalsView />}
            {nav === "seo-reports" && <AuditsView />}
            {nav === "agents" && <AgentsView />}
            {nav === "drafts" && <DraftsView />}
            {nav === "integrations" && <ConnectionsView />}
            {nav === "settings" && <SettingsView />}
          </main>
        </div>
      </div>

      {newRunOpen && (
        <NewRunModal
          onClose={() => setNewRunOpen(false)}
          onLaunched={() => {
            setNewRunOpen(false);
            // After launch, take the user to the Approvals inbox where the run's
            // outputs will appear in ~30s.
            setNav("proposed-actions");
          }}
        />
      )}

      {/* Reactive chat — available on every screen */}
      <ChatWidget />
    </div>
  );
}

/* Polls /api/approvals-count every 5s. Returns -1 while loading so the badge
   can show a tiny "..." rather than flicker to 0. */
function usePendingApprovalsCount(): number {
  const [count, setCount] = useState<number>(-1);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/approvals-count`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { pending: number };
        if (!cancelled) setCount(data.pending);
      } catch {
        // backend offline — keep last value, badge will still show stale count
      }
    }

    load();
    const t = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return count;
}

/* =====================================================================
   SIDEBAR
   ===================================================================== */

function Sidebar({
  nav,
  onNav,
  pendingCount,
  onNewRun,
}: {
  nav: NavId;
  onNav: (n: NavId) => void;
  pendingCount: number;
  onNewRun: () => void;
}) {
  // Nav grouped like the Stitch design — main items, then Growth Tools.
  const mainItems: { id: NavId; label: string; icon: ReactNode }[] = [
    { id: "dashboard", label: "Dashboard", icon: <IconGrid /> },
    { id: "campaigns", label: "Campaigns", icon: <IconRocket /> },
    { id: "agents", label: "Agents", icon: <IconBot /> },
    { id: "drafts", label: "Drafts", icon: <IconDoc /> },
    { id: "proposed-actions", label: "Proposed Actions", icon: <IconCheckList /> },
  ];

  const growthItems: { id: NavId; label: string; icon: ReactNode }[] = [
    { id: "seo-reports", label: "SEO Reports", icon: <IconChart /> },
    { id: "product-profile", label: "Product Profile", icon: <IconBox /> },
    { id: "integrations", label: "Integrations", icon: <IconPlug /> },
    { id: "settings", label: "Settings", icon: <IconGear /> },
  ];

  return (
    <aside className="flex w-64 flex-col border-r border-slate-200 bg-white">
      {/* Logo block */}
      <div className="flex items-center gap-3 border-b border-slate-100 px-5 py-5">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600 text-white">
          <IconRocket />
        </div>
        <div>
          <div className="text-base font-semibold leading-tight">MarketPilot</div>
          <div className="text-[10px] font-medium uppercase tracking-wider text-slate-400">
            Autonomous Workspace
          </div>
        </div>
      </div>

      {/* + New Run primary button */}
      <div className="px-4 pt-4">
        <button
          type="button"
          onClick={onNewRun}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
        >
          <span className="text-lg leading-none">+</span> New Run
        </button>
      </div>

      {/* Main nav */}
      <nav className="mt-5 flex flex-1 flex-col gap-1 px-3">
        {mainItems.map((item) => (
          <NavButton
            key={item.id}
            active={nav === item.id}
            onClick={() => onNav(item.id)}
            icon={item.icon}
            label={item.label}
            badge={
              item.id === "proposed-actions" && pendingCount > 0
                ? pendingCount
                : undefined
            }
          />
        ))}

        <div className="mt-5 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Growth Tools
        </div>
        {growthItems.map((item) => (
          <NavButton
            key={item.id}
            active={nav === item.id}
            onClick={() => onNav(item.id)}
            icon={item.icon}
            label={item.label}
          />
        ))}
      </nav>

      {/* User profile at the bottom */}
      <div className="border-t border-slate-100 px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-full bg-linear-to-br from-indigo-500 to-violet-500 text-sm font-semibold text-white">
            D
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold leading-tight">Devansh</div>
            <div className="text-xs text-slate-500">Premium Account</div>
          </div>
          <button
            type="button"
            className="text-slate-400 hover:text-slate-600"
            aria-label="Account settings"
          >
            <IconGear />
          </button>
        </div>
      </div>
    </aside>
  );
}

function NavButton({
  active,
  onClick,
  icon,
  label,
  badge,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition " +
        (active
          ? "bg-indigo-50 text-indigo-700"
          : "text-slate-600 hover:bg-slate-50 hover:text-slate-900")
      }
    >
      <span className={active ? "text-indigo-600" : "text-slate-400"}>
        {icon}
      </span>
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && (
        <span className="inline-flex min-w-5 items-center justify-center rounded-full bg-rose-500 px-1.5 py-0.5 text-[10px] font-bold text-white">
          {badge}
        </span>
      )}
    </button>
  );
}

/* =====================================================================
   TOP BAR
   ===================================================================== */

function TopBar({
  nav,
  topTab,
  onTopTab,
}: {
  nav: NavId;
  topTab: TopTab;
  onTopTab: (t: TopTab) => void;
}) {
  const tabs: { id: TopTab; label: string }[] = [
    { id: "workspace", label: "Workspace" },
    { id: "intel", label: "Intel" },
    { id: "setup", label: "Setup" },
  ];

  return (
    <header className="flex h-16 items-center justify-between border-b border-slate-200 bg-white px-8">
      <div className="flex items-center gap-10">
        <div className="text-xl font-bold tracking-tight text-indigo-700">
          MarketPilot AI
        </div>
        <nav className="flex items-center gap-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => onTopTab(t.id)}
              className={
                "rounded-lg px-3 py-1.5 text-sm font-medium transition " +
                (topTab === t.id
                  ? "border border-indigo-200 bg-indigo-50 text-indigo-700"
                  : "text-slate-500 hover:text-slate-900")
              }
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex items-center gap-4">
        {/* Auto-save indicator (only meaningful on Product Profile) */}
        {nav === "product-profile" && (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <span className="h-2 w-2 rounded-full bg-emerald-500" />
            All changes saved · 3s ago
          </div>
        )}
        <button
          type="button"
          className="relative rounded-lg p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
          aria-label="Notifications"
        >
          <IconBell />
          <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-rose-500" />
        </button>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-linear-to-br from-indigo-500 to-violet-500 text-sm font-semibold text-white">
          D
        </div>
      </div>
    </header>
  );
}

/* =====================================================================
   DASHBOARD VIEW
   ===================================================================== */

// Real backend types for the dashboard.
type DashboardStats = {
  activeCampaigns: number;
  agentsRunning: number;
  pendingApprovals: number;
  draftsThisWeek: number;
  auditsTotal: number;
  runsThisWeek: number;
};

type SkillRunStep = {
  stepId: string;
  type: "tool_call" | "tool_result";
  toolName?: string;
  content: string;
  timestamp: string;
};

type SkillRunDraft = {
  title: string;
  content: string;
  type: string;
  createdAt: string;
};

type AgentDecision = {
  kind:
    | "approval_waiting"
    | "pr_created"
    | "pr_skipped"
    | "pr_rejected"
    | "pr_failed"
    | "quality_blocked"
    | "setup_needed";
  label: string;
  summary: string;
  reason: string;
  nextStep: string;
  severity: "success" | "warning" | "danger" | "neutral";
  link?: string;
  createdAt: string;
};

type FinalReport = {
  executiveSummary: string;
  findings: string[];
  recommendations: string[];
  nextSteps: string[];
  drafts: SkillRunDraft[];
  proposedActions: Array<{
    actionId: string;
    type: string;
    title: string;
    description: string;
    status: "pending" | "approved" | "rejected" | "executed";
    resolvedAt?: string;
    result?: string;
  }>;
  decision?: AgentDecision;
  structuredOutputs?: StructuredOutput[];
};

type SkillRun = {
  taskId: string;
  status: "running" | "completed" | "failed";
  skillId: string;
  inputContext: Record<string, string | undefined>;
  steps: SkillRunStep[];
  drafts: SkillRunDraft[];
  finalReport?: FinalReport;
  createdAt: string;
  updatedAt: string;
};

function displayRunSubject(inputContext: SkillRun["inputContext"]): string {
  return (
    inputContext.productName ||
    inputContext.siteUrl ||
    inputContext.productUrl ||
    inputContext.pageUrl ||
    inputContext.websiteUrl ||
    inputContext.audience ||
    inputContext.targetAudience ||
    "(brief saved)"
  );
}

type CompetitorIntel = {
  run: SkillRun;
  profile: CompetitorProfileOutput;
};

function competitorProfileFromRun(
  run: SkillRun,
): CompetitorProfileOutput | undefined {
  const output = run.finalReport?.structuredOutputs?.find(
    (item): item is Extract<StructuredOutput, { type: "competitorProfile" }> =>
      item.type === "competitorProfile",
  );
  return output?.data;
}

function latestCompetitorIntel(runs: SkillRun[]): CompetitorIntel | null {
  const completedRuns = [...runs].sort((a, b) =>
    a.updatedAt < b.updatedAt ? 1 : -1,
  );

  for (const run of completedRuns) {
    const profile = competitorProfileFromRun(run);
    if (profile) return { run, profile };
  }

  return null;
}

type DashEvent = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

function DashboardView({ onNewRun }: { onNewRun: () => void }) {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [runs, setRuns] = useState<SkillRun[]>([]);
  const [events, setEvents] = useState<DashEvent[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const [s, r, e, a] = await Promise.all([
          fetch(`${BACKEND_URL}/api/dashboard-stats`).then((x) => x.json()),
          fetch(`${BACKEND_URL}/api/skill-runs`).then((x) => x.json()),
          fetch(`${BACKEND_URL}/api/events?limit=12`).then((x) => x.json()),
          fetch(`${BACKEND_URL}/api/approvals?status=pending`).then((x) => x.json()),
        ]);
        if (cancelled) return;
        setStats(s);
        setRuns(r.skillRuns ?? []);
        setEvents(e.events ?? []);
        setApprovals(a.approvals ?? []);
        setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      }
    }

    void load();
    const t = setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const runningRuns = runs.filter((r) => r.status === "running").slice(0, 3);
  const recentDraftsReal = runs
    .flatMap((r) =>
      r.drafts.map((d) => ({
        ...d,
        productName: displayRunSubject(r.inputContext),
      })),
    )
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 4);
  const competitorIntel = latestCompetitorIntel(runs);

  return (
    <div className="space-y-6">
      {/* Greeting + CTA */}
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Good evening, Devansh
          </h1>
          <p className="text-sm text-slate-500">
            {stats
              ? `${stats.agentsRunning} agent${stats.agentsRunning === 1 ? "" : "s"} running · ${stats.pendingApprovals} pending approval${stats.pendingApprovals === 1 ? "" : "s"}.`
              : "Loading workspace…"}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {offline && (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
              Offline · using stale data
            </span>
          )}
          <button
            type="button"
            onClick={onNewRun}
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
          >
            + Launch a campaign
          </button>
        </div>
      </div>

      {/* Live runs strip + featured campaign card */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-3 lg:col-span-2">
          {runningRuns.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
              No agents running right now. Click{" "}
              <button
                onClick={onNewRun}
                className="font-semibold text-indigo-600 underline-offset-2 hover:underline"
              >
                + Launch a campaign
              </button>{" "}
              to start one.
            </div>
          ) : (
            runningRuns.map((r) => <LiveRunCardReal key={r.taskId} run={r} />)
          )}
        </div>

        <FeaturedCampaignCard onLaunch={onNewRun} />
      </div>

      {/* Stat cards — real numbers */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCardReal
          label="ACTIVE CAMPAIGNS"
          value={stats?.activeCampaigns ?? 0}
          trend={`${stats?.runsThisWeek ?? 0} runs this week`}
        />
        <StatCardReal
          label="AGENTS RUNNING"
          value={stats?.agentsRunning ?? 0}
          trend={stats && stats.agentsRunning > 0 ? "live" : "idle"}
        />
        <StatCardReal
          label="PENDING APPROVALS"
          value={stats?.pendingApprovals ?? 0}
          trend={stats && stats.pendingApprovals > 0 ? "Action needed" : "All clear"}
        />
        <StatCardReal
          label="DRAFTS THIS WEEK"
          value={stats?.draftsThisWeek ?? 0}
          trend={`${stats?.auditsTotal ?? 0} audits on file`}
        />
      </div>

      <CompetitiveIntelDashboardCard
        intel={competitorIntel}
        onNewRun={onNewRun}
      />

      {/* Proposed Actions + Activity */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="space-y-4 lg:col-span-2">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-lg font-semibold">
              <span className="text-indigo-600">⚡</span> Proposed Actions
            </h2>
            <span className="text-xs text-slate-500">
              {approvals.length} pending
            </span>
          </div>
          {approvals.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
              Nothing waiting. Approvals will appear here after an agent run finishes.
            </div>
          ) : (
            approvals
              .slice(0, 3)
              .map((a) => <DashApprovalCard key={a.id} approval={a} />)
          )}
        </section>

        <section>
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 flex items-center gap-2 text-base font-semibold">
              <IconClock /> Activity
            </h2>
            {events.length === 0 ? (
              <div className="text-sm text-slate-500">No activity yet.</div>
            ) : (
              <ul className="space-y-3">
                {events.slice(0, 8).map((e) => (
                  <li key={e.id} className="flex items-start gap-3">
                    <div
                      className={
                        "mt-1 h-2 w-2 shrink-0 rounded-full " +
                        eventDotColor(e.type)
                      }
                    />
                    <div className="text-sm">
                      <div className="text-slate-700">{eventLabel(e)}</div>
                      <div className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                        {formatRelative(e.createdAt)}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      {/* Recent Drafts — real */}
      <section>
        <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold">
          <IconDoc /> Recent Drafts
        </h2>
        {recentDraftsReal.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
            No drafts saved yet. The Copywriter skill will fill this in.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {recentDraftsReal.map((d, i) => (
              <DashDraftCard key={i} draft={d} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/* ---------- New small components for the wired dashboard ---------- */

function CompetitiveIntelDashboardCard({
  intel,
  onNewRun,
}: {
  intel: CompetitorIntel | null;
  onNewRun: () => void;
}) {
  if (!intel) {
    return (
      <section className="rounded-2xl border border-dashed border-slate-300 bg-white p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600">
              Competitive intelligence
            </div>
            <h2 className="mt-1 text-lg font-semibold text-slate-900">
              No competitor profile yet
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-500">
              Run Competitor Profiling once and the latest gaps, advantages,
              and quick wins will show here.
            </p>
          </div>
          <button
            type="button"
            onClick={onNewRun}
            className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700"
          >
            New competitor run
          </button>
        </div>
      </section>
    );
  }

  const competitors = intel.profile.competitors;
  if (competitors.length === 0) return null;

  return (
    <CompetitiveIntelDashboardCardContent
      competitors={competitors}
      updatedAt={intel.run.updatedAt}
    />
  );
}

// Split out so we can use hooks for the competitor tab switcher without
// changing the outer empty-state code path.
function CompetitiveIntelDashboardCardContent({
  competitors,
  updatedAt,
}: {
  competitors: CompetitorProfileOutput["competitors"];
  updatedAt: string;
}) {
  const [activeIdx, setActiveIdx] = useState(0);
  const safeIdx = Math.min(activeIdx, competitors.length - 1);
  const competitor = competitors[safeIdx];
  if (!competitor) return null;

  const gaps = competitor.yourGaps ?? competitor.weaknesses;
  const advantages = competitor.yourAdvantages ?? [];
  const quickWins = competitor.quickWins ?? [];

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600">
            Competitive intelligence
          </div>
          <h2 className="mt-1 text-lg font-semibold text-slate-900">
            Latest profile: {competitor.name}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-600">
            {competitor.positioning}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
            {formatRelative(updatedAt)}
          </span>
          <a
            href={competitor.url}
            target="_blank"
            rel="noreferrer"
            className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
          >
            Visit
          </a>
        </div>
      </div>

      {/* Competitor tab strip — only shows when there are 2+ competitors.
          Without it the dashboard tile only ever revealed competitors[0]
          even when the run analyzed several. */}
      {competitors.length > 1 ? (
        <div className="mt-4 flex flex-wrap gap-1.5 border-b border-slate-200 pb-3">
          {competitors.map((c, idx) => {
            const active = idx === safeIdx;
            return (
              <button
                key={`${c.url}-${idx}`}
                type="button"
                onClick={() => setActiveIdx(idx)}
                className={
                  active
                    ? "rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm"
                    : "rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200"
                }
              >
                {c.name}
              </button>
            );
          })}
        </div>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <DashboardIntelList
          label="Where you may be ahead"
          tone="good"
          items={advantages}
          fallback="No advantage captured yet."
        />
        <DashboardIntelList
          label="Where you are lacking"
          tone="risk"
          items={gaps}
          fallback="No gap captured yet."
        />
        <DashboardIntelList
          label="Best quick wins"
          tone="action"
          items={quickWins}
          fallback="No quick win captured yet."
        />
      </div>

      <details className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4">
        <summary className="cursor-pointer text-sm font-semibold text-slate-900">
          Competitor&apos;s own strengths &amp; weaknesses
        </summary>
        <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
          <DashboardIntelList
            label={`${competitor.name} strengths`}
            tone="neutral"
            items={competitor.strengths}
            fallback="No strengths captured."
          />
          <DashboardIntelList
            label={`${competitor.name} weaknesses`}
            tone="neutral"
            items={competitor.weaknesses}
            fallback="No weaknesses captured."
          />
        </div>
      </details>
    </section>
  );
}

function DashboardIntelList({
  label,
  tone,
  items,
  fallback,
}: {
  label: string;
  tone: "good" | "risk" | "action" | "neutral";
  items: string[];
  fallback: string;
}) {
  const palette =
    tone === "good"
      ? {
          card: "border-emerald-200 bg-emerald-50/40",
          label: "text-emerald-700",
          dot: "bg-emerald-500",
          badge: "bg-emerald-100 text-emerald-700",
        }
      : tone === "risk"
        ? {
            card: "border-rose-200 bg-rose-50/40",
            label: "text-rose-700",
            dot: "bg-rose-500",
            badge: "bg-rose-100 text-rose-700",
          }
        : tone === "action"
          ? {
              card: "border-indigo-200 bg-indigo-50/40",
              label: "text-indigo-700",
              dot: "bg-indigo-500",
              badge: "bg-indigo-100 text-indigo-700",
            }
          : {
              card: "border-slate-200 bg-white",
              label: "text-slate-600",
              dot: "bg-slate-400",
              badge: "bg-slate-100 text-slate-600",
            };
  const empty = items.length === 0;

  return (
    <div className={`flex flex-col rounded-xl border p-4 ${palette.card}`}>
      <div className="flex items-center justify-between gap-2">
        <div
          className={`text-[10px] font-semibold uppercase tracking-wider ${palette.label}`}
        >
          {label}
        </div>
        {!empty ? (
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${palette.badge}`}
          >
            {items.length}
          </span>
        ) : null}
      </div>
      {empty ? (
        <p className="mt-3 text-sm leading-6 text-slate-500">{fallback}</p>
      ) : (
        <ul className="mt-3 space-y-2.5">
          {items.map((item, index) => (
            <li
              key={index}
              className="flex gap-2.5 text-sm leading-6 text-slate-700"
            >
              <span
                className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${palette.dot}`}
                aria-hidden
              />
              <span className="min-w-0 wrap-break-word">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LiveRunCardReal({ run }: { run: SkillRun }) {
  const lastStep = run.steps[run.steps.length - 1];
  const status =
    lastStep?.type === "tool_call"
      ? `Calling ${lastStep.toolName}`
      : lastStep?.type === "tool_result"
        ? `Got ${lastStep.toolName} result`
        : "Starting…";
  // crude pseudo-progress based on step count vs cap of 12
  const progress = Math.min(
    95,
    Math.round((run.steps.length / 12) * 100),
  );

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2 text-slate-700">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
          <span className="font-semibold">{run.skillId}</span>
          <span className="text-slate-400">·</span>
          <span className="text-slate-500">
            {displayRunSubject(run.inputContext)}
          </span>
        </div>
        <span className="text-xs font-medium text-slate-500">~{progress}%</span>
      </div>
      <div className="mt-1 text-xs text-slate-500">{status}…</div>
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className="h-full rounded-full bg-linear-to-r from-indigo-500 to-violet-500"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
}

function StatCardReal({
  label,
  value,
  trend,
}: {
  label: string;
  value: number;
  trend: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label}
      </div>
      <div className="mt-2 flex items-baseline gap-2">
        <span className="text-3xl font-semibold tracking-tight">{value}</span>
        <span className="text-xs font-medium text-emerald-600">{trend}</span>
      </div>
      <svg
        viewBox="0 0 100 30"
        className="mt-3 h-8 w-full text-indigo-500"
        preserveAspectRatio="none"
      >
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          points="0,22 15,18 30,21 45,12 60,16 75,8 100,11"
        />
      </svg>
    </div>
  );
}

function DashApprovalCard({ approval }: { approval: Approval }) {
  const type = approval.proposedActionJson?.type ?? "action";
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <div className="flex-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
              {approval.status}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-700">
              {type.replace(/_/g, " ")}
            </span>
            <span className="text-slate-500">
              {formatRelative(approval.createdAt)}
            </span>
          </div>
          <h3 className="mt-2 text-base font-semibold">{approval.title}</h3>
          <p className="mt-1.5 line-clamp-2 text-sm text-slate-600">
            {approval.summary}
          </p>
        </div>
      </div>
      <div className="mt-3 text-xs text-slate-500">
        Decide in the{" "}
        <span className="font-semibold text-indigo-600">Proposed Actions</span>{" "}
        inbox.
      </div>
    </div>
  );
}

function DashDraftCard({
  draft,
}: {
  draft: SkillRunDraft & { productName: string };
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between">
        <span className="inline-block rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
          {draft.type.replace(/_/g, " ")}
        </span>
        <span className="text-xs text-slate-400">
          {formatRelative(draft.createdAt)}
        </span>
      </div>
      <h3 className="mt-3 text-base font-semibold">{draft.title}</h3>
      <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-slate-600">
        {draft.content.slice(0, 240)}
      </p>
      <div className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-500">
        for {draft.productName}
      </div>
    </div>
  );
}

/* ---------- Event log helpers ---------- */

function eventDotColor(type: string): string {
  if (type.includes("rolled_back")) return "bg-rose-500";
  if (type.includes("notify")) return "bg-amber-500";
  if (type.includes("blocked")) return "bg-rose-500";
  if (type.includes("necessity")) return "bg-indigo-500";
  if (type.includes("scheduler")) return "bg-violet-500";
  if (type.includes("memory")) return "bg-slate-400";
  return "bg-emerald-500";
}

function eventLabel(e: DashEvent): ReactNode {
  const p = e.payload;
  const tool = (p?.toolName as string) ?? "";
  const tier = (p?.tier as string) ?? "";
  const jobId = (p?.jobId as string) ?? "";
  const necessityGate = readRecord(p?.necessityGate);
  const necessityStatus =
    typeof necessityGate?.status === "string"
      ? necessityGate.status.replace(/_/g, " ")
      : "checked";

  switch (e.type) {
    case "seo_change_necessity_checked":
      return (
        <>
          PR necessity:{" "}
          <span className="font-semibold">{necessityStatus}</span>
        </>
      );
    case "tool_gated":
      return (
        <>
          Gate decision:{" "}
          <span className="font-semibold">{tool}</span>{" "}
          <span className="text-slate-400">({tier})</span>
        </>
      );
    case "tool_executed_notify":
      return (
        <>
          🟡 Yellow write executed:{" "}
          <span className="font-semibold">{tool}</span>
        </>
      );
    case "tool_rolled_back":
      return (
        <>
          ↺ Rolled back: <span className="font-semibold">{tool}</span>
        </>
      );
    case "memory_loaded":
      return (
        <>
          Memory loaded · {String(p?.audits ?? 0)} audits ·{" "}
          {String(p?.performanceDays ?? 0)} perf days
        </>
      );
    case "scheduler_manual_run":
      return (
        <>
          Scheduler manual fire: <span className="font-semibold">{jobId}</span>
        </>
      );
    case "scheduler_job_fired":
      return (
        <>
          Job started: <span className="font-semibold">{jobId}</span>
        </>
      );
    case "scheduler_cron_tick":
      return (
        <>
          Cron tick: <span className="font-semibold">{jobId}</span>
        </>
      );
    default:
      return <span className="text-slate-700">{e.type}</span>;
  }
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function FeaturedCampaignCard({ onLaunch }: { onLaunch: () => void }) {
  return (
    <div className="flex flex-col rounded-2xl bg-linear-to-br from-indigo-600 to-violet-600 p-5 text-white shadow-md">
      <div className="text-sm font-semibold opacity-90">{featuredCampaign.name}</div>
      <div className="mt-3 text-[10px] font-semibold uppercase tracking-wider opacity-80">
        Agent Skills
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {featuredCampaign.skills.map((s) => (
          <span
            key={s}
            className="rounded-full bg-white/15 px-2.5 py-0.5 text-xs font-semibold backdrop-blur"
          >
            {s}
          </span>
        ))}
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/15 text-xs font-semibold">
          +
        </span>
      </div>
      <p className="mt-4 text-xs italic leading-relaxed opacity-90">
        “{featuredCampaign.note}”
      </p>
      <button
        type="button"
        onClick={onLaunch}
        className="mt-auto rounded-xl bg-white py-2 text-sm font-semibold text-indigo-700 shadow-sm transition hover:bg-indigo-50"
      >
        Launch Agents
      </button>
    </div>
  );
}

/* =====================================================================
   RUN DETAIL VIEW (Campaigns tab)
   ===================================================================== */

function RunDetailView() {
  return (
    <div className="space-y-6">
      {/* Run header */}
      <div className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
            <IconSearch />
          </div>
          <div>
            <h1 className="text-lg font-semibold">SEO Audit</h1>
            <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Acme Winter Launch
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-sm">
            <div className="flex items-center gap-2 text-emerald-600">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              <span className="font-semibold">Running (65%)</span>
            </div>
            <div className="text-xs text-slate-500">Elapsed: 12m 45s</div>
          </div>
          <div className="flex gap-2">
            <button className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">
              Stop Run
            </button>
            <button className="rounded-lg bg-indigo-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700">
              Re-run Trace
            </button>
          </div>
        </div>
      </div>

      {/* Trace + side stats/cards */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        {/* Console trace */}
        <div className="lg:col-span-3">
          <div className="rounded-2xl border border-slate-200 bg-white p-5 font-mono text-xs leading-relaxed shadow-sm">
            <div className="space-y-2">
              {traceLines.map((l, i) => (
                <TraceLine key={i} line={l} />
              ))}
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-lg bg-indigo-50 px-3 py-2 text-indigo-700">
              <span className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />
              <span className="font-sans text-sm">
                Reading competitor pricing strategy…
              </span>
            </div>
          </div>
        </div>

        {/* Stats column */}
        <div className="space-y-4 lg:col-span-2">
          <div className="grid grid-cols-3 gap-3">
            {runStats.map((s) => (
              <div
                key={s.label}
                className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              >
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {s.label}
                </div>
                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-2xl font-semibold">{s.value}</span>
                  <span className="text-xs font-medium text-emerald-600">
                    {s.delta}
                  </span>
                </div>
              </div>
            ))}
          </div>

          {/* Competitor keyword analysis */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-base font-semibold">Competitor Keyword Analysis</h3>
              <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
                AI Generated
              </span>
            </div>
            <ul className="space-y-3">
              {keywordOpps.map((k) => (
                <li
                  key={k.id}
                  className="flex items-start justify-between gap-3 border-t border-slate-100 pt-3 first:border-0 first:pt-0"
                >
                  <div className="flex gap-3">
                    <span className="text-xs font-bold text-slate-400">{k.id}</span>
                    <div>
                      <div className="text-sm font-semibold text-slate-800">
                        {k.title}
                      </div>
                      <div className="text-xs text-slate-500">{k.note}</div>
                    </div>
                  </div>
                  <button className="shrink-0 text-xs font-semibold text-indigo-600 hover:text-indigo-700">
                    Create Content
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Technical fixes */}
      <section>
        <h2 className="mb-3 text-lg font-semibold">Technical Fixes</h2>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {techFixes.map((f) => (
            <div
              key={f.id}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
                  {f.sev === "CRITICAL" ? <IconLinkOff /> : <IconImage />}
                </div>
                <span
                  className={
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wider " +
                    (f.sev === "CRITICAL"
                      ? "bg-rose-50 text-rose-700"
                      : "bg-amber-50 text-amber-700")
                  }
                >
                  {f.sev}
                </span>
              </div>
              <h3 className="mt-3 text-base font-semibold">{f.title}</h3>
              <p className="mt-1 text-sm text-slate-600">{f.body}</p>
              <button className="mt-3 text-sm font-semibold text-indigo-600 hover:text-indigo-700">
                {f.cta}
              </button>
            </div>
          ))}
        </div>
      </section>

      {/* Projected Traffic Recovery chart */}
      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-900 p-6 text-white shadow-md">
        <div className="flex items-end justify-between">
          <div>
            <h3 className="text-lg font-semibold">Projected Traffic Recovery</h3>
            <p className="text-sm text-slate-400">
              Estimated 15% increase in organic reach after implementing recommended fixes.
            </p>
          </div>
          <span className="rounded-full bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-300">
            +15%
          </span>
        </div>
        <ChartMock />
      </section>
    </div>
  );
}

function TraceLine({
  line,
}: {
  line: { t: string; kind: string; text: string };
}) {
  const kindColor: Record<string, string> = {
    system: "text-slate-500",
    call: "text-indigo-600",
    result: "text-emerald-600",
    thought: "text-violet-600",
    error: "text-rose-600",
    live: "text-indigo-500",
  };
  return (
    <div className="flex gap-3">
      <span className="shrink-0 text-slate-400">{line.t}</span>
      <span className={kindColor[line.kind] ?? "text-slate-700"}>{line.text}</span>
    </div>
  );
}

function ChartMock() {
  // Bars rendered as styled divs so we don't need a chart library.
  const bars = [22, 30, 26, 38, 34, 48, 42, 56, 50, 64, 60, 78];
  return (
    <div className="mt-5 flex h-40 items-end gap-2">
      {bars.map((h, i) => (
        <div key={i} className="flex flex-1 flex-col justify-end">
          <div
            className="rounded-t-md bg-linear-to-t from-emerald-500/40 to-emerald-300"
            style={{ height: `${h}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/* =====================================================================
   PRODUCT PROFILE VIEW
   ===================================================================== */

// Real backend profile shape (mirrors backend/src/lib/store/types.ts).
type Profile = {
  id: string;
  workspaceId: string;
  productName: string;
  tagline: string;
  industry: string;
  stage: "Pre-launch" | "MVP" | "Growth" | "Scale";
  siteUrl: string;
  positioning: string;
  features: string[];
  differentiators: string[];
  icp: string;
  voiceTone: string[];
  mrr: number;
  monthlyTraffic: number;
  northStar: string;
  brandGuidelines: string;
  updatedAt: string;
};

function ProductProfileView() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  // Local edit state — only fields the form edits. Booted from `profile`.
  const [draft, setDraft] = useState<Profile | null>(null);

  // Computed: how complete is the profile? Used by the strength widget.
  function strength(p: Profile): { pct: number; missing: string[] } {
    const checks: { label: string; ok: boolean }[] = [
      { label: "Product name", ok: !!p.productName.trim() },
      { label: "Tagline", ok: !!p.tagline.trim() },
      { label: "Industry", ok: !!p.industry.trim() },
      { label: "Site URL", ok: /^https?:\/\//.test(p.siteUrl) },
      { label: "Long positioning", ok: p.positioning.length >= 40 },
      { label: "At least 3 core features", ok: p.features.length >= 3 },
      { label: "At least 2 differentiators", ok: p.differentiators.length >= 2 },
      { label: "ICP described", ok: p.icp.length >= 20 },
      { label: "Voice & tone (≥2)", ok: p.voiceTone.length >= 2 },
      { label: "MRR set", ok: p.mrr >= 0 && p.mrr !== undefined },
      { label: "Monthly traffic set", ok: p.monthlyTraffic >= 0 },
      { label: "3-month north star", ok: p.northStar.length >= 10 },
    ];
    const ok = checks.filter((c) => c.ok).length;
    return {
      pct: Math.round((ok / checks.length) * 100),
      missing: checks.filter((c) => !c.ok).map((c) => c.label),
    };
  }

  // Load on mount.
  useEffect(() => {
    fetch(`${BACKEND_URL}/api/profile`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((p: Profile) => {
        setProfile(p);
        setDraft(p);
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Failed to load profile"),
      );
  }, []);

  async function save() {
    if (!draft) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/profile`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const next = (await res.json()) as Profile;
      setProfile(next);
      setDraft(next);
      setSavedAt(new Date().toISOString());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  // Loading / error gates.
  if (error && !profile) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">
        Couldn&apos;t load profile: {error}. Is the backend running on {BACKEND_URL}?
      </div>
    );
  }
  if (!profile || !draft) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        Loading profile…
      </div>
    );
  }

  const dirty = JSON.stringify(profile) !== JSON.stringify(draft);
  const s = strength(draft);

  // Static (not yet editable) values from the existing design.
  const dos = ["Use data-backed claims", "Be authoritative"];
  const donts = ["No emojis", "No fluff"];
  const brandColors = ["#4f46e5", "#7c3aed", "#b45309", "#e5e7eb"];

  // Patch helper — `setDraft({ ...draft, x: y })` is tedious.
  function set<K extends keyof Profile>(key: K, value: Profile[K]) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Product Profile</h1>
          <p className="text-sm text-slate-500">
            Define your product identity to help agents tailor their growth strategies.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {error && (
            <span className="text-xs text-rose-600">Save failed: {error}</span>
          )}
          {!dirty && savedAt && !error && (
            <span className="text-xs text-emerald-600">
              ✓ Saved {formatRelative(savedAt)}
            </span>
          )}
          {dirty && (
            <span className="text-xs text-amber-600">Unsaved changes</span>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      {/* Top row: 3 cards (Identity / Narrative / Ecosystem) */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Identity */}
        <Card>
          <CardHeader title="Identity" icon={<IconId />} action={<IconCamera />} />
          <FormLabel>Product Name</FormLabel>
          <Input
            value={draft.productName}
            onChange={(v) => set("productName", v)}
          />
          <FormLabel className="mt-3">Elevator Pitch</FormLabel>
          <Textarea
            rows={3}
            value={draft.tagline}
            onChange={(v) => set("tagline", v)}
          />
          <div className="mt-3 grid grid-cols-2 gap-3">
            <div>
              <FormLabel>Industry</FormLabel>
              <Input
                value={draft.industry}
                onChange={(v) => set("industry", v)}
              />
            </div>
            <div>
              <FormLabel>Stage</FormLabel>
              <Select
                value={draft.stage}
                onChange={(v) => set("stage", v as Profile["stage"])}
                options={["Pre-launch", "MVP", "Growth", "Scale"]}
              />
            </div>
          </div>
          <FormLabel className="mt-3">Site URL</FormLabel>
          <Input
            value={draft.siteUrl}
            onChange={(v) => set("siteUrl", v)}
          />
        </Card>

        {/* Product Narrative */}
        <Card>
          <CardHeader title="Product Narrative" icon={<IconBook />} />
          <FormLabel>Describe your product</FormLabel>
          <div className="relative">
            <Textarea
              rows={5}
              value={draft.positioning}
              onChange={(v) => set("positioning", v)}
            />
            <div className="absolute bottom-2 right-3 text-[10px] text-slate-400">
              {draft.positioning.length} / 2000
            </div>
          </div>

          <FormLabel className="mt-4">Core Features</FormLabel>
          <ChipList
            chips={draft.features}
            onChange={(c) => set("features", c)}
            accent="indigo"
          />

          <FormLabel className="mt-4">Differentiators</FormLabel>
          <ChipList
            chips={draft.differentiators}
            onChange={(c) => set("differentiators", c)}
            accent="amber"
          />

          <FormLabel className="mt-4">Ideal Customer (ICP)</FormLabel>
          <Textarea
            rows={2}
            value={draft.icp}
            onChange={(v) => set("icp", v)}
          />
        </Card>

        {/* Ecosystem */}
        <Card>
          <CardHeader
            title="Ecosystem"
            icon={<IconLink />}
            badge={<Badge tone="emerald">4 Active</Badge>}
          />
          <IntegrationRow
            icon={<IconGlobe />}
            name="Website"
            sub="acme.so"
            status="connected"
          />
          <IntegrationRow
            icon={<IconBars />}
            name="GA4"
            sub="Syncing 12s ago"
            status="syncing"
          />
          <IntegrationRow
            icon={<IconMeta />}
            name="Meta Ads"
            sub="OAuth Pending"
            status="pending"
          />
          <IntegrationRow
            icon={<IconWP />}
            name="WordPress CMS"
            sub="wp_ak_•••••••3982"
            status="connected"
          />
        </Card>
      </div>

      {/* Bottom row: Brand DNA / KPIs / Profile Strength */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Brand DNA */}
        <Card>
          <CardHeader title="Brand DNA" icon={<IconSparkle />} />
          <FormLabel>Voice & Tone</FormLabel>
          <ChipList
            chips={draft.voiceTone}
            onChange={(c) => set("voiceTone", c)}
            accent="indigo"
          />

          <div className="mt-4 grid grid-cols-2 gap-4 text-sm">
            <div>
              <FormLabel>Do&apos;s</FormLabel>
              <ul className="mt-1 space-y-1.5">
                {dos.map((d) => (
                  <li key={d} className="flex items-start gap-2 text-slate-700">
                    <span className="mt-0.5 text-emerald-500">✓</span> {d}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <FormLabel>Don&apos;ts</FormLabel>
              <ul className="mt-1 space-y-1.5">
                {donts.map((d) => (
                  <li key={d} className="flex items-start gap-2 text-slate-700">
                    <span className="mt-0.5 text-rose-500">✕</span> {d}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <FormLabel className="mt-4">Brand Colors</FormLabel>
          <div className="flex gap-2">
            {brandColors.map((c) => (
              <span
                key={c}
                className="h-7 w-7 rounded-full border border-white shadow"
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </Card>

        {/* KPIs & Aspirations */}
        <Card>
          <CardHeader title="KPIs & Aspirations" icon={<IconTarget />} />
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FormLabel>Current MRR</FormLabel>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">
                  $
                </span>
                <input
                  type="number"
                  className="w-full rounded-lg border border-slate-200 bg-white py-2 pl-7 pr-3 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                  value={draft.mrr}
                  onChange={(e) => set("mrr", Number(e.target.value) || 0)}
                />
              </div>
            </div>
            <div>
              <FormLabel>Monthly Traffic</FormLabel>
              <input
                type="number"
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                value={draft.monthlyTraffic}
                onChange={(e) => set("monthlyTraffic", Number(e.target.value) || 0)}
              />
            </div>
          </div>
          <FormLabel className="mt-3">3-Month North Star</FormLabel>
          <Textarea
            rows={3}
            value={draft.northStar}
            onChange={(v) => set("northStar", v)}
          />
        </Card>

        {/* Profile Strength — now computed from the real draft */}
        <div className="rounded-2xl bg-linear-to-br from-indigo-600 to-violet-700 p-6 text-white shadow-md">
          <div className="flex items-center gap-4">
            <ProgressRing value={s.pct} />
            <div>
              <div className="text-lg font-semibold">Profile Strength</div>
              <div className="text-sm opacity-80">Agents work best at 90%+</div>
            </div>
          </div>
          <div className="mt-5 text-[10px] font-semibold uppercase tracking-wider opacity-80">
            Missing Items
          </div>
          {s.missing.length === 0 ? (
            <div className="mt-2 text-sm opacity-90">
              Everything looks complete 🎉
            </div>
          ) : (
            <ul className="mt-2 space-y-2 text-sm">
              {s.missing.slice(0, 5).map((m) => (
                <MissingItem key={m} label={m} />
              ))}
            </ul>
          )}
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="mt-5 w-full rounded-xl bg-white py-2 text-sm font-semibold text-indigo-700 shadow-sm transition hover:bg-indigo-50 disabled:opacity-60"
          >
            {dirty ? (saving ? "Saving…" : "Save Profile") : "Up to date"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----- Product Profile small parts ----- */

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      {children}
    </div>
  );
}

function CardHeader({
  title,
  icon,
  action,
  badge,
}: {
  title: string;
  icon: ReactNode;
  action?: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-center justify-between">
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <span className="text-indigo-600">{icon}</span>
        {title}
      </h3>
      <div className="flex items-center gap-2 text-slate-400">
        {badge}
        {action}
      </div>
    </div>
  );
}

function FormLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={
        "text-[10px] font-semibold uppercase tracking-wider text-slate-500 " +
        (className ?? "")
      }
    >
      {children}
    </div>
  );
}

function Input({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Textarea({
  value,
  onChange,
  rows = 3,
}: {
  value: string;
  onChange: (v: string) => void;
  rows?: number;
}) {
  return (
    <textarea
      className="mt-1 w-full resize-none rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      rows={rows}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <select
      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {options.map((o) => (
        <option key={o}>{o}</option>
      ))}
    </select>
  );
}

function ChipList({
  chips,
  onChange,
  accent,
}: {
  chips: string[];
  onChange: (next: string[]) => void;
  accent: "indigo" | "amber";
}) {
  const [draft, setDraft] = useState("");
  const tone =
    accent === "indigo"
      ? "bg-indigo-50 text-indigo-700"
      : "bg-amber-50 text-amber-700";

  function add() {
    const v = draft.trim();
    if (!v) return;
    onChange([...chips, v]);
    setDraft("");
  }

  return (
    <div className="mt-1 flex flex-wrap items-center gap-2">
      {chips.map((c) => (
        <span
          key={c}
          className={"rounded-full px-2.5 py-1 text-xs font-medium " + tone}
        >
          {c}
        </span>
      ))}
      <input
        className="rounded-full border border-dashed border-slate-300 bg-white px-2.5 py-1 text-xs text-slate-500 focus:border-indigo-400 focus:outline-none"
        placeholder="+ Add"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add();
          }
        }}
      />
    </div>
  );
}

function Badge({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "emerald" | "amber" | "rose";
}) {
  const map = {
    emerald: "bg-emerald-50 text-emerald-700",
    amber: "bg-amber-50 text-amber-700",
    rose: "bg-rose-50 text-rose-700",
  };
  return (
    <span
      className={
        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
        map[tone]
      }
    >
      {children}
    </span>
  );
}

function IntegrationRow({
  icon,
  name,
  sub,
  status,
}: {
  icon: ReactNode;
  name: string;
  sub: string;
  status: "connected" | "syncing" | "pending";
}) {
  const dot =
    status === "connected"
      ? "bg-emerald-500"
      : status === "syncing"
        ? "bg-indigo-500 animate-pulse"
        : "bg-amber-500";

  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-slate-100 px-3 py-2.5 last:mb-0">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-slate-50 text-slate-600">
        {icon}
      </span>
      <div className="flex-1">
        <div className="text-sm font-semibold">{name}</div>
        <div className="text-xs text-slate-500">{sub}</div>
      </div>
      {status === "pending" ? (
        <button className="text-xs font-semibold text-indigo-600 hover:text-indigo-700">
          Connect
        </button>
      ) : (
        <span className={"h-2.5 w-2.5 rounded-full " + dot} />
      )}
    </div>
  );
}

function ProgressRing({ value }: { value: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const dash = (value / 100) * c;
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" className="-rotate-90">
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke="rgba(255,255,255,0.25)"
        strokeWidth="6"
      />
      <circle
        cx="32"
        cy="32"
        r={r}
        fill="none"
        stroke="white"
        strokeWidth="6"
        strokeDasharray={`${dash} ${c}`}
        strokeLinecap="round"
      />
      <text
        x="32"
        y="36"
        textAnchor="middle"
        className="rotate-90"
        transform="rotate(90 32 32)"
        fill="white"
        fontSize="14"
        fontWeight="700"
      >
        {value}%
      </text>
    </svg>
  );
}

function MissingItem({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-2 opacity-95">
      <span className="flex h-4 w-4 items-center justify-center rounded-full border border-white/60 text-[10px]">
        ○
      </span>
      {label}
    </li>
  );
}

/* =====================================================================
   APPROVALS INBOX VIEW  (Step 4)
   ===================================================================== */

function ApprovalsView() {
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [filter, setFilter] = useState<"pending" | "approved" | "rejected" | "all">(
    "pending",
  );
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);

  async function load() {
    try {
      const qs = filter === "all" ? "" : `?status=${filter}`;
      const res = await fetch(`${BACKEND_URL}/api/approvals${qs}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { approvals: Approval[] };
      setApprovals(data.approvals);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load approvals");
    }
  }

  // Reload when filter changes and every 5s while the view is open.
  // The setState inside `load` happens after `await fetch(...)`, so it's
  // already async — `void` here is just the explicit fire-and-forget.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function decide(id: string, approved: boolean) {
    setDeciding(id);
    try {
      const res = await fetch(`${BACKEND_URL}/api/approvals/${id}/decide`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Decide failed");
    } finally {
      setDeciding(null);
    }
  }

  const counts = {
    pending: approvals?.filter((a) => a.status === "pending").length ?? 0,
    approved: approvals?.filter((a) => a.status === "approved").length ?? 0,
    rejected: approvals?.filter((a) => a.status === "rejected").length ?? 0,
  };

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Proposed Actions
          </h1>
          <p className="text-sm text-slate-500">
            Review what the agent wants to do before it touches GitHub or any
            connected tool.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
        >
          Refresh
        </button>
      </div>

      {/* Filter pills */}
      <div className="flex items-center gap-2">
        {(["pending", "approved", "rejected", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={
              "rounded-full border px-3 py-1 text-xs font-semibold capitalize transition " +
              (filter === f
                ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
            }
          >
            {f}
          </button>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}. Is the backend running on {BACKEND_URL}?
        </div>
      )}

      {/* List */}
      {approvals === null && !error ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
          Loading approvals…
        </div>
      ) : approvals && approvals.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600">
            <IconCheckList />
          </div>
          <div className="text-sm font-semibold text-slate-700">
            Nothing in the inbox.
          </div>
          <div className="mt-1 text-xs text-slate-500">
            {filter === "pending"
              ? "Agents have not queued anything for review yet. Launch a run from the dashboard."
              : `No ${filter} approvals.`}
          </div>
        </div>
      ) : (
        <>
          {/* Tiny status summary */}
          <div className="grid gap-3 text-xs text-slate-500 sm:grid-cols-3">
            <div className="rounded-xl border border-amber-100 bg-amber-50 px-4 py-3">
              <strong className="text-slate-900">{counts.pending}</strong>{" "}
              waiting for your decision
            </div>
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3">
              <strong className="text-slate-900">{counts.approved}</strong>{" "}
              approved
            </div>
            <div className="rounded-xl border border-rose-100 bg-rose-50 px-4 py-3">
              <strong className="text-slate-900">{counts.rejected}</strong>{" "}
              rejected
            </div>
          </div>

          <div className="space-y-3">
            {(approvals ?? []).map((a) => (
              <ApprovalCard
                key={a.id}
                approval={a}
                onDecide={decide}
                busy={deciding === a.id}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ApprovalCard({
  approval,
  onDecide,
  busy,
}: {
  approval: Approval;
  onDecide: (id: string, approved: boolean) => void;
  busy: boolean;
}) {
  const isPending = approval.status === "pending";
  const actionType = approval.proposedActionJson?.type ?? "action";
  const reviewItems = buildChangeReviewItemsFromInput(
    approval.proposedActionJson,
  );
  const isSeoApproval = actionType === "seo_pr_approval";
  const prUrl = extractFirstUrl(approval.decisionNote);
  const changeCount = reviewItems.length;

  const statusBadge: Record<Approval["status"], string> = {
    pending: "bg-amber-50 text-amber-700",
    approved: "bg-emerald-50 text-emerald-700",
    rejected: "bg-rose-50 text-rose-700",
    modified: "bg-slate-100 text-slate-700",
    expired: "bg-slate-100 text-slate-500",
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                statusBadge[approval.status]
              }
            >
              {approval.status}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-700">
              {actionType.replace(/_/g, " ")}
            </span>
            <span className="text-slate-500">
              run{" "}
              <span className="font-mono text-slate-700">
                {approval.skillRunId.slice(0, 8)}
              </span>
            </span>
            <span className="text-slate-400">·</span>
            <span className="text-slate-500">
              {formatRelative(approval.createdAt)}
            </span>
          </div>
          <h3 className="mt-2 text-base font-semibold">{approval.title}</h3>
          <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
            {approval.summary}
          </p>

          {isSeoApproval && (
            <div className="mt-4 grid gap-3 text-xs text-slate-600 md:grid-cols-3">
              <ApprovalFact
                label="Decision needed"
                value={
                  isPending
                    ? "Create GitHub PR?"
                    : approval.status === "approved"
                      ? "PR approved"
                      : "Plan rejected"
                }
              />
              <ApprovalFact
                label="Proposed changes"
                value={
                  changeCount === 1 ? "1 change" : `${changeCount} changes`
                }
              />
              <ApprovalFact
                label="GitHub status"
                value={
                  isPending
                    ? "No PR yet"
                    : prUrl
                      ? "PR created"
                      : "No PR created"
                }
              />
            </div>
          )}

          {isSeoApproval && (
            <ApprovalOutcome
              approval={approval}
              prUrl={prUrl}
              isPending={isPending}
            />
          )}

          {isSeoApproval && approval.proposedActionJson.plan && (
            <div className="mt-4">
              <SeoPlanSummary
                plan={approval.proposedActionJson.plan}
                draftSource={approval.proposedActionJson.draftSource}
                fallbackReason={approval.proposedActionJson.fallbackReason}
              />
            </div>
          )}

          {isSeoApproval && approval.proposedActionJson.qualityGate && (
            <div className="mt-3">
              <SeoQualityGateSummary qualityGate={approval.proposedActionJson.qualityGate} />
            </div>
          )}

          {isSeoApproval && reviewItems.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer select-none text-xs font-semibold text-indigo-600 hover:text-indigo-700">
                Review proposed before/after changes ({reviewItems.length})
              </summary>
              <div className="mt-3 space-y-3">
                {reviewItems.map((item) => (
                  <ChangeReviewCard key={item.id} item={item} />
                ))}
              </div>
            </details>
          )}

          <details className="mt-3 text-xs text-slate-500">
            <summary className="cursor-pointer select-none font-semibold text-slate-600 hover:text-slate-900">
              Reasoning &amp; rollback plan
            </summary>
            <div className="mt-2 space-y-1.5 pl-3">
              <div>
                <span className="font-semibold uppercase tracking-wider">
                  Reasoning:
                </span>{" "}
                {approval.reasoning}
              </div>
              <div>
                <span className="font-semibold uppercase tracking-wider">
                  Expected impact:
                </span>{" "}
                {approval.expectedImpact}
              </div>
              <div>
                <span className="font-semibold uppercase tracking-wider">
                  Rollback plan:
                </span>{" "}
                {approval.rollbackPlan}
              </div>
              {approval.decidedAt && (
                <div>
                  <span className="font-semibold uppercase tracking-wider">
                    Decided:
                  </span>{" "}
                  {formatRelative(approval.decidedAt)} by{" "}
                  {approval.decidedBy ?? "?"}
                </div>
              )}
              {approval.decisionNote && (
                <div>
                  <span className="font-semibold uppercase tracking-wider">
                    Result note:
                  </span>{" "}
                  {approval.decisionNote}
                </div>
              )}
            </div>
          </details>
        </div>

        <div className="w-full shrink-0 rounded-xl border border-slate-100 bg-slate-50 p-4 xl:w-72">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
            Decision
          </div>
          <p className="mt-2 text-xs leading-5 text-slate-600">
            {isPending
              ? isSeoApproval
                ? "Approve creates a GitHub PR. Your live site still changes only after you merge that PR on GitHub."
                : "Approve lets the agent execute this action. Reject discards it."
              : approval.status === "approved"
                ? "This action was approved. The result is recorded on this card."
                : "This action was rejected. The agent will not execute it."}
          </p>
          {isPending ? (
            <div className="mt-4 flex flex-col gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide(approval.id, true)}
                className="rounded-lg bg-indigo-600 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
              >
                {busy ? "…" : isSeoApproval ? "Approve PR" : "Approve"}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onDecide(approval.id, false)}
                className="rounded-lg border border-slate-200 bg-white py-1.5 text-sm font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-50"
              >
                Reject
              </button>
            </div>
          ) : (
            <div className="mt-4 rounded-lg bg-white px-3 py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-slate-500">
              {approval.status}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ApprovalFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        {label}
      </div>
      <div className="mt-1 font-semibold text-slate-800">{value}</div>
    </div>
  );
}

function ApprovalOutcome({
  approval,
  prUrl,
  isPending,
}: {
  approval: Approval;
  prUrl?: string;
  isPending: boolean;
}) {
  if (isPending) {
    return (
      <div className="mt-4 rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-xs leading-5 text-indigo-800">
        Nothing has been written to GitHub yet. This is only a prepared plan
        waiting for your approval.
      </div>
    );
  }

  if (approval.status === "approved" && prUrl) {
    return (
      <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-800">
        PR created after approval:{" "}
        <a
          href={prUrl}
          target="_blank"
          rel="noreferrer"
          className="break-all font-mono font-semibold text-emerald-700 hover:text-emerald-900"
        >
          {prUrl}
        </a>
      </div>
    );
  }

  if (approval.status === "approved") {
    return (
      <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-800">
        Approved. The backend recorded the decision.
      </div>
    );
  }

  if (approval.status === "rejected") {
    return (
      <div className="mt-4 rounded-xl border border-rose-100 bg-rose-50 px-4 py-3 text-xs leading-5 text-rose-800">
        Rejected. No GitHub PR was created for this proposed action.
      </div>
    );
  }

  return null;
}

function extractFirstUrl(value?: string): string | undefined {
  return value?.match(/https?:\/\/\S+/)?.[0];
}

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const s = Math.round(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString();
}

/* =====================================================================
   AGENTS VIEW — list every skill run, click to see its trace
   ===================================================================== */

function AgentsView() {
  const [runs, setRuns] = useState<SkillRun[] | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`${BACKEND_URL}/api/skill-runs`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { skillRuns: SkillRun[] };
        if (!cancelled) setRuns(data.skillRuns);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      }
    }
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (error && !runs) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">
        Couldn&apos;t load runs: {error}.
      </div>
    );
  }
  if (!runs) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        Loading runs…
      </div>
    );
  }

  const statusColor: Record<SkillRun["status"], string> = {
    running: "bg-indigo-50 text-indigo-700",
    completed: "bg-emerald-50 text-emerald-700",
    failed: "bg-rose-50 text-rose-700",
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
        <p className="text-sm text-slate-500">
          Every run the agent has started. Click a row to inspect its trace.
        </p>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
            <IconBot />
          </div>
          <div className="text-sm font-semibold text-slate-700">
            No runs yet.
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Click <strong>+ New Run</strong> to launch one.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((r) => (
            <div
              key={r.taskId}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <button
                type="button"
                onClick={() =>
                  setExpandedId((cur) => (cur === r.taskId ? null : r.taskId))
                }
                className="flex w-full items-center justify-between gap-4 text-left"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={
                        "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                        statusColor[r.status]
                      }
                    >
                      {r.status}
                      {r.status === "running" && (
                        <span className="ml-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
                      )}
                    </span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-700">
                      {r.skillId}
                    </span>
                    <span className="text-slate-500">
                      {formatRelative(r.createdAt)}
                    </span>
                  </div>
                  <div className="mt-1.5 text-sm font-semibold text-slate-900">
                    {displayRunSubject(r.inputContext)}
                  </div>
                  <div className="mt-0.5 text-xs text-slate-500">
                    {r.steps.length} step{r.steps.length === 1 ? "" : "s"} ·{" "}
                    {r.drafts.length} draft{r.drafts.length === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="text-slate-400">
                  {expandedId === r.taskId ? "▴" : "▾"}
                </div>
              </button>

              {expandedId === r.taskId && (
                <div className="mt-4 border-t border-slate-100 pt-4">
                  <AgentDecisionPanel run={r} />
                  {r.finalReport?.structuredOutputs &&
                    r.finalReport.structuredOutputs.length > 0 && (
                      <div className="mb-4">
                        <StructuredOutputList
                          outputs={r.finalReport.structuredOutputs}
                        />
                      </div>
                    )}
                  <RunResultsPanel run={r} />
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Trace
                  </div>
                  <div className="mt-2 max-h-72 space-y-1.5 overflow-y-auto font-mono text-xs">
                    {r.steps.length === 0 ? (
                      <div className="text-slate-500">No steps recorded.</div>
                    ) : (
                      r.steps.map((s) => (
                        <div key={s.stepId} className="flex gap-3">
                          <span className="shrink-0 text-slate-400">
                            {s.timestamp.slice(11, 19)}
                          </span>
                          <span
                            className={
                              s.type === "tool_call"
                                ? "text-indigo-600"
                                : "text-emerald-600"
                            }
                          >
                            {s.type}
                          </span>
                          <span className="text-slate-700">
                            {s.toolName ?? ""}{" "}
                            <span className="text-slate-500">
                              {s.content.slice(0, 120)}
                            </span>
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentDecisionPanel({ run }: { run: SkillRun }) {
  const decision = run.finalReport?.decision ?? legacyDecisionFromReport(run);
  if (!decision) return null;

  const tone = decisionTone(decision.severity);

  return (
    <div className={`mb-4 border-l-4 ${tone.border} bg-slate-50 px-4 py-3`}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone.badge}`}
        >
          {decision.label}
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          Agent decision
        </span>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
          {formatRelative(decision.createdAt)}
        </span>
      </div>
      <p className="mt-2 text-sm font-medium text-slate-900">
        {decision.summary}
      </p>
      <p className="mt-1 text-xs leading-5 text-slate-600">
        <span className="font-semibold text-slate-700">Why:</span>{" "}
        {decision.reason}
      </p>
      <p className="mt-1 text-xs leading-5 text-slate-600">
        <span className="font-semibold text-slate-700">Next:</span>{" "}
        {decision.nextStep}
      </p>
      {decision.link && (
        <a
          href={decision.link}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex text-xs font-semibold text-indigo-600 hover:text-indigo-700"
        >
          Open GitHub PR
        </a>
      )}
    </div>
  );
}

function RunResultsPanel({ run }: { run: SkillRun }) {
  const report = run.finalReport;
  if (!report) return null;
  const hasStructuredOutputs = (report.structuredOutputs?.length ?? 0) > 0;

  return (
    <details
      open={!hasStructuredOutputs}
      className="mb-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
    >
      <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            Full run report
          </div>
          <h3 className="mt-1 text-base font-semibold text-slate-900">
            {run.skillId}
          </h3>
          {!hasStructuredOutputs && (
            <p className="mt-1 text-sm leading-6 text-slate-600">
              {report.executiveSummary}
            </p>
          )}
        </div>
        <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
          {displayRunSubject(run.inputContext)}
        </span>
      </summary>

      <div className="mt-4">
        {hasStructuredOutputs && (
          <p className="mb-4 text-sm leading-6 text-slate-600">
            {report.executiveSummary}
          </p>
        )}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <ResultList title="Findings" items={report.findings} />
          <ResultList title="Recommendations" items={report.recommendations} />
          <ResultList title="Next steps" items={report.nextSteps} />
          <ResultList
            title="Proposed actions"
            items={report.proposedActions.map((action) => action.title)}
          />
        </div>

        {report.drafts.length > 0 && (
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Saved drafts
            </div>
            <div className="mt-3 space-y-3">
              {report.drafts.map((draft, index) => (
                <details
                  key={`${draft.title}-${index}`}
                  className="rounded-lg border border-slate-200 bg-white p-3"
                >
                  <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                    {draft.title}
                    <span className="ml-2 text-xs font-normal text-slate-500">
                      {draft.type}
                    </span>
                  </summary>
                  <DraftContent content={draft.content} />
                </details>
              ))}
            </div>
          </div>
        )}
      </div>
    </details>
  );
}

function DraftContent({ content }: { content: string }) {
  const lines = content.split("\n");

  return (
    <div className="mt-3 max-h-96 overflow-y-auto rounded-lg border border-slate-200 bg-white p-4">
      <div className="space-y-2">
        {lines.map((rawLine, index) => {
          const line = rawLine.trim();

          if (!line) {
            return <div key={index} className="h-2" />;
          }

          const heading = line.match(/^(#{1,3})\s+(.+)$/);
          if (heading) {
            const level = heading[1]?.length ?? 1;
            const headingText = stripSimpleMarkdown(heading[2] ?? "");
            const headingClass =
              level === 1
                ? "text-base font-semibold text-slate-950"
                : "text-sm font-semibold text-slate-900";

            return (
              <div key={index} className={headingClass}>
                {headingText}
              </div>
            );
          }

          const bullet = line.match(/^[-*]\s+(.+)$/);
          if (bullet) {
            return (
              <div key={index} className="flex gap-2 text-sm leading-6 text-slate-700">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-indigo-400" />
                <span>{renderInlineMarkdown(bullet[1] ?? "")}</span>
              </div>
            );
          }

          const numbered = line.match(/^(\d+)\.\s+(.+)$/);
          if (numbered) {
            return (
              <div key={index} className="flex gap-2 text-sm leading-6 text-slate-700">
                <span className="shrink-0 font-semibold text-slate-400">
                  {numbered[1]}.
                </span>
                <span>{renderInlineMarkdown(numbered[2] ?? "")}</span>
              </div>
            );
          }

          return (
            <p key={index} className="text-sm leading-6 text-slate-700">
              {renderInlineMarkdown(line)}
            </p>
          );
        })}
      </div>
    </div>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, index) => {
    const boldMatch = part.match(/^\*\*([^*]+)\*\*$/);
    if (boldMatch) {
      return (
        <strong key={index} className="font-semibold text-slate-900">
          {boldMatch[1]}
        </strong>
      );
    }

    return <span key={index}>{stripSimpleMarkdown(part)}</span>;
  });
}

function stripSimpleMarkdown(text: string): string {
  return text.replace(/\*\*/g, "").replace(/`/g, "").trim();
}

function ResultList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/70 p-4">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {title}
      </div>
      {items.length === 0 ? (
        <div className="mt-2 text-xs text-slate-400">None recorded.</div>
      ) : (
        <ul className="mt-2 space-y-2">
          {items.map((item, index) => (
            <li key={index} className="text-xs leading-5 text-slate-700">
              <span className="mr-2 font-semibold text-slate-400">
                {index + 1}.
              </span>
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function decisionTone(severity: AgentDecision["severity"]): {
  border: string;
  badge: string;
} {
  if (severity === "success") {
    return {
      border: "border-emerald-400",
      badge: "bg-emerald-50 text-emerald-700",
    };
  }
  if (severity === "warning") {
    return {
      border: "border-amber-400",
      badge: "bg-amber-50 text-amber-700",
    };
  }
  if (severity === "danger") {
    return {
      border: "border-rose-400",
      badge: "bg-rose-50 text-rose-700",
    };
  }
  return {
    border: "border-slate-300",
    badge: "bg-slate-100 text-slate-700",
  };
}

function legacyDecisionFromReport(run: SkillRun): AgentDecision | null {
  const report = run.finalReport;
  if (!report) return null;

  const firstAction = report.proposedActions[0];
  if (firstAction?.status === "pending") {
    return {
      kind: "approval_waiting",
      label: "Approval needed",
      summary: firstAction.title,
      reason: firstAction.description,
      nextStep: "Open Proposed Actions to approve or reject this change.",
      severity: "warning",
      createdAt: run.updatedAt,
    };
  }

  if (report.executiveSummary.includes("No GitHub PR was prepared")) {
    return {
      kind: "pr_skipped",
      label: "No PR needed",
      summary: report.executiveSummary,
      reason: "The agent finished the audit without finding necessary source changes.",
      nextStep: "Use this run as a health check.",
      severity: "success",
      createdAt: run.updatedAt,
    };
  }

  if (firstAction?.status === "executed" && firstAction.result) {
    return {
      kind: "pr_created",
      label: "PR created",
      summary: firstAction.result,
      reason: firstAction.description,
      nextStep: "Review and merge the GitHub PR, then check verification in Settings.",
      severity: "success",
      createdAt: firstAction.resolvedAt ?? run.updatedAt,
    };
  }

  return {
    kind: "pr_skipped",
    label: "Run completed",
    summary: report.executiveSummary,
    reason: report.recommendations[0] ?? "The run completed without a pending approval.",
    nextStep: report.nextSteps[0] ?? "Review the trace below for details.",
    severity: "neutral",
    createdAt: run.updatedAt,
  };
}

/* =====================================================================
   DRAFTS VIEW — every draft saved by every run
   ===================================================================== */

type FlatDraft = {
  title: string;
  content: string;
  type: string;
  createdAt: string;
  taskId: string;
  skillId: string;
  productName: string | null;
};

function DraftsView() {
  const [drafts, setDrafts] = useState<FlatDraft[] | null>(null);
  const [filter, setFilter] = useState<string>("all");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const r = await fetch(`${BACKEND_URL}/api/drafts`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = (await r.json()) as { drafts: FlatDraft[] };
        if (!cancelled) setDrafts(data.drafts);
      } catch {
        if (!cancelled) setDrafts([]);
      }
    }
    void load();
    const t = setInterval(() => void load(), 6000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (!drafts) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        Loading drafts…
      </div>
    );
  }

  const types = Array.from(new Set(drafts.map((d) => d.type)));
  const visible =
    filter === "all" ? drafts : drafts.filter((d) => d.type === filter);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Drafts</h1>
        <p className="text-sm text-slate-500">
          Everything the agents have drafted across all runs. Copy or edit; the
          originals stay in the run.
        </p>
      </div>

      {drafts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
            <IconDoc />
          </div>
          <div className="text-sm font-semibold text-slate-700">
            No drafts yet.
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Drafts will appear here as the agents save them.
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setFilter("all")}
              className={
                "rounded-full border px-3 py-1 text-xs font-semibold capitalize transition " +
                (filter === "all"
                  ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
              }
            >
              all ({drafts.length})
            </button>
            {types.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setFilter(t)}
                className={
                  "rounded-full border px-3 py-1 text-xs font-semibold capitalize transition " +
                  (filter === t
                    ? "border-indigo-200 bg-indigo-50 text-indigo-700"
                    : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50")
                }
              >
                {t.replace(/_/g, " ")} (
                {drafts.filter((d) => d.type === t).length})
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {visible.map((d, i) => (
              <div
                key={i}
                className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
              >
                <div className="flex items-start justify-between">
                  <span className="inline-block rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
                    {d.type.replace(/_/g, " ")}
                  </span>
                  <span className="text-xs text-slate-400">
                    {formatRelative(d.createdAt)}
                  </span>
                </div>
                <h3 className="mt-3 text-base font-semibold">{d.title}</h3>
                <p className="mt-2 max-h-40 overflow-hidden text-sm leading-relaxed text-slate-600">
                  {d.content.slice(0, 400)}
                  {d.content.length > 400 && "…"}
                </p>
                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs text-slate-500">
                  <span>
                    {d.skillId}{" "}
                    {d.productName && (
                      <span className="text-slate-400">· {d.productName}</span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(d.content);
                    }}
                    className="font-semibold text-indigo-600 hover:text-indigo-700"
                  >
                    Copy
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/* =====================================================================
   CONNECTIONS VIEW — integration management
   ===================================================================== */

type ConnRec = ConnectionRecord;

const connectionMeta: Record<
  string,
  { name: string; help: string; sample: string }
> = {
  site: {
    name: "Website",
    help: "Public URL the agent crawls + audits.",
    sample: "https://your-site.com",
  },
  ga4: {
    name: "Google Analytics 4",
    help: "Property ID powers the performance memory bundle.",
    sample: "GA4 property ID",
  },
  gsc: {
    name: "Google Search Console",
    help: "Site URL powers organic-traffic insights.",
    sample: "Verified domain",
  },
  github: {
    name: "GitHub",
    help: "Repository where PR-based writes (alt-text, schema, copy) land.",
    sample: "owner/repo",
  },
  meta_ads: {
    name: "Meta Ads",
    help: "OAuth — required before YELLOW ad tools run.",
    sample: "Ad account ID",
  },
  google_ads: {
    name: "Google Ads",
    help: "OAuth — required before YELLOW ad tools run.",
    sample: "Customer ID",
  },
  linkedin_ads: {
    name: "LinkedIn Ads",
    help: "OAuth — required before YELLOW ad tools run.",
    sample: "Account ID",
  },
  wordpress: {
    name: "WordPress",
    help: "Site URL + REST API token for content writes.",
    sample: "https://your-wp-site.com",
  },
  webflow: {
    name: "Webflow",
    help: "Site ID + API token for content writes.",
    sample: "Site ID",
  },
  email: {
    name: "Email provider",
    help: "Resend / Loops / Klaviyo API key.",
    sample: "API key",
  },
};

function ConnectionsView() {
  const [conns, setConns] = useState<ConnRec[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [siteUrl, setSiteUrl] = useState("");
  const [siteLabel, setSiteLabel] = useState("");
  const [sitePrimary, setSitePrimary] = useState(true);
  const [githubOwner, setGithubOwner] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  const [githubBranch, setGithubBranch] = useState("main");
  const [githubSettings, setGithubSettings] = useState<GitHubOAuthSettings | null>(null);
  const [githubRepos, setGithubRepos] = useState<GitHubRepository[]>([]);
  const [loadingGithubRepos, setLoadingGithubRepos] = useState(false);
  const [githubHealth, setGithubHealth] = useState<GitHubConnectionHealth | null>(null);
  const [checkingGithubHealth, setCheckingGithubHealth] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [data, settings] = await Promise.all([
          listConnections(),
          getGitHubOAuthSettings(),
        ]);
        if (!cancelled) {
          setConns(data);
          setGithubSettings(settings);
          setOffline(false);
        }
      } catch {
        if (!cancelled) {
          setConns([]);
          setOffline(true);
        }
      }
    }
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    if (!githubSettings?.hasToken) {
      queueMicrotask(() => {
        if (!cancelled) setGithubRepos([]);
      });
      return () => {
        cancelled = true;
      };
    }

    async function loadRepos(): Promise<void> {
      setLoadingGithubRepos(true);
      try {
        const repos = await listGitHubRepositories();
        if (!cancelled) setGithubRepos(repos);
      } catch {
        if (!cancelled) setGithubRepos([]);
      } finally {
        if (!cancelled) setLoadingGithubRepos(false);
      }
    }

    void loadRepos();
    return () => {
      cancelled = true;
    };
  }, [githubSettings?.hasToken]);

  if (!conns) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        Loading connections…
      </div>
    );
  }

  const active = conns.filter((c) => c.status === "active").length;
  const sites = conns.filter((c) => c.type === "site");
  const github = conns.find((c) => c.type === "github");
  const githubConfig = github?.configJson ?? {};
  const displayedOwner = githubOwner || readConfigString(githubConfig.owner);
  const displayedRepo = githubRepo || readConfigString(githubConfig.repo);
  const displayedBranch =
    githubBranch || readConfigString(githubConfig.defaultBranch) || "main";
  const connectedAccount =
    readConfigString(githubConfig.connectedAccount) ||
    githubSettings?.connectedAccount ||
    "";
  const selectedRepoFullName =
    displayedOwner && displayedRepo ? `${displayedOwner}/${displayedRepo}` : "";
  const storedHealthSummary = readConfigString(githubConfig.healthSummary);
  const storedHealthCheckedAt = readConfigString(githubConfig.healthCheckedAt);

  const statusDot: Record<ConnRec["status"], string> = {
    active: "bg-emerald-500",
    pending: "bg-amber-500",
    expired: "bg-slate-400",
    error: "bg-rose-500",
  };

  async function refreshConnections(): Promise<void> {
    const [data, settings] = await Promise.all([
      listConnections(),
      getGitHubOAuthSettings(),
    ]);
    setConns(data);
    setGithubSettings(settings);
    setOffline(false);
  }

  async function addSite(): Promise<void> {
    const url = siteUrl.trim();
    if (!url) {
      setMessage("Enter a site URL first.");
      return;
    }

    setSaving(true);
    setMessage("");
    try {
      await createConnection({
        type: "site",
        configJson: {
          url,
          label: siteLabel.trim() || "Website",
          isPrimary: sitePrimary,
        },
      });
      setSiteUrl("");
      setSiteLabel("");
      setSitePrimary(true);
      await refreshConnections();
      setMessage("Website connection saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save website.");
    } finally {
      setSaving(false);
    }
  }

  async function makePrimary(site: ConnRec): Promise<void> {
    setSaving(true);
    setMessage("");
    try {
      await updateConnection(site.id, {
        configJson: {
          ...site.configJson,
          isPrimary: true,
        },
      });
      await refreshConnections();
      setMessage("Primary website updated.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not update primary site.");
    } finally {
      setSaving(false);
    }
  }

  async function saveGithub(): Promise<void> {
    const owner = displayedOwner.trim();
    const repo = displayedRepo.trim();
    const defaultBranch = displayedBranch.trim() || "main";
    if (!owner || !repo) {
      setMessage("Enter both GitHub owner and repo.");
      return;
    }

    setSaving(true);
    setMessage("");
    try {
      if (github) {
        await updateConnection(github.id, {
          configJson: { owner, repo, defaultBranch },
        });
      } else {
        await createConnection({
          type: "github",
          configJson: { owner, repo, defaultBranch },
        });
      }
      await refreshConnections();
      setGithubHealth(null);
      setMessage("GitHub repo connection saved.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not save GitHub repo.");
    } finally {
      setSaving(false);
    }
  }

  function connectGithub(): void {
    window.location.href = githubOAuthStartUrl();
  }

  function selectGithubRepo(fullName: string): void {
    const repo = githubRepos.find((item) => item.fullName === fullName);
    if (!repo) return;
    setGithubOwner(repo.owner);
    setGithubRepo(repo.repo);
    setGithubBranch(repo.defaultBranch || "main");
  }

  async function disconnectGithubAccount(): Promise<void> {
    setSaving(true);
    setMessage("");
    try {
      await disconnectGitHub();
      setGithubRepos([]);
      setGithubHealth(null);
      await refreshConnections();
      setMessage("GitHub account disconnected. Repo details were kept, but OAuth access was removed.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not disconnect GitHub.");
    } finally {
      setSaving(false);
    }
  }

  async function runGithubHealthCheck(): Promise<void> {
    setCheckingGithubHealth(true);
    setMessage("");
    try {
      const health = await checkGitHubConnectionHealth();
      setGithubHealth(health);
      await refreshConnections();
      setMessage(health.ok ? "GitHub connection is ready for PRs." : health.summary);
    } catch (err) {
      setGithubHealth(null);
      setMessage(err instanceof Error ? err.message : "GitHub health check failed.");
    } finally {
      setCheckingGithubHealth(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="text-sm text-slate-500">
            External services the agent reads from and writes to. Status
            &quot;pending&quot; means we haven&apos;t authenticated yet.
          </p>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {offline && (
            <span className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
              Offline
            </span>
          )}
          <span>
            <strong className="text-slate-900">{active}</strong> active /{" "}
            {conns.length}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.25fr_0.9fr]">
        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Websites</h2>
              <p className="mt-1 text-sm text-slate-500">
                Add every site the agent may audit. The primary site is the
                default target for scheduled SEO runs.
              </p>
            </div>
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
              {sites.length} site{sites.length === 1 ? "" : "s"}
            </span>
          </div>

          <div className="mt-5 grid grid-cols-1 gap-3 lg:grid-cols-[1fr_0.7fr_auto]">
            <label className="block">
              <FormLabel>Site URL</FormLabel>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                placeholder="https://your-site.com"
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
              />
            </label>
            <label className="block">
              <FormLabel>Label</FormLabel>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                placeholder="Marketing site"
                value={siteLabel}
                onChange={(e) => setSiteLabel(e.target.value)}
              />
            </label>
            <div className="flex items-end gap-3">
              <label className="mb-2 flex items-center gap-2 text-xs font-semibold text-slate-600">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded border-slate-300 text-indigo-600"
                  checked={sitePrimary}
                  onChange={(e) => setSitePrimary(e.target.checked)}
                />
                Primary
              </label>
              <button
                type="button"
                onClick={() => void addSite()}
                disabled={saving}
                className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
              >
                Add site
              </button>
            </div>
          </div>

          <div className="mt-5 divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200">
            {sites.length === 0 ? (
              <div className="p-4 text-sm text-slate-500">
                No websites connected yet.
              </div>
            ) : (
              sites.map((site) => {
                const isPrimary = site.configJson.isPrimary === true;
                return (
                  <div
                    key={site.id}
                    className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-sm text-slate-900">
                          {readConfigString(site.configJson.url) || "(missing URL)"}
                        </span>
                        {isPrimary && (
                          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                            Primary
                          </span>
                        )}
                      </div>
                      <div className="mt-1 text-xs text-slate-500">
                        {readConfigString(site.configJson.label) || "Website"} ·{" "}
                        {site.status}
                      </div>
                    </div>
                    {!isPrimary && (
                      <button
                        type="button"
                        onClick={() => void makePrimary(site)}
                        disabled={saving}
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                      >
                        Make primary
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">GitHub repo</h2>
              <p className="mt-1 text-sm text-slate-500">
                Connect GitHub, pick the website repo, and the agent will open
                PRs against that repo after approval.
              </p>
            </div>
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                (github?.status === "active"
                  ? "bg-emerald-50 text-emerald-700"
                  : "bg-amber-50 text-amber-700")
              }
            >
              {github?.status ?? "not set"}
            </span>
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Account access
                </div>
                <div className="mt-1 font-medium text-slate-900">
                  {connectedAccount
                    ? `Connected as @${connectedAccount}`
                    : githubSettings?.configured
                      ? "Not connected yet"
                      : "OAuth app not configured"}
                </div>
                {githubSettings?.setupMessage && (
                  <div className="mt-1 text-xs text-amber-700">
                    {githubSettings.setupMessage}
                  </div>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={connectGithub}
                  disabled={saving || githubSettings?.configured === false}
                  className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
                >
                  {connectedAccount ? "Reconnect" : "Connect GitHub"}
                </button>
                {connectedAccount && (
                  <button
                    type="button"
                    onClick={() => void disconnectGithubAccount()}
                    disabled={saving}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
                  >
                    Disconnect
                  </button>
                )}
              </div>
            </div>
          </div>

          {githubSettings?.hasToken && (
            <label className="mt-4 block">
              <FormLabel>Choose repository</FormLabel>
              <select
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                value={selectedRepoFullName}
                onChange={(e) => selectGithubRepo(e.target.value)}
              >
                <option value="">
                  {loadingGithubRepos ? "Loading repositories..." : "Select a repo"}
                </option>
                {githubRepos.map((repo) => (
                  <option key={repo.id} value={repo.fullName}>
                    {repo.fullName}
                    {repo.private ? " private" : ""}
                  </option>
                ))}
              </select>
            </label>
          )}

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="block">
              <FormLabel>Owner</FormLabel>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                placeholder="devansh-gauniyal"
                value={displayedOwner}
                onChange={(e) => setGithubOwner(e.target.value)}
              />
            </label>
            <label className="block">
              <FormLabel>Repository</FormLabel>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                placeholder="demo-saas-website"
                value={displayedRepo}
                onChange={(e) => setGithubRepo(e.target.value)}
              />
            </label>
            <label className="block sm:col-span-2">
              <FormLabel>Default branch</FormLabel>
              <input
                className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
                placeholder="main"
                value={displayedBranch}
                onChange={(e) => setGithubBranch(e.target.value)}
              />
            </label>
          </div>

          <button
            type="button"
            onClick={() => void saveGithub()}
            disabled={saving}
            className="mt-4 w-full rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            Save GitHub repo
          </button>

          <div className="mt-3 rounded-xl border border-slate-200 bg-white px-3 py-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Readiness check
                </div>
                <div className="mt-1 text-sm text-slate-600">
                  {githubHealth?.summary ||
                    storedHealthSummary ||
                    "Verify repo access before the agent creates PRs."}
                </div>
                {storedHealthCheckedAt && !githubHealth && (
                  <div className="mt-1 text-[10px] uppercase tracking-wider text-slate-400">
                    Last checked {formatRelative(storedHealthCheckedAt)}
                  </div>
                )}
              </div>
              <button
                type="button"
                onClick={() => void runGithubHealthCheck()}
                disabled={
                  saving ||
                  checkingGithubHealth ||
                  !githubSettings?.hasToken ||
                  !displayedOwner ||
                  !displayedRepo
                }
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:text-slate-400"
              >
                {checkingGithubHealth ? "Checking..." : "Check connection"}
              </button>
            </div>

            {githubHealth && (
              <div className="mt-3 grid grid-cols-1 gap-2">
                {githubHealth.checks.map((check) => (
                  <div
                    key={check.key}
                    className={
                      "rounded-lg border px-3 py-2 text-xs " +
                      (check.ok
                        ? "border-emerald-100 bg-emerald-50 text-emerald-800"
                        : "border-rose-100 bg-rose-50 text-rose-800")
                    }
                  >
                    <div className="font-semibold">
                      {check.ok ? "Ready" : "Needs attention"} · {check.label}
                    </div>
                    <div className="mt-0.5">{check.detail}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Saved repo:{" "}
            <span className="font-mono text-slate-700">
              {readConfigString(githubConfig.owner) || "(owner)"}/
              {readConfigString(githubConfig.repo) || "(repo)"}
            </span>
            {readConfigString(githubConfig.tokenSource) && (
              <span className="ml-2 rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {readConfigString(githubConfig.tokenSource)}
              </span>
            )}
          </div>
        </section>
      </div>

      {message && (
        <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm font-medium text-indigo-700">
          {message}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {conns.filter((c) => c.type !== "site" && c.type !== "github").map((c) => {
          const meta = connectionMeta[c.type] ?? {
            name: c.type,
            help: "",
            sample: "",
          };
          return (
            <div
              key={c.id}
              className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={
                        "h-2.5 w-2.5 rounded-full " + statusDot[c.status]
                      }
                    />
                    <span className="text-sm font-semibold">{meta.name}</span>
                  </div>
                  <div className="mt-1 text-xs text-slate-500">{meta.help}</div>
                </div>
                <span
                  className={
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                    (c.status === "active"
                      ? "bg-emerald-50 text-emerald-700"
                      : c.status === "pending"
                        ? "bg-amber-50 text-amber-700"
                        : c.status === "error"
                          ? "bg-rose-50 text-rose-700"
                          : "bg-slate-100 text-slate-600")
                  }
                >
                  {c.status}
                </span>
              </div>
              <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 font-mono text-xs text-slate-600">
                {Object.entries(c.configJson).length === 0 ? (
                  <span className="text-slate-400">(no config yet)</span>
                ) : (
                  Object.entries(c.configJson).map(([k, v]) => (
                    <div key={k}>
                      <span className="text-slate-500">{k}:</span>{" "}
                      <span>
                        {typeof v === "string" && v ? v : (
                          <span className="text-slate-400">(empty)</span>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
              {c.lastSyncedAt && (
                <div className="mt-2 text-[10px] uppercase tracking-wider text-slate-400">
                  Synced {formatRelative(c.lastSyncedAt)}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-xs text-indigo-700">
        GitHub OAuth is workspace-based now. For local development,{" "}
        <code className="font-mono">GITHUB_TOKEN</code> still works as a
        fallback if OAuth is not configured.
      </div>
    </div>
  );
}

function readConfigString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/* =====================================================================
   SETTINGS VIEW — scheduler + workspace + tool calls
   ===================================================================== */

type Job = { id: string; cron: string; description: string };
type SchedulerRunResponse = {
  taskId?: string;
  message?: string;
  error?: string;
};
type ToolCallRec = {
  id: string;
  skillRunId: string;
  toolName: string;
  tier: "GREEN" | "YELLOW" | "RED";
  status: "pending" | "executed" | "rolled_back" | "failed";
  inputJson?: SeoFixInput;
  outputJson?: {
    result?: string;
    changeId?: string;
    verification?: SeoVerificationDetails | null;
  };
  verified?: boolean;
  verificationResult?: string;
  writeStatus?:
    | "unknown"
    | "pr_open"
    | "pr_merged"
    | "pr_closed"
    | "pr_not_found"
    | "simulated";
  writeStatusCheckedAt?: string;
  executedAt?: string;
};

type SeoFixInput = {
  plan?: SeoFixPlan;
  draftSource?: "gemini" | "fallback";
  fallbackReason?: string;
  qualityGate?: SeoFixQualityGate;
  altText?: AltTextPatch[];
  pageMetadata?: PageMetadataPatch[];
  visibleContent?: VisibleContentPatch[];
  copyRewrite?: CopyRewritePatch[];
  ctaRewrite?: CtaRewritePatch[];
  faqSection?: FaqSectionPatch[];
  visualUpgrade?: VisualUpgradePatch[];
  productionUpgrade?: ProductionSiteUpgradePatch[];
  interactiveConversionUpgrade?: InteractiveConversionUpgradePatch[];
};

type SeoFixPlan = {
  auditUrl: string;
  healthScore: number;
  auditFindingCount?: number;
  criticalFindingCount?: number;
  warningFindingCount?: number;
  findingIds?: string[];
  repoAnalysis?: RepoStructureAnalysis;
  primaryFocus: string;
  strategySummary: string;
  items: SeoFixPlanItem[];
};

type SeoVerificationDetails = {
  repoVerification?: {
    ok: boolean;
    summary: string;
  };
  liveAudit?: {
    ok: boolean;
    status: "improved" | "unchanged" | "regressed" | "unavailable";
    summary: string;
    beforeScore?: number;
    currentScore?: number;
    scoreDelta?: number;
    beforeFindingCount?: number;
    currentFindingCount?: number;
    findingDelta?: number;
    remainingCriticalCount?: number;
    remainingWarningCount?: number;
  };
  impact?: SeoImpactSummary;
};

type SeoImpactSummary = {
  verdict:
    | "verified_improvement"
    | "merged_no_improvement"
    | "needs_review"
    | "unavailable";
  label: string;
  summary: string;
  scoreDelta?: number;
  findingDelta?: number;
  repoChecksPassed: boolean;
  checkedAt: string;
};

type SeoFixPlanItem = {
  kind:
    | "copyRewrite"
    | "ctaRewrite"
    | "faqSection"
    | "visualUpgrade"
    | "productionUpgrade"
    | "interactiveConversionUpgrade"
    | "visibleContent"
    | "pageMetadata"
    | "altText";
  filepath: string;
  target: string;
  priority: "critical" | "high" | "medium" | "low";
  reason: string;
  expectedVisibleResult: string;
};

type SeoFixQualityGate = {
  status: "passed" | "blocked";
  score: number;
  summary: string;
  checkedAt: string;
  checks: Array<{
    id: string;
    label: string;
    status: "pass" | "warn" | "fail";
    message: string;
  }>;
};

type AltTextPatch = {
  filepath: string;
  imageSrc: string;
  altText: string;
};

type PageMetadataPatch = {
  filepath: string;
  style: "mdx-frontmatter" | "nextjs-metadata" | "html-head";
  title?: string;
  description?: string;
};

type VisibleContentPatch = {
  filepath: string;
  style: "html-main" | "mdx-section";
  heading: string;
  body: string;
  bullets?: string[];
};

type CopyRewritePatch = {
  filepath: string;
  style: "html-text";
  targetId: string;
  tagName: "h1" | "h2" | "p";
  currentText: string;
  replacementText: string;
};

type CtaRewritePatch = {
  filepath: string;
  style: "html-cta";
  targetId: string;
  element: "a" | "button";
  currentText: string;
  replacementText: string;
};

type FaqSectionPatch = {
  filepath: string;
  style: "html-main" | "mdx-section";
  heading: string;
  faqs: Array<{
    question: string;
    answer: string;
  }>;
};

type VisualUpgradePatch = {
  filepath: string;
  style: "html-main-css";
  stylesheetPath: string;
  eyebrow: string;
  heading: string;
  body: string;
  metrics: Array<{
    value: string;
    label: string;
  }>;
  steps: Array<{
    title: string;
    body: string;
  }>;
  ctaText: string;
  ctaHref: string;
};

type RepoStructureAnalysis = {
  projectKind: string;
  pages: Array<{ filepath: string; issues: string[] }>;
  issues: Array<{ severity: string; code: string; filepath?: string; message: string }>;
  recommendedFocus: string;
};

type ProductionSiteUpgradePatch = {
  filepath: string;
  style: "static-html-page-css";
  pageRole: "home" | "features" | "pricing" | "blog" | "content" | "unknown";
  stylesheetPath: string;
  fixDuplicateH1?: {
    replacementLead: string;
  };
  linkRepairs?: Array<{
    currentHref: string;
    replacementHref: string;
  }>;
  section: {
    eyebrow: string;
    heading: string;
    body: string;
    highlights: Array<{
      title: string;
      body: string;
    }>;
    comparisonRows?: Array<{
      feature: string;
      starter: string;
      growth: string;
      scale: string;
    }>;
    ctaText: string;
    ctaHref: string;
  };
};

type InteractiveConversionUpgradePatch = {
  filepath: string;
  style: "static-html-interactive-css";
  pageRole: "home" | "features" | "pricing" | "blog" | "content" | "unknown";
  stylesheetPath: string;
  section: {
    eyebrow: string;
    heading: string;
    body: string;
    calculatorTitle: string;
    inputLabels: {
      visitors: string;
      conversionRate: string;
      averageValue: string;
    };
    resultLabel: string;
    recommendations: Array<{
      title: string;
      body: string;
    }>;
    ctaText: string;
    ctaHref: string;
  };
};

type ChangeReviewItem = {
  id: string;
  kind: string;
  file: string;
  before: string;
  after: string;
  why: string;
  priority?: string;
  expectedVisibleResult?: string;
  badgeClass: string;
};

function buildChangeReviewItems(call: ToolCallRec): ChangeReviewItem[] {
  return buildChangeReviewItemsFromInput(call.inputJson);
}

function buildChangeReviewItemsFromInput(
  input: SeoFixInput | undefined,
): ChangeReviewItem[] {
  if (!input) return [];

  const items: ChangeReviewItem[] = [];

  for (const patch of input.copyRewrite ?? []) {
    const planItem = findPlanItem(input.plan, "copyRewrite", patch.filepath, patch.targetId);
    items.push({
      id: `copy-${patch.filepath}-${patch.targetId}`,
      kind: "Visible copy rewrite",
      file: patch.filepath,
      before: patch.currentText,
      after: patch.replacementText,
      why:
        planItem?.reason ??
        "The agent changed existing text that people can see on the site, usually to make the message clearer and more useful for search visitors.",
      priority: planItem?.priority,
      expectedVisibleResult: planItem?.expectedVisibleResult,
      badgeClass: "bg-indigo-50 text-indigo-700",
    });
  }

  for (const patch of input.ctaRewrite ?? []) {
    const planItem = findPlanItem(input.plan, "ctaRewrite", patch.filepath, patch.targetId);
    items.push({
      id: `cta-${patch.filepath}-${patch.targetId}`,
      kind: "CTA text rewrite",
      file: patch.filepath,
      before: patch.currentText,
      after: patch.replacementText,
      why:
        planItem?.reason ??
        "The agent changed visible button or link text so the next action is clearer for visitors.",
      priority: planItem?.priority,
      expectedVisibleResult: planItem?.expectedVisibleResult,
      badgeClass: "bg-violet-50 text-violet-700",
    });
  }

  for (const patch of input.visualUpgrade ?? []) {
    const planItem = findPlanItem(
      input.plan,
      "visualUpgrade",
      patch.filepath,
      "visual-upgrade-section",
    );
    const metrics = patch.metrics
      .map((metric) => `${metric.value} — ${metric.label}`)
      .join("\n");
    const steps = patch.steps
      .map((step, index) => `${index + 1}. ${step.title}: ${step.body}`)
      .join("\n");
    items.push({
      id: `visual-${patch.filepath}-${patch.heading}`,
      kind: "Visual page upgrade",
      file: `${patch.filepath} + ${patch.stylesheetPath}`,
      before: "The page used the existing plain layout with no styled agent-generated conversion section.",
      after: [
        patch.eyebrow,
        patch.heading,
        patch.body,
        "",
        "Metrics:",
        metrics,
        "",
        "Workflow:",
        steps,
        "",
        `CTA: ${patch.ctaText} -> ${patch.ctaHref}`,
      ].join("\n"),
      why:
        planItem?.reason ??
        "The agent added a styled HTML section and matching CSS so the page improvement changes the actual presentation, not just the words.",
      priority: planItem?.priority,
      expectedVisibleResult: planItem?.expectedVisibleResult,
      badgeClass: "bg-fuchsia-50 text-fuchsia-700",
    });
  }

  for (const patch of input.productionUpgrade ?? []) {
    const planItem = findPlanItem(
      input.plan,
      "productionUpgrade",
      patch.filepath,
      "production-site-upgrade",
    );
    const repairs = (patch.linkRepairs ?? [])
      .map((repair) => `${repair.currentHref} -> ${repair.replacementHref}`)
      .join("\n");
    const highlights = patch.section.highlights
      .map((item) => `- ${item.title}: ${item.body}`)
      .join("\n");
    const comparison = (patch.section.comparisonRows ?? [])
      .map((row) => `${row.feature}: Starter ${row.starter} | Growth ${row.growth} | Scale ${row.scale}`)
      .join("\n");

    items.push({
      id: `production-${patch.filepath}-${patch.section.heading}`,
      kind: "Production site upgrade",
      file: `${patch.filepath} + ${patch.stylesheetPath}`,
      before: [
        "The agent found repo-level issues or weak page structure.",
        patch.fixDuplicateH1 ? "Duplicate H1 cleanup needed." : "",
        repairs ? `Broken link repairs:\n${repairs}` : "",
      ].filter(Boolean).join("\n\n"),
      after: [
        patch.section.eyebrow,
        patch.section.heading,
        patch.section.body,
        "",
        "Highlights:",
        highlights,
        comparison ? "\nComparison:" : "",
        comparison,
        "",
        `CTA: ${patch.section.ctaText} -> ${patch.section.ctaHref}`,
      ].filter(Boolean).join("\n"),
      why:
        planItem?.reason ??
        "The agent used repo analysis to make a stronger HTML/CSS change and repair page-level issues, not just add text.",
      priority: planItem?.priority,
      expectedVisibleResult: planItem?.expectedVisibleResult,
      badgeClass: "bg-rose-50 text-rose-700",
    });
  }

  for (const patch of input.interactiveConversionUpgrade ?? []) {
    const planItem = findPlanItem(
      input.plan,
      "interactiveConversionUpgrade",
      patch.filepath,
      "interactive-conversion-upgrade",
    );
    const labels = [
      `Visitors input: ${patch.section.inputLabels.visitors}`,
      `Conversion input: ${patch.section.inputLabels.conversionRate}`,
      `Value input: ${patch.section.inputLabels.averageValue}`,
      `Result: ${patch.section.resultLabel}`,
    ].join("\n");
    const recommendations = patch.section.recommendations
      .map((item) => `- ${item.title}: ${item.body}`)
      .join("\n");

    items.push({
      id: `interactive-${patch.filepath}-${patch.section.heading}`,
      kind: "Interactive conversion upgrade",
      file: `${patch.filepath} + ${patch.stylesheetPath}`,
      before: "The page did not have a working calculator or planner section for visitors.",
      after: [
        patch.section.eyebrow,
        patch.section.heading,
        patch.section.body,
        "",
        patch.section.calculatorTitle,
        labels,
        "",
        "Recommendations:",
        recommendations,
        "",
        `CTA: ${patch.section.ctaText} -> ${patch.section.ctaHref}`,
      ].join("\n"),
      why:
        planItem?.reason ??
        "The agent added safe HTML, CSS, and local JavaScript so the page has a useful interactive section, not just static copy.",
      priority: planItem?.priority,
      expectedVisibleResult: planItem?.expectedVisibleResult,
      badgeClass: "bg-cyan-50 text-cyan-700",
    });
  }

  for (const patch of input.visibleContent ?? []) {
    const planItem = findPlanItem(input.plan, "visibleContent", patch.filepath, "new-section");
    const bullets = (patch.bullets ?? []).map((b) => `- ${b}`).join("\n");
    items.push({
      id: `visible-${patch.filepath}-${patch.heading}`,
      kind: "New visible section",
      file: patch.filepath,
      before: "This section did not exist on the page before this PR.",
      after: [patch.heading, patch.body, bullets].filter(Boolean).join("\n\n"),
      why:
        planItem?.reason ??
        "The agent added a new section that visitors can read. This helps the page answer more buyer questions instead of only changing hidden SEO fields.",
      priority: planItem?.priority,
      expectedVisibleResult: planItem?.expectedVisibleResult,
      badgeClass: "bg-emerald-50 text-emerald-700",
    });
  }

  for (const patch of input.faqSection ?? []) {
    const planItem = findPlanItem(input.plan, "faqSection", patch.filepath, "faq-section");
    const faqs = patch.faqs
      .map((faq) => `Q: ${faq.question}\nA: ${faq.answer}`)
      .join("\n\n");
    items.push({
      id: `faq-${patch.filepath}-${patch.heading}`,
      kind: "FAQ section",
      file: patch.filepath,
      before: "This FAQ section did not exist on the page before this PR.",
      after: [patch.heading, faqs].filter(Boolean).join("\n\n"),
      why:
        planItem?.reason ??
        "The agent added practical questions and answers that visitors can read on the page.",
      priority: planItem?.priority,
      expectedVisibleResult: planItem?.expectedVisibleResult,
      badgeClass: "bg-teal-50 text-teal-700",
    });
  }

  for (const patch of input.pageMetadata ?? []) {
    const planItem = findPlanItem(input.plan, "pageMetadata", patch.filepath, "title-description");
    const fields = [
      patch.title ? `Title: ${patch.title}` : "",
      patch.description ? `Description: ${patch.description}` : "",
    ].filter(Boolean);

    items.push({
      id: `metadata-${patch.filepath}`,
      kind: "Page metadata",
      file: patch.filepath,
      before: "The page title or description was missing, weak, or too short.",
      after: fields.join("\n"),
      why:
        planItem?.reason ??
        "This usually changes what search engines and browser tabs read. It can improve SEO, but it may not be obvious on the page itself.",
      priority: planItem?.priority,
      expectedVisibleResult: planItem?.expectedVisibleResult,
      badgeClass: "bg-amber-50 text-amber-700",
    });
  }

  for (const patch of input.altText ?? []) {
    const planItem = findPlanItem(input.plan, "altText", patch.filepath, patch.imageSrc);
    items.push({
      id: `alt-${patch.filepath}-${patch.imageSrc}`,
      kind: "Image alt text",
      file: patch.filepath,
      before: `Image had missing or empty alt text:\n${patch.imageSrc}`,
      after: patch.altText,
      why:
        planItem?.reason ??
        "The agent added descriptive image text for accessibility and image SEO. This is important, but it is mostly hidden unless an image cannot load or a screen reader reads it.",
      priority: planItem?.priority,
      expectedVisibleResult: planItem?.expectedVisibleResult,
      badgeClass: "bg-sky-50 text-sky-700",
    });
  }

  return items;
}

function findPlanItem(
  plan: SeoFixPlan | undefined,
  kind: SeoFixPlanItem["kind"],
  filepath: string,
  target: string,
): SeoFixPlanItem | undefined {
  return plan?.items.find(
    (item) =>
      item.kind === kind &&
      item.filepath === filepath &&
    item.target === target,
  );
}

function verificationLabel(call: ToolCallRec): string {
  if (call.verified === true) return "verified";
  if (call.verified === false) return "verify failed";
  if (call.writeStatus === "pr_open") return "waiting for merge";
  if (call.writeStatus === "pr_merged") return "merged, checking";
  if (call.writeStatus === "pr_closed") return "PR closed";
  if (call.writeStatus === "pr_not_found") return "PR not found";
  if (call.writeStatus === "simulated") return "simulated";
  return "not verified";
}

function verificationBadgeClass(call: ToolCallRec): string {
  if (call.verified === true) return "bg-emerald-50 text-emerald-700";
  if (call.verified === false) return "bg-rose-50 text-rose-700";
  if (call.writeStatus === "pr_open") return "bg-amber-50 text-amber-700";
  if (call.writeStatus === "pr_merged") return "bg-indigo-50 text-indigo-700";
  if (call.writeStatus === "pr_closed") return "bg-slate-100 text-slate-600";
  if (call.writeStatus === "pr_not_found") return "bg-rose-50 text-rose-700";
  if (call.writeStatus === "simulated") return "bg-slate-100 text-slate-500";
  return "bg-slate-100 text-slate-500";
}

function impactLabel(call: ToolCallRec): string {
  const impact = call.outputJson?.verification?.impact;
  if (impact) return impact.label;
  return verificationLabel(call);
}

function impactBadgeClass(call: ToolCallRec): string {
  const impact = call.outputJson?.verification?.impact;
  if (!impact) return verificationBadgeClass(call);
  if (impact.verdict === "verified_improvement") return "bg-emerald-50 text-emerald-700";
  if (impact.verdict === "merged_no_improvement") return "bg-amber-50 text-amber-700";
  if (impact.verdict === "needs_review") return "bg-rose-50 text-rose-700";
  return "bg-slate-100 text-slate-600";
}

function SeoPlanSummary({
  plan,
  draftSource,
  fallbackReason,
}: {
  plan: SeoFixPlan;
  draftSource?: "gemini" | "fallback";
  fallbackReason?: string;
}) {
  return (
    <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-xs text-indigo-900">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
          Agent plan
        </span>
        <span className="font-semibold">{plan.primaryFocus}</span>
        <span className="text-indigo-600">
          Score {plan.healthScore}/100
        </span>
        {draftSource && (
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
            Draft: {draftSource === "gemini" ? "Gemini" : "fallback"}
          </span>
        )}
      </div>
      <p className="mt-2 leading-5 text-indigo-800">{plan.strategySummary}</p>
      {plan.repoAnalysis && (
        <p className="mt-2 leading-5 text-indigo-700">
          Repo: {plan.repoAnalysis.projectKind} · {plan.repoAnalysis.pages.length} page(s) ·{" "}
          {plan.repoAnalysis.issues.length} issue(s). {plan.repoAnalysis.recommendedFocus}
        </p>
      )}
      {draftSource === "fallback" && fallbackReason && (
        <p className="mt-2 leading-5 text-indigo-700">
          Fallback was used because: {fallbackReason}
        </p>
      )}
    </div>
  );
}

function SeoQualityGateSummary({
  qualityGate,
}: {
  qualityGate: SeoFixQualityGate;
}) {
  const failed = qualityGate.checks.filter((check) => check.status === "fail").length;
  const warned = qualityGate.checks.filter((check) => check.status === "warn").length;
  const passed = qualityGate.checks.filter((check) => check.status === "pass").length;
  const badgeClass =
    qualityGate.status === "passed"
      ? "bg-emerald-50 text-emerald-700"
      : "bg-rose-50 text-rose-700";

  return (
    <details className="rounded-xl border border-emerald-100 bg-emerald-50 p-4 text-xs text-emerald-900">
      <summary className="cursor-pointer select-none">
        <span className={`mr-2 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${badgeClass}`}>
          Quality gate {qualityGate.status}
        </span>
        <span className="font-semibold">Score {qualityGate.score}/100</span>
        <span className="ml-2 text-emerald-700">
          {passed} passed · {warned} warning(s) · {failed} failed
        </span>
      </summary>
      <p className="mt-2 leading-5 text-emerald-800">{qualityGate.summary}</p>
      <div className="mt-3 grid gap-2 md:grid-cols-2">
        {qualityGate.checks.map((check) => (
          <div key={check.id} className="rounded-lg bg-white px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-semibold text-slate-800">{check.label}</span>
              <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${qualityCheckBadgeClass(check.status)}`}>
                {check.status}
              </span>
            </div>
            <p className="mt-1 leading-5 text-slate-600">{check.message}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function qualityCheckBadgeClass(status: SeoFixQualityGate["checks"][number]["status"]): string {
  if (status === "pass") return "bg-emerald-50 text-emerald-700";
  if (status === "warn") return "bg-amber-50 text-amber-700";
  return "bg-rose-50 text-rose-700";
}

function SeoImpactCard({
  impact,
  liveAudit,
}: {
  impact: SeoImpactSummary;
  liveAudit?: SeoVerificationDetails["liveAudit"];
}) {
  const borderClass =
    impact.verdict === "verified_improvement"
      ? "border-emerald-100 bg-emerald-50 text-emerald-900"
      : impact.verdict === "merged_no_improvement"
        ? "border-amber-100 bg-amber-50 text-amber-900"
        : impact.verdict === "needs_review"
          ? "border-rose-100 bg-rose-50 text-rose-900"
          : "border-slate-100 bg-slate-50 text-slate-700";

  return (
    <div className={`mt-3 rounded-xl border px-4 py-3 text-xs ${borderClass}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${impactBadgeClassFromVerdict(impact.verdict)}`}>
          {impact.label}
        </span>
        {impact.scoreDelta !== undefined && (
          <span className="font-semibold">
            Score {formatDelta(impact.scoreDelta)}
          </span>
        )}
        {impact.findingDelta !== undefined && (
          <span className="font-semibold">
            Issues {formatDelta(impact.findingDelta)}
          </span>
        )}
      </div>
      <p className="mt-2 leading-5">{impact.summary}</p>
      {liveAudit && (
        <div className="mt-2 grid gap-2 sm:grid-cols-3">
          <MiniMetric
            label="Before score"
            value={liveAudit.beforeScore === undefined ? "n/a" : `${liveAudit.beforeScore}/100`}
          />
          <MiniMetric
            label="After score"
            value={liveAudit.currentScore === undefined ? "n/a" : `${liveAudit.currentScore}/100`}
          />
          <MiniMetric
            label="Remaining issues"
            value={
              liveAudit.currentFindingCount === undefined
                ? "n/a"
                : `${liveAudit.currentFindingCount}`
            }
          />
        </div>
      )}
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/80 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wider opacity-70">
        {label}
      </div>
      <div className="mt-1 font-semibold">{value}</div>
    </div>
  );
}

function impactBadgeClassFromVerdict(verdict: SeoImpactSummary["verdict"]): string {
  if (verdict === "verified_improvement") return "bg-emerald-100 text-emerald-800";
  if (verdict === "merged_no_improvement") return "bg-amber-100 text-amber-800";
  if (verdict === "needs_review") return "bg-rose-100 text-rose-800";
  return "bg-slate-100 text-slate-700";
}

function formatDelta(value: number): string {
  if (value > 0) return `+${value}`;
  return `${value}`;
}

function ChangeReviewCard({ item }: { item: ChangeReviewItem }) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${item.badgeClass}`}
        >
          {item.kind}
        </span>
        <span className="truncate font-mono text-xs text-slate-500">
          {item.file}
        </span>
        {item.priority && (
          <span className="rounded-full bg-white px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {item.priority} priority
          </span>
        )}
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Before
          </div>
          <div className="mt-1 min-h-20 whitespace-pre-wrap rounded-lg border border-slate-200 bg-white p-3 text-xs leading-5 text-slate-600">
            {item.before || "No previous value saved for this change."}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            After
          </div>
          <div className="mt-1 min-h-20 whitespace-pre-wrap rounded-lg border border-emerald-100 bg-white p-3 text-xs leading-5 text-slate-800">
            {item.after || "No new value saved for this change."}
          </div>
        </div>
      </div>

      <div className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-slate-600">
        <span className="font-semibold text-slate-800">Why: </span>
        {item.why}
        {item.expectedVisibleResult && (
          <div className="mt-2">
            <span className="font-semibold text-slate-800">
              Expected result:{" "}
            </span>
            {item.expectedVisibleResult}
          </div>
        )}
      </div>
    </div>
  );
}

function SettingsView() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [toolCalls, setToolCalls] = useState<ToolCallRec[] | null>(null);
  const [firing, setFiring] = useState<string | null>(null);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  async function loadAll() {
    try {
      const [j, t] = await Promise.all([
        fetch(`${BACKEND_URL}/api/scheduler/jobs`).then((x) => x.json()),
        fetch(`${BACKEND_URL}/api/tool-calls`).then((x) => x.json()),
      ]);
      setJobs(j.jobs);
      setToolCalls(t.toolCalls);
    } catch {
      /* offline */
    }
  }

  useEffect(() => {
    // setState happens after await inside loadAll(), not synchronously here
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadAll();
    const id = setInterval(() => void loadAll(), 5000);
    return () => clearInterval(id);
  }, []);

  async function fireJob(jobId: string) {
    setFiring(jobId);
    setMsg(null);
    try {
      const r = await fetch(`${BACKEND_URL}/api/scheduler/run/${jobId}`, {
        method: "POST",
      });
      const data = (await r.json()) as SchedulerRunResponse;
      setMsg(
        r.ok
          ? data.message ??
            `Job ${jobId} started → taskId ${data.taskId?.slice(0, 8) ?? "unknown"}…`
          : `Failed: ${data.error}`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setFiring(null);
      void loadAll();
    }
  }

  async function rollback(callId: string) {
    setRollingBack(callId);
    try {
      const r = await fetch(
        `${BACKEND_URL}/api/tool-calls/${callId}/rollback`,
        { method: "POST" },
      );
      const data = await r.json();
      setMsg(r.ok ? `Rolled back: ${data.result}` : `Failed: ${data.error}`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setRollingBack(null);
      void loadAll();
    }
  }

  async function verify(callId: string) {
    setVerifying(callId);
    try {
      const r = await fetch(
        `${BACKEND_URL}/api/tool-calls/${callId}/verify`,
        { method: "POST" },
      );
      const data = await r.json();
      setMsg(
        r.ok && data.success
          ? `Verified: ${data.result}`
          : `Failed: ${data.error ?? data.result}`,
      );
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setVerifying(null);
      void loadAll();
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-slate-500">
          Manage scheduled jobs, review past tool calls, and roll back writes.
        </p>
      </div>

      {msg && (
        <div className="rounded-xl border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-700">
          {msg}
        </div>
      )}

      {/* Scheduler */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold">Scheduled Jobs</h2>
        <p className="mt-1 text-xs text-slate-500">
          Run on a cron schedule. Fire one manually below to bypass the wait.
        </p>
        {!jobs ? (
          <div className="mt-4 text-sm text-slate-500">Loading…</div>
        ) : jobs.length === 0 ? (
          <div className="mt-4 text-sm text-slate-500">
            No jobs registered.
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {jobs.map((j) => (
              <div
                key={j.id}
                className="flex items-center justify-between rounded-xl border border-slate-100 px-4 py-3"
              >
                <div>
                  <div className="text-sm font-semibold">{j.id}</div>
                  <div className="text-xs text-slate-500">{j.description}</div>
                  <div className="mt-1 font-mono text-[10px] text-slate-400">
                    cron: {j.cron}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => fireJob(j.id)}
                  disabled={firing === j.id}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
                >
                  {firing === j.id ? "Firing…" : "Run now"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tool calls */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-base font-semibold">Agent Change Review</h2>
        <p className="mt-1 text-xs text-slate-500">
          Every YELLOW write the agent has made. The verifier watches GitHub
          PRs and checks merged changes automatically. Open a review to see the
          before-and-after text, or click <strong>Verify</strong> to re-check now.
        </p>
        {!toolCalls ? (
          <div className="mt-4 text-sm text-slate-500">Loading…</div>
        ) : toolCalls.length === 0 ? (
          <div className="mt-4 text-sm text-slate-500">
            No agent change records yet.
          </div>
        ) : (
          <div className="mt-4 space-y-2">
            {toolCalls.map((c) => {
              const reviewItems = buildChangeReviewItems(c);
              const changeLabel =
                reviewItems.length === 1
                  ? "1 structured change"
                  : `${reviewItems.length} structured changes`;

              return (
                <div
                  key={c.id}
                  className="rounded-xl border border-slate-100 px-4 py-3"
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-700">
                          {c.tier}
                        </span>
                        <span className="font-mono text-slate-700">
                          {c.toolName}
                        </span>
                        <span
                          className={
                            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                            (c.status === "executed"
                              ? "bg-emerald-50 text-emerald-700"
                              : c.status === "rolled_back"
                                ? "bg-slate-100 text-slate-600"
                                : "bg-rose-50 text-rose-700")
                          }
                        >
                          {c.status}
                        </span>
                        {c.executedAt && (
                          <span className="text-slate-500">
                            {formatRelative(c.executedAt)}
                          </span>
                        )}
                        {reviewItems.length > 0 && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
                            {changeLabel}
                          </span>
                        )}
                        <span
                          className={
                            "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                            impactBadgeClass(c)
                          }
                        >
                          {impactLabel(c)}
                        </span>
                      </div>
                      {c.outputJson?.changeId && (
                        <a
                          href={c.outputJson.changeId}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-2 block truncate font-mono text-xs text-indigo-600 hover:text-indigo-700"
                        >
                          {c.outputJson.changeId}
                        </a>
                      )}
                      {c.verificationResult && (
                        <div className="mt-3 rounded-lg border border-slate-100 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-600">
                          <span className="font-semibold text-slate-800">
                            Verification:{" "}
                          </span>
                          {c.verificationResult}
                          {c.writeStatusCheckedAt && (
                            <span className="ml-2 text-slate-400">
                              Checked {formatRelative(c.writeStatusCheckedAt)}
                            </span>
                          )}
                        </div>
                      )}
                      {c.outputJson?.verification?.impact && (
                        <SeoImpactCard
                          impact={c.outputJson.verification.impact}
                          liveAudit={c.outputJson.verification.liveAudit}
                        />
                      )}
                    </div>
                    <div className="flex shrink-0 flex-wrap gap-2 md:ml-3">
                      <button
                        type="button"
                        onClick={() => verify(c.id)}
                        disabled={
                          c.status !== "executed" || verifying === c.id
                        }
                        className="rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-xs font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-40"
                      >
                        {verifying === c.id ? "…" : "Verify"}
                      </button>
                      <button
                        type="button"
                        onClick={() => rollback(c.id)}
                        disabled={
                          c.status !== "executed" || rollingBack === c.id
                        }
                        className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 disabled:opacity-40"
                      >
                        {rollingBack === c.id ? "…" : "Roll back"}
                      </button>
                    </div>
                  </div>

                  {reviewItems.length > 0 ? (
                    <details className="mt-4">
                      <summary className="cursor-pointer text-xs font-semibold text-indigo-600 hover:text-indigo-700">
                        Review before/after changes
                      </summary>
                      <div className="mt-3 space-y-3">
                        {c.inputJson?.plan && (
                          <SeoPlanSummary
                            plan={c.inputJson.plan}
                            draftSource={c.inputJson.draftSource}
                            fallbackReason={c.inputJson.fallbackReason}
                          />
                        )}
                        {c.outputJson?.verification?.impact && (
                          <SeoImpactCard
                            impact={c.outputJson.verification.impact}
                            liveAudit={c.outputJson.verification.liveAudit}
                          />
                        )}
                        {reviewItems.map((item) => (
                          <ChangeReviewCard key={item.id} item={item} />
                        ))}
                      </div>
                    </details>
                  ) : (
                    <div className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-500">
                      This older tool call does not include structured review
                      details.
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* =====================================================================
   CHAT WIDGET — floating button + chat panel, available on every screen
   ===================================================================== */

type ChatTurn = { role: "user" | "assistant"; text: string };

function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);

  async function send() {
    const msg = input.trim();
    if (!msg || busy) return;
    setBusy(true);
    setInput("");
    setTurns((t) => [...t, { role: "user", text: msg }]);
    try {
      const r = await fetch(`${BACKEND_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      const data = await r.json();
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          text: r.ok ? (data.reply ?? "(empty)") : `Error: ${data.error}`,
        },
      ]);
    } catch (e) {
      setTurns((t) => [
        ...t,
        {
          role: "assistant",
          text: `Error: ${e instanceof Error ? e.message : "unknown"}`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-linear-to-br from-indigo-600 to-violet-600 text-white shadow-lg transition hover:scale-105"
          aria-label="Open chat"
        >
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
        </button>
      )}

      {open && (
        <div className="fixed bottom-6 right-6 z-40 flex h-140 w-100 max-w-[calc(100vw-3rem)] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
          <div className="flex items-center justify-between border-b border-slate-100 bg-linear-to-br from-indigo-600 to-violet-600 px-4 py-3 text-white">
            <div>
              <div className="text-sm font-semibold">MarketPilot Assistant</div>
              <div className="text-[10px] opacity-80">
                Reads your workspace memory · Gemini 2.5 Flash
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-lg p-1 text-white/80 hover:bg-white/10 hover:text-white"
            >
              ✕
            </button>
          </div>

          <div className="flex-1 space-y-3 overflow-y-auto bg-slate-50 px-4 py-4 text-sm">
            {turns.length === 0 && (
              <div className="text-center text-xs text-slate-500">
                Ask anything about your workspace.<br />
                e.g. &quot;summarize my last audit&quot;, &quot;what should I work on next?&quot;
              </div>
            )}
            {turns.map((t, i) => (
              <div
                key={i}
                className={
                  t.role === "user" ? "flex justify-end" : "flex justify-start"
                }
              >
                <div
                  className={
                    "max-w-[85%] rounded-2xl px-3 py-2 " +
                    (t.role === "user"
                      ? "bg-indigo-600 text-white"
                      : "border border-slate-200 bg-white text-slate-800")
                  }
                >
                  {t.text}
                </div>
              </div>
            ))}
            {busy && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-slate-200 bg-white px-3 py-2 text-slate-500">
                  Thinking…
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2 border-t border-slate-100 p-3">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              placeholder="Ask the assistant…"
              className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
            />
            <button
              type="button"
              onClick={() => void send()}
              disabled={busy || !input.trim()}
              className="rounded-lg bg-indigo-600 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700 disabled:opacity-50"
            >
              {busy ? "…" : "Send"}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/* =====================================================================
   AUDITS VIEW  (Step 7) — replaces the SEO Reports placeholder
   ===================================================================== */

type Finding = {
  id: string;
  severity: "critical" | "warning" | "info";
  message: string;
  detail?: string;
};

type Audit = {
  id: string;
  workspaceId: string;
  type: "seo" | "analytics" | "cro" | "ads" | "churn";
  scopeJson: { url?: string; scopeLabel?: string | null };
  findingsJson: {
    score?: number;
    findings?: Finding[];
    page?: Record<string, unknown>;
  };
  triagedActionsJson: unknown;
  createdAt: string;
};

function AuditsView() {
  const [audits, setAudits] = useState<Audit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`${BACKEND_URL}/api/audits`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { audits: Audit[] };
        if (!cancelled) {
          setAudits(data.audits);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load audits");
        }
      }
    }

    void load();
    const t = setInterval(() => void load(), 8000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (error && !audits) {
    return (
      <div className="rounded-2xl border border-rose-200 bg-rose-50 p-6 text-sm text-rose-700">
        Couldn&apos;t load audits: {error}. Is the backend running on {BACKEND_URL}?
      </div>
    );
  }

  if (!audits) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
        Loading audits…
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">SEO Reports</h1>
          <p className="text-sm text-slate-500">
            Every audit the agent has saved. Click a card to see all findings.
          </p>
        </div>
        <div className="text-xs text-slate-500">
          <strong className="text-slate-900">{audits.length}</strong> audit
          {audits.length === 1 ? "" : "s"} on file
        </div>
      </div>

      {audits.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-12 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50 text-indigo-600">
            <IconChart />
          </div>
          <div className="text-sm font-semibold text-slate-700">
            No audits yet.
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Launch an SEO audit run from the dashboard, or trigger the weekly job
            manually.
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {audits.map((a) => (
            <AuditCard
              key={a.id}
              audit={a}
              expanded={expandedId === a.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === a.id ? null : a.id))
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AuditCard({
  audit,
  expanded,
  onToggle,
}: {
  audit: Audit;
  expanded: boolean;
  onToggle: () => void;
}) {
  const findings = audit.findingsJson.findings ?? [];
  const score = audit.findingsJson.score ?? null;
  const counts = findings.reduce(
    (acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1;
      return acc;
    },
    { critical: 0, warning: 0, info: 0 } as Record<Finding["severity"], number>,
  );

  const scoreColor =
    score === null
      ? "text-slate-500"
      : score >= 80
        ? "text-emerald-600"
        : score >= 60
          ? "text-amber-600"
          : "text-rose-600";

  const sevBadge: Record<Finding["severity"], string> = {
    critical: "bg-rose-50 text-rose-700",
    warning: "bg-amber-50 text-amber-700",
    info: "bg-slate-100 text-slate-600",
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-start justify-between gap-6 text-left"
      >
        <div className="flex-1">
          <div className="flex items-center gap-2 text-xs">
            <span className="rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
              {audit.type}
            </span>
            <span className="text-slate-500">
              {formatRelative(audit.createdAt)}
            </span>
          </div>
          <h3 className="mt-1.5 font-mono text-sm text-slate-900">
            {audit.scopeJson.url ?? "(no url)"}
          </h3>
          <div className="mt-2 flex gap-3 text-xs">
            <span
              className={
                "rounded-full px-2 py-0.5 font-semibold " + sevBadge.critical
              }
            >
              {counts.critical} critical
            </span>
            <span
              className={
                "rounded-full px-2 py-0.5 font-semibold " + sevBadge.warning
              }
            >
              {counts.warning} warning
            </span>
            <span
              className={
                "rounded-full px-2 py-0.5 font-semibold " + sevBadge.info
              }
            >
              {counts.info} info
            </span>
          </div>
        </div>

        <div className="flex flex-col items-end">
          <div className={"text-4xl font-bold " + scoreColor}>
            {score ?? "—"}
          </div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            score
          </div>
          <div className="mt-3 text-slate-400">{expanded ? "▴" : "▾"}</div>
        </div>
      </button>

      {expanded && findings.length > 0 && (
        <div className="mt-4 space-y-2 border-t border-slate-100 pt-4">
          {findings.map((f, i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-lg bg-slate-50 px-3 py-2 text-sm"
            >
              <span
                className={
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                  sevBadge[f.severity]
                }
              >
                {f.severity}
              </span>
              <div className="flex-1">
                <div className="font-medium text-slate-800">{f.message}</div>
                {f.detail && (
                  <div className="mt-0.5 font-mono text-xs text-slate-500">
                    {f.detail}
                  </div>
                )}
              </div>
              <span className="shrink-0 font-mono text-[10px] text-slate-400">
                {f.id}
              </span>
            </div>
          ))}
        </div>
      )}

      {expanded && findings.length === 0 && (
        <div className="mt-4 border-t border-slate-100 pt-4 text-sm text-slate-500">
          No findings recorded for this audit.
        </div>
      )}
    </div>
  );
}

/* =====================================================================
   NEW RUN MODAL — the campaign brief form
   ===================================================================== */

// Skill picker — fetched from /api/skills (the Skill Catalog). Fallback list
// matches the old curated 10 so the UI still renders if the backend is down.

type SkillCategoryGroup = {
  category: string;
  label: string;
  skills: SkillOption[];
};

const skillCategoryOrder = [
  "seo",
  "content",
  "cro",
  "paid",
  "email",
  "research",
  "strategy",
  "lifecycle",
];

const skillCategoryLabels: Record<string, string> = {
  seo: "SEO",
  content: "Content",
  cro: "CRO",
  paid: "Paid",
  email: "Email",
  research: "Research",
  strategy: "Strategy",
  lifecycle: "Lifecycle",
};

const fallbackSkillOptions: SkillOption[] = [
  { id: "seo-audit", displayName: "SEO Audit", tagline: "Crawl + audit a URL, save findings", category: "seo", maturity: "executable", briefFields: [] },
  { id: "ai-seo", displayName: "AI Search Optimization", tagline: "Optimize for LLM answer engines", category: "seo", maturity: "draft-only", briefFields: [] },
  { id: "copywriting", displayName: "Copywriting", tagline: "Draft ad copy, emails, social posts", category: "content", maturity: "draft-only", briefFields: [] },
  { id: "content-strategy", displayName: "Content Strategy", tagline: "Plan blog/content calendar", category: "content", maturity: "draft-only", briefFields: [] },
  { id: "competitor-profiling", displayName: "Competitor Research", tagline: "Profile rivals + gaps", category: "research", maturity: "draft-only", briefFields: [] },
  { id: "paid-ads", displayName: "Paid Ads", tagline: "Audit campaigns, propose changes", category: "paid", maturity: "draft-only", briefFields: [] },
  { id: "cold-email", displayName: "Cold Email", tagline: "Outbound sequences + scripts", category: "email", maturity: "draft-only", briefFields: [] },
  { id: "social-content", displayName: "Social Content", tagline: "Posts, threads, carousels", category: "content", maturity: "draft-only", briefFields: [] },
  { id: "marketing-ideas", displayName: "Marketing Brainstorm", tagline: "Channel + tactic ideas", category: "strategy", maturity: "draft-only", briefFields: [] },
  { id: "ad-creative", displayName: "Ad Creative", tagline: "Image + copy variants for ads", category: "paid", maturity: "draft-only", briefFields: [] },
];

const brandTones = ["Friendly", "Professional", "Bold", "Luxury", "Playful"] as const;
const mainChannels = [
  "Instagram",
  "LinkedIn",
  "YouTube",
  "Email",
  "Blog",
  "Website SEO",
] as const;
const budgets = ["Low", "Medium", "High"] as const;

const genericBriefFields: BriefField[] = [
  {
    key: "productName",
    label: "Product name",
    type: "text",
    required: true,
    placeholder: "Acme Analytics",
  },
  {
    key: "targetAudience",
    label: "Target audience",
    type: "text",
    required: false,
    placeholder: "B2B SaaS founders, 50-500 employees",
  },
  {
    key: "campaignGoal",
    label: "Goal",
    type: "textarea",
    required: true,
    placeholder:
      "Tell the agent what you want it to produce or investigate.",
  },
  {
    key: "brandTone",
    label: "Brand tone",
    type: "select",
    required: false,
    options: [...brandTones],
  },
  {
    key: "mainChannel",
    label: "Main channel",
    type: "select",
    required: false,
    options: [...mainChannels],
  },
  {
    key: "campaignBudget",
    label: "Budget level",
    type: "select",
    required: false,
    options: [...budgets],
  },
];

function labelForSkillCategory(category: string): string {
  return (
    skillCategoryLabels[category] ??
    category
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ")
  );
}

function groupSkillOptions(
  skills: SkillOption[],
  searchText: string,
): SkillCategoryGroup[] {
  const query = searchText.trim().toLowerCase();
  const filteredSkills = skills.filter((skill) => {
    if (query.length === 0) return true;
    const searchableText = `${skill.displayName} ${skill.tagline}`.toLowerCase();
    return searchableText.includes(query);
  });

  const categories = Array.from(
    new Set(filteredSkills.map((skill) => skill.category)),
  ).sort((a, b) => {
    const aIndex = skillCategoryOrder.indexOf(a);
    const bIndex = skillCategoryOrder.indexOf(b);
    if (aIndex === -1 && bIndex === -1) return a.localeCompare(b);
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  });

  return categories.map((category) => {
    const categorySkills = filteredSkills
      .filter((skill) => skill.category === category)
      .sort((a, b) => {
        const aReady = a.maturity === "executable" || a.maturity === "autonomous-safe";
        const bReady = b.maturity === "executable" || b.maturity === "autonomous-safe";
        if (aReady !== bReady) return aReady ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
      });

    return {
      category,
      label: labelForSkillCategory(category),
      skills: categorySkills,
    };
  });
}

function NewRunModal({
  onClose,
  onLaunched,
}: {
  onClose: () => void;
  onLaunched: (taskId: string) => void;
}) {
  const [skillId, setSkillId] = useState<string>("seo-audit");
  const [briefValues, setBriefValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [skillOptions, setSkillOptions] = useState<SkillOption[]>(fallbackSkillOptions);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [skillSearch, setSkillSearch] = useState("");
  const [collapsedCategories, setCollapsedCategories] = useState<Record<string, boolean>>({});

  // Fetch the full Skill Catalog from the backend. If the request fails,
  // the fallback list (the old curated 10) stays in place so the modal
  // still works offline.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const skills = await listSkills();
        if (cancelled) return;
        setSkillOptions(skills);
        setSkillsLoaded(true);
      } catch {
        // keep fallback list
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // ESC closes the modal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectedSkill =
    skillOptions.find((skill) => skill.id === skillId) ?? skillOptions[0];
  const activeBriefFields =
    selectedSkill?.briefFields && selectedSkill.briefFields.length > 0
      ? selectedSkill.briefFields
      : genericBriefFields;
  const missingRequiredField = activeBriefFields.some((field) => {
    if (!field.required) return false;
    return (briefValues[field.key] ?? "").trim().length === 0;
  });
  const canSubmit = !busy && skillId.length > 0 && !missingRequiredField;
  const skillGroups = groupSkillOptions(skillOptions, skillSearch);

  function toggleSkillCategory(category: string) {
    setCollapsedCategories((current) => ({
      ...current,
      [category]: !current[category],
    }));
  }

  function selectSkill(nextSkillId: string) {
    setSkillId(nextSkillId);
    setBriefValues({});
    setError(null);
  }

  function updateBriefValue(key: string, value: string) {
    setBriefValues((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const data = await startAgentRun({
        skillId,
        brief: briefValues,
      });
      onLaunched(data.taskId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between border-b border-slate-100 p-6">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">
              Launch a campaign
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              Pick a skill, tell the agent about your product, and it&apos;ll get to
              work. You&apos;ll find its proposed actions in the Approvals inbox in a
              few seconds.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="space-y-6 p-6">
          {/* Skill picker */}
          <div>
            <div className="flex items-center justify-between">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                Pick a skill
              </div>
              {!skillsLoaded && (
                <div className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Offline · using fallback list
                </div>
              )}
            </div>

            <div className="relative mt-3">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">
                <IconSearch />
              </span>
              <input
                value={skillSearch}
                onChange={(e) => setSkillSearch(e.target.value)}
                placeholder="Search skills by name or job..."
                className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-10 pr-3 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100"
              />
            </div>

            <div className="mt-3 max-h-80 space-y-3 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-3">
              {skillGroups.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-200 bg-white p-4 text-sm text-slate-500">
                  No skills match &quot;{skillSearch.trim()}&quot;. Try a broader search.
                </div>
              ) : (
                skillGroups.map((group) => {
                  const collapsed = collapsedCategories[group.category] ?? false;
                  const readyCount = group.skills.filter(
                    (skill) =>
                      skill.maturity === "executable" ||
                      skill.maturity === "autonomous-safe",
                  ).length;
                  const guidedCount = group.skills.filter(
                    (skill) => skill.maturity === "guided",
                  ).length;

                  return (
                    <section key={group.category} className="rounded-lg bg-white">
                      <button
                        type="button"
                        onClick={() => toggleSkillCategory(group.category)}
                        className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-50"
                      >
                        <div>
                          <div className="text-xs font-semibold uppercase tracking-wider text-slate-700">
                            {group.label} ({group.skills.length})
                          </div>
                          <div className="text-[11px] text-slate-500">
                            {readyCount > 0
                              ? `${readyCount} ready to run`
                              : guidedCount > 0
                                ? `${guidedCount} guided workflow`
                              : "Draft workflows"}
                          </div>
                        </div>
                        <span className="text-sm font-semibold text-slate-400">
                          {collapsed ? "+" : "-"}
                        </span>
                      </button>

                      {!collapsed && (
                        <div className="grid grid-cols-1 gap-2 border-t border-slate-100 p-2 sm:grid-cols-2">
                          {group.skills.map((s) => {
                            const active = s.id === skillId;
                            const ready =
                              s.maturity === "executable" ||
                              s.maturity === "autonomous-safe";
                            const guided = s.maturity === "guided";

                            return (
                              <button
                                key={s.id}
                                type="button"
                                onClick={() => selectSkill(s.id)}
                                className={
                                  "rounded-xl border p-3 text-left transition " +
                                  (active
                                    ? "border-indigo-300 bg-indigo-50 ring-2 ring-indigo-200"
                                    : "border-slate-200 bg-white hover:border-slate-300")
                                }
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <div className="text-sm font-semibold text-slate-900">
                                    {s.displayName}
                                  </div>
                                  {ready && (
                                    <span className="shrink-0 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-700">
                                      Ready
                                    </span>
                                  )}
                                  {guided && (
                                    <span className="shrink-0 rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-blue-700">
                                      Guided
                                    </span>
                                  )}
                                </div>
                                <div className="mt-1 text-xs text-slate-500">
                                  {s.tagline}
                                </div>
                                {!ready && !guided && (
                                  <div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
                                    <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
                                    Beta
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })
              )}
            </div>

            <div className="mt-2 text-xs text-slate-500">
              Showing {skillGroups.reduce((sum, group) => sum + group.skills.length, 0)} of{" "}
              {skillOptions.length} skills
            </div>
          </div>

          {/* Skill-specific brief */}
          <div>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Brief for {selectedSkill?.displayName ?? "selected skill"}
                </div>
                <p className="mt-1 text-sm text-slate-500">
                  These fields change by skill so the agent gets sharper context.
                </p>
              </div>
              {selectedSkill?.briefFields.length === 0 && (
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Generic fallback
                </span>
              )}
            </div>
            <div className="mt-3 grid grid-cols-1 gap-4 md:grid-cols-2">
              {activeBriefFields.map((field) => (
                <BriefFieldControl
                  key={field.key}
                  field={field}
                  value={briefValues[field.key] ?? ""}
                  onChange={(value) => updateBriefValue(field.key, value)}
                />
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {error}. Is the backend running on {BACKEND_URL}?
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-slate-100 p-6">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSubmit}
            onClick={submit}
            className="rounded-xl bg-indigo-600 px-5 py-2 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 disabled:opacity-50"
          >
            {busy ? "Launching…" : "Launch agents"}
          </button>
        </div>
      </div>
    </div>
  );
}

function BriefFieldControl({
  field,
  value,
  onChange,
}: {
  field: BriefField;
  value: string;
  onChange: (value: string) => void;
}) {
  const controlClass =
    "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100";

  return (
    <Field label={field.label} required={field.required}>
      {field.type === "textarea" ? (
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={3}
          placeholder={field.placeholder}
          className={`${controlClass} resize-none`}
        />
      ) : field.type === "select" ? (
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={controlClass}
        >
          <option value="">Choose...</option>
          {(field.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={field.type === "number" ? "number" : field.type === "url" ? "url" : "text"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={field.placeholder}
          className={controlClass}
        />
      )}
      {field.helpText && (
        <p className="mt-1 text-xs leading-5 text-slate-500">{field.helpText}</p>
      )}
    </Field>
  );
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
        {label} {required && <span className="text-rose-500">*</span>}
      </div>
      {children}
    </label>
  );
}

/* =====================================================================
   INLINE ICONS  (small SVGs — no extra dependency)
   ===================================================================== */

const sw = { strokeWidth: 1.6 };

function IconGrid() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}
function IconRocket() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M14 6c4 0 6 2 6 6-2 0-4 2-4 4l-4-4-4 4c0-2-2-4-4-4 0-4 2-6 6-6 1.6 0 2.4.5 3 1 .6-.5 1.4-1 3-1z" />
      <circle cx="13" cy="11" r="1.5" />
    </svg>
  );
}
function IconBot() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <rect x="4" y="8" width="16" height="11" rx="3" />
      <circle cx="9" cy="13" r="1" />
      <circle cx="15" cy="13" r="1" />
      <path d="M12 4v4M9 4h6" />
    </svg>
  );
}
function IconDoc() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M7 3h7l5 5v13H7z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h7M9 17h5" />
    </svg>
  );
}
function IconCheckList() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M4 6l2 2 4-4" />
      <path d="M4 14l2 2 4-4" />
      <path d="M13 7h7M13 15h7" />
    </svg>
  );
}
function IconChart() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M4 20h16" />
      <path d="M7 16V9M12 16V5M17 16v-7" />
    </svg>
  );
}
function IconBox() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M12 3l8 4v10l-8 4-8-4V7z" />
      <path d="M4 7l8 4 8-4M12 11v10" />
    </svg>
  );
}
function IconPlug() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M9 4v6M15 4v6" />
      <rect x="7" y="10" width="10" height="6" rx="2" />
      <path d="M12 16v4" />
    </svg>
  );
}
function IconGear() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
function IconBell() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M6 8a6 6 0 1 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9z" />
      <path d="M10 21a2 2 0 0 0 4 0" />
    </svg>
  );
}
function IconClock() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}
function IconSearch() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <circle cx="11" cy="11" r="7" />
      <path d="M21 21l-4.3-4.3" />
    </svg>
  );
}
function IconLinkOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M10 8H7a4 4 0 0 0 0 8h3M14 16h3a4 4 0 0 0 0-8h-3" />
      <path d="M3 3l18 18" />
    </svg>
  );
}
function IconImage() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="M21 16l-5-5-9 9" />
    </svg>
  );
}
function IconId() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <circle cx="9" cy="12" r="2.5" />
      <path d="M14 10h5M14 14h3" />
    </svg>
  );
}
function IconBook() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" />
      <path d="M4 17h15" />
    </svg>
  );
}
function IconLink() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M10 14a5 5 0 0 1 0-7l3-3a5 5 0 0 1 7 7l-1.5 1.5" />
      <path d="M14 10a5 5 0 0 1 0 7l-3 3a5 5 0 0 1-7-7l1.5-1.5" />
    </svg>
  );
}
function IconSparkle() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5L18 18M6 18l2.5-2.5M15.5 8.5L18 6" />
    </svg>
  );
}
function IconTarget() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.5" />
    </svg>
  );
}
function IconCamera() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M3 8h4l2-3h6l2 3h4v11H3z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}
function IconGlobe() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </svg>
  );
}
function IconBars() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <rect x="4" y="10" width="3" height="10" />
      <rect x="10" y="6" width="3" height="14" />
      <rect x="16" y="13" width="3" height="7" />
    </svg>
  );
}
function IconMeta() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <path d="M3 16c2-8 5-10 7-10s3 3 5 6 4 4 6 4" />
    </svg>
  );
}
function IconWP() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" {...sw}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M9 4l3 16M15 4l-3 16" />
    </svg>
  );
}
