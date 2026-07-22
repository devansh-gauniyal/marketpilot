# Backend — AGENTS.md

This file governs the **backend only** (`backend/`).
For frontend rules see `frontend/AGENTS.md`.
For project-wide rules (framework concepts, tier system, hard rules, build stages, dependency policy) see the root `AGENTS.md`. **Read the root file first** — every rule below assumes it.

The full architectural spec lives in `marketing-agent-framework.md` at the repo root. When a rule here is ambiguous, the framework spec wins.

---

## 1. What this backend is

The Node/TypeScript service that runs MarketPilot AI's autonomous agent.

It does five things and nothing else:
1. **Loads memory** for a workspace (product profile, recent audits, recent performance) before every run.
2. **Plans** with an LLM (Gemini 2.5 Pro) — produces a structured plan of tool calls + reasoning.
3. **Executes** tool calls through a **tier gate** (GREEN auto-runs, YELLOW auto-runs + notifies + can revert, RED waits for human approval). Uses Gemini 2.5 Flash for in-loop calls.
4. **Verifies** every write by re-fetching state through the connector layer; rolls back on mismatch.
5. **Logs** every meaningful event to an append-only event log.

Skills live in `.agents/skills/<skill-id>/SKILL.md` at the repo root and are loaded at runtime. Skills are **knowledge** (how to think); tools are **verbs** (what the agent can do). Skills never make HTTP calls — only registered tools do.

This backend is not for SEO alone. The SEO agent path is the most mature
reference workflow, but the backend architecture must support all downloaded
marketing skills as runnable agent workflows over time.

## 2. Stack (backend)

- **Runtime**: Node.js 20+ / TypeScript 5+ (strict mode)
- **HTTP**: Express 4
- **LLM**: Google Gemini — `2.5-flash` for the execute loop, `2.5-pro` for the plan step
- **Storage**: `better-sqlite3` today, behind a store interface so we can swap to Postgres without changing callers
- **Scheduling**: not yet — `node-cron` at Step 6
- **Validation**: `zod` for every tool input (validated at the gate, not in the tool body)
- **Auth**: local dev user + workspace context (`x-user-id`, `x-workspace-id`); Clerk/Supabase-style auth still pending

**Why this differs from `marketing-agent-framework.md`**: see the deviations table in the root AGENTS.md. Anthropic SDK → Gemini, Drizzle/Postgres → local SQLite, Inngest → node-cron. Code to the **interface**, not the implementation, so swapping later is a small change.

## 3. Current code shape (honest)

The backend has moved beyond the early thin prototype. It now has SQLite-backed
stores, workspace context, a tier gate, approvals, audits, connections, GitHub
OAuth, scheduler jobs, and a mature SEO-to-PR reference workflow.

```
backend/src/
├── server.ts                # Express bootstrap — CORS, /health, mounts API routers
├── routes/
│   ├── agent.ts             # start / get / approve endpoints
│   ├── approvals.ts         # first-class approval inbox
│   ├── connections.ts       # site/GitHub/OAuth connection management
│   ├── database.ts          # local DB health
│   ├── drafts.ts            # draft feed
│   ├── profile.ts           # product profile
│   ├── tool-calls.ts        # write review / rollback / verification
│   └── workspaces.ts        # local workspace context
└── lib/
    ├── agent-loop.ts        # generic skill loop
    ├── agent-tools.ts       # current tool declarations + dispatch
    ├── agent/
    │   ├── seo-orchestrator.ts
    │   ├── competitor-orchestrator.ts
    │   └── tier-gate.ts
    ├── connectors/
    ├── memory/
    ├── skills/
    ├── store/
    └── tools/
```

Known gaps vs. the framework:
- Most downloaded skills still run through the generic research/draft loop.
- Two skills are on deterministic orchestrators today: `seo-audit` (live audit → repo scan → Gemini copy draft → single PR) and `competitor-profiling` (per-competitor crawl → typed Gemini synthesis → markdown draft built from JSON, with retry + fallback). The remaining ~38 skills are next; `page-cro` is the planned third.
- Tool coverage is still narrow outside SEO/content drafting.
- Budget guards are not yet fully implemented across spend/send/publish tools.
- Approval expiry still needs durable enforcement.
- The route layer still contains some convenience endpoints that should move to
  dedicated routers as the API hardens.

## 4. Target file structure

Build into this layout one folder at a time (see root AGENTS.md "Build stages"). **Do not** rename existing files until their replacements exist and are wired in.

```
backend/src/
├── server.ts                # Express bootstrap (keep thin)
├── routes/                  # one file per resource, each ~30–80 lines
│   ├── agent.ts             # /api/agent/*    (skill runs)
│   ├── profile.ts           # /api/profile
│   ├── connections.ts       # /api/connections
│   ├── approvals.ts         # /api/approvals
│   ├── audits.ts            # /api/audits
│   └── events.ts            # /api/events     (event log read)
├── lib/
│   ├── agent/               # the loop, split by responsibility
│   │   ├── core.ts          # orchestrator: load memory → plan → execute → verify → log
│   │   ├── planner.ts       # Gemini 2.5 Pro plan-step prompt + structured plan parse
│   │   ├── executor.ts      # tool dispatch + tier gate integration
│   │   ├── verifier.ts      # re-fetch state and compare
│   │   ├── tier-gate.ts     # GREEN auto / YELLOW notify+log / RED → create approval
│   │   └── budget-guards.ts # hard caps: ad spend, email recipients, pages-modified/day
│   ├── tools/               # tool registry — one file per category
│   │   ├── registry.ts      # central register() + getTool() + listForSkill()
│   │   ├── seo/             # crawl_site, audit_seo, add_schema_markup, ...
│   │   ├── content/         # draft_copy, update_page_copy, publish_blog_post, ...
│   │   ├── ads/             # audit_campaigns, pause_ad_set, adjust_budget, launch_campaign
│   │   ├── email/           # send_test_email, send_full_email, ...
│   │   └── analytics/       # fetch_ga4_data, audit_tracking, ...
│   ├── connectors/          # external service adapters — declare capabilities
│   │   ├── types.ts         # SiteConnector, AdsConnector, EmailConnector, ...
│   │   ├── site/            # cheerio.ts (read-only), wordpress.ts, github-mdx.ts, ...
│   │   ├── google/          # ga4.ts, gsc.ts
│   │   ├── ads/             # google-ads.ts, meta-ads.ts
│   │   └── email/           # resend.ts, loops.ts
│   ├── skills/              # skill loading + tool-allowlist manifest
│   │   ├── loader.ts        # reads .agents/skills/<id>/SKILL.md
│   │   └── manifest.ts      # skillId → string[]  (allowed tool names)
│   ├── memory/              # what the agent loads before each run
│   │   ├── product-profile.ts
│   │   ├── operational.ts   # recent audits + open issues
│   │   └── performance.ts   # rolling KPIs
│   └── store/               # SQLite-backed stores behind a stable interface
│       ├── workspaces.ts
│       ├── product-profile.ts
│       ├── connections.ts
│       ├── skill-runs.ts    # (was the old agent-store)
│       ├── tool-calls.ts    # per-call records with rollback_payload
│       ├── approvals.ts     # first-class, can outlive a skill run
│       ├── audits.ts
│       ├── performance.ts   # daily snapshots
│       └── events.ts        # append-only event log
└── scheduler/               # cron handlers (Step 6+)
    ├── index.ts             # node-cron registry
    ├── weekly-seo-audit.ts
    ├── daily-rank-check.ts
    └── daily-anomaly-detector.ts
```

Rules:
- **Routes stay thin.** Business logic lives in `lib/`. A route handler should be: parse body (zod), call a `lib/` function, return result.
- **No `fetch()` outside `lib/connectors/`.** Tools call connectors; connectors call the outside world.
- **One file per tool when a tool grows past ~80 lines.** Otherwise group related tools in one file (`seo/meta.ts`, `seo/schema.ts`, etc.).
- **Stores are append-mostly.** Treat them like a database — no in-place mutation of records returned to callers.

## 5. Core contracts (interfaces)

These are the four shapes that hold the system together. Define them once and import everywhere.

### Tool

```ts
// lib/tools/registry.ts
export type Tier = "GREEN" | "YELLOW" | "RED";

export interface Tool<I, O> {
  name: string;
  description: string;                                   // shown to the LLM
  tier: Tier | ((input: I) => Tier);                     // dynamic when input matters
  inputSchema: z.ZodSchema<I>;
  execute: (input: I, ctx: AgentContext) => Promise<O>;
  verify?: (input: I, output: O, ctx: AgentContext) => Promise<boolean>;
  rollback?: (rollbackPayload: unknown, ctx: AgentContext) => Promise<void>;
  budgetImpact?: (input: I) => { type: "spend" | "send" | "publish"; amount: number };
}
```

If a write tool can't implement `rollback`, its tier is **RED**. No exceptions.

### Connector

```ts
// lib/connectors/types.ts
export interface Connector {
  type: string;                                          // "site:cheerio", "ga4", "github-mdx", ...
  capabilities: Record<string, boolean>;                 // what this connector supports
}

export interface WriteResult {
  success: boolean;
  changeId: string;                                      // PR URL, CMS revision id, etc.
  rollbackPayload: unknown;
  previewUrl?: string;
}
```

Tools call `connector.capabilities.canWriteMeta` before attempting a write. If unsupported, the tool returns a structured error — never throws.

### Store

```ts
// lib/store/<resource>.ts
export const skillRuns = {
  create(input): SkillRun,
  get(id): SkillRun | undefined,
  update(id, partial): void,
  list(filter): SkillRun[],
};
```

Every store exports a plain object with named methods. Internals stay private. When we swap to Postgres, only these files change.

### Agent context

```ts
// lib/agent/core.ts
export interface AgentContext {
  workspaceId: string;
  skillRunId: string;
  skill: string;                                         // "seo-audit", "copywriting", ...
  profile: ProductProfile;
  connections: Connection[];
  budgetGuards: BudgetGuards;
  logEvent: (type: string, payload: unknown) => void;
}
```

Passed to every tool. Tools never read globals.

## 6. API endpoints

**Current** (`routes/agent.ts`):

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/api/agent/start` | `{ skillId, brief: Record<string, string>, campaignId? }` (legacy generic campaign fields still accepted) | `{ taskId, status }` |
| GET | `/api/agent/:taskId` | — | `AgentTask` |
| POST | `/api/agent/:taskId/approve` | `{ actionId, approved }` | `{ action }` |

**Planned** (add as the corresponding store/screen lands):

| Path | Notes |
|---|---|
| `GET/PUT /api/profile` | product profile read/write — agent never writes it |
| `GET/POST /api/connections` | list + start OAuth/config flow |
| `GET /api/connections/github/oauth/settings` | GitHub OAuth setup/connection status for Integrations UI |
| `GET /api/connections/github/oauth/start` | Redirects the workspace user to GitHub OAuth |
| `GET /api/connections/github/oauth/callback` | GitHub OAuth callback; stores encrypted token |
| `GET /api/connections/github/repos` | Lists repos available to the connected GitHub account |
| `POST /api/connections/github/health-check` | Verifies account, repo, branch, and write permission |
| `POST /api/connections/github/disconnect` | Removes stored GitHub OAuth token for the workspace |
| `GET /api/approvals` | inbox feed; supports `?status=pending` |
| `POST /api/approvals/:id/decide` | first-class approval decision; resumes the skill run |
| `GET /api/audits` + `GET /api/audits/:id` | history + drill-down |
| `GET /api/skill-runs` + `GET /api/skill-runs/:id` | workstream view feed |
| `GET /api/events?since=...` | event log tail for the activity feed |
| `POST /api/chat` | reactive chat surface (streamed) |

Coordinate with frontend (`frontend/AGENTS.md` §5) before changing any endpoint shape.

## 7. The agent loop (target shape)

```
runAgent(task, ctx):
  1. loadMemory(ctx)              // profile + recent audits + recent performance
  2. loadSkill(task.skill)        // SKILL.md content + allowed tool names
  3. plan = await planner(memory, skill, task.instruction)   // Gemini 2.5 Pro
  4. for each toolCall in plan:
       tier   = tierGate(tool, toolCall.input, ctx)
       budget = budgetGuards.check(tool, toolCall.input, ctx)
       if tier === "RED" or budget.exceeded:
            approvals.create(skillRunId, toolCall, plan.reasoning)
            continue                                  // resume later via approval webhook
       output = await tool.execute(toolCall.input, ctx)
       ok     = await tool.verify?.(toolCall.input, output, ctx) ?? true
       if !ok:
            await tool.rollback?.(output.rollbackPayload, ctx)
            events.append("verify_failed", { toolCall, output })
            continue
       events.append("tool_call", { ... })
       if tier === "YELLOW":
            notify(workspaceId, toolCall, output)
  5. finalize(skillRunId)
```

Resume after approval: when `POST /api/approvals/:id/decide` flips an approval to approved, fire an event that the agent core picks up and continues the skill run from the gated tool call.

## 8. LLM usage

- **Plan step**: `gemini-2.5-pro` — single call, structured output (JSON schema for the plan).
- **Execute loop**: `gemini-2.5-flash` — function-calling style, max 12 iterations per run (configurable per skill).
- **Temperature**: 0.4 for execute, 0.3 for plan. Don't dial up.
- **Every call** is logged to the event log with: model id, token counts (when available), latency, skillRunId, purpose (`plan` | `execute` | `chat`).
- **Never** call an LLM outside `lib/agent/` or `lib/skills/` — no scattered Gemini calls in routes or tools.
- Prompts live next to the code that uses them, not in JSON config files.

## 9. Skills & manifests

- Skills are read from `<repo-root>/.agents/skills/<skill-id>/SKILL.md` at runtime by `lib/skills/loader.ts`.
- Each skill must have an entry in `lib/skills/manifest.ts` mapping `skillId → string[]` of allowed tool names.
- The agent loop passes **only the allowed tools** to Gemini. A skill cannot use a tool it didn't declare.
- Skill `SKILL.md` files are upstream content. **Never edit them from backend tasks.** If a skill is wrong or missing, raise it — don't patch it locally.

## 10. Logging conventions

- **One event log**, append-only, in `lib/store/events.ts`.
- Every tool call, plan, approval, verification, rollback, and LLM call writes one event.
- Events are typed: `{ id, workspaceId, type, payload, createdAt }`. `type` is a stable string (`tool_call`, `verify_failed`, `approval_created`, `llm_call`, ...).
- Routes never `console.log` business data — they emit events. `console.log` is for boot + crashes only.
- For local debugging, a `LOG_LEVEL=debug` env var can enable verbose `console.debug` inside `lib/agent/`.

## 11. Coding rules

Use:
- TypeScript strict mode. No `any` without a one-line comment justifying it.
- `zod` schemas for every tool input + every route body.
- Async/await — never raw Promise chains in business logic.
- Named exports. No default exports except where Next.js requires them (it doesn't, on the backend).
- Pure functions in `lib/` where possible. Side effects belong in `connectors/`, `store/`, or `scheduler/`.
- File scope: one responsibility per file. If a file grows past ~250 lines, split it.

Do NOT:
- `fetch()` outside `connectors/`
- Call Gemini outside `lib/agent/`
- Mutate store records in place — `update()` returns the new record
- Throw raw errors at HTTP boundaries — return `{ ok: false, error }` from tools; routes turn them into 4xx/5xx
- Add a new dependency without checking the allow-list in root AGENTS.md
- Touch `package.json`, `tsconfig.json`, or `.env*` without asking

## 12. Workflow

Before non-trivial changes:
1. **Inspect** — read the file(s), the relevant store, and any tool/connector the change touches.
2. **Plan** — 3–5 bullets describing what changes and why, and which framework rule (root AGENTS.md §"Hard rules") it implements or affects.
3. **Edit** — only the files in scope. No drive-by refactors.

When adding a new tool:
1. Add the tool file under `lib/tools/<category>/`.
2. Register it in `lib/tools/registry.ts`.
3. Add it to the relevant skill manifest in `lib/skills/manifest.ts`.
4. If it writes anything, implement `verify` **and** `rollback`. If you can't, set `tier: "RED"`.
5. Add a sanity test in `lib/tools/__tests__/` (see §13).

When adding a new connector:
1. Define capabilities in `lib/connectors/types.ts` if new.
2. Implement under `lib/connectors/<category>/`.
3. Add a health check that the connector store can call before write attempts.

## 13. Testing

Local dev:
```bash
cd backend
npm run dev          # tsx watch on src/server.ts
```

Health:
```bash
curl http://localhost:4000/health
```

Type-check:
```bash
npx tsc --noEmit
```

Tool sanity tests (no framework needed yet):
- Put a `<tool-name>.test.ts` next to the tool in `lib/tools/__tests__/`.
- Each file is a plain async function that calls the tool with sample input and asserts the output shape (`if (!result.ok) throw …`).
- Add a `npm run test:tools` script that runs them with `tsx`.
- Tests must not hit real external services. Mock connectors at the seam.

If you cannot run the server in this environment, say so explicitly — never claim "works" without testing.

## 14. Response format

After every change, tell Devansh:
1. **What changed** — short bullets
2. **Which files** — markdown paths with line numbers when relevant
3. **How to test** — exact commands + what to look for in the output
4. **Framework rule(s) implemented or touched** — cite the rule from root AGENTS.md §"Hard rules"
5. **Next step** — one sentence

Keep it short. No emojis unless he asks. Explanations should be plain English — the developer is a beginner.
