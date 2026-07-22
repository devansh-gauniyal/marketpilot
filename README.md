# MarketPilot AI

> An autonomous marketing agent platform — connect your product, click Launch, and specialist AI agents go off to audit, draft, and propose real actions you can approve with one click.

Built by **Devansh** as a working prototype of a tier-gated autonomous agent system. Not a chatbot wrapper. The agent calls real tools, fetches real URLs, writes real Pull Requests where configured, and parks anything risky behind a human-approval gate.

MarketPilot is **not an SEO-only product**. SEO is currently the most mature reference workflow because it was built first. The product target is a multi-skill autonomous marketing agent platform where all 41 downloaded marketing skills can become runnable specialist workflows.

---

## What you can do today

1. Fill in your product profile (name, industry, voice, site URL, KPIs).
2. Click **+ New Run** → pick a skill (SEO Audit, Copywriting, Content Strategy, Paid Ads, etc.) → describe the goal.
3. The agent runs in the background — crawls, audits, drafts, proposes.
4. SEO findings land in **SEO Reports**. Drafts and run history show in the wider dashboard.
5. Approve / reject each proposed action. YELLOW writes (PR-based) can be rolled back via the API.
6. A `weekly-seo-audit` cron is registered to fire every Monday 06:00 automatically.

Current limitation: SEO has the strongest end-to-end execution path. Most other skills can still run as research/draft workflows, but they need skill-specific briefs, structured outputs, and more tool coverage to feel like full specialist agents.

---

## Quick start

```powershell
# Terminal 1
cd backend
npm install
echo "GEMINI_API_KEY=your-key-here" > .env
npm run dev          # http://localhost:4000

# Terminal 2
cd frontend
npm install
npm run dev          # http://localhost:3000
```

Open http://localhost:3000.

Get a free Gemini API key at https://aistudio.google.com/app/apikey.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  FRONTEND  (Next.js + React + Tailwind, single page.tsx for now)    │
│                                                                     │
│  Dashboard · Campaigns · Product Profile · Approvals · SEO Reports  │
│           │                                                         │
│           │ fetch()                                                 │
└───────────┼─────────────────────────────────────────────────────────┘
            ▼
┌─────────────────────────────────────────────────────────────────────┐
│  BACKEND  (Node + Express + TypeScript)                             │
│                                                                     │
│  Routes:                                                            │
│    /api/agent/start          /api/profile                           │
│    /api/agent/:id            /api/audits                            │
│    /api/approvals            /api/tool-calls                        │
│    /api/scheduler            /api/events                            │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  AGENT LOOP   (lib/agent-loop.ts)                            │   │
│  │                                                              │   │
│  │   1. loadMemory   ← profile + recent audits + performance    │   │
│  │   2. Gemini       ← prompt + tool declarations               │   │
│  │   3. tier-gate    GREEN / YELLOW / RED                       │   │
│  │   4. tool         crawl_site, audit_seo, add_alt_text, ...   │   │
│  │   5. verify + rollback (write tools)                         │   │
│  │   6. log event                                               │   │
│  │   Loop until `finish` or 12 iterations.                      │   │
│  └──────────────────────────────────────────────────────────────┘   │
│        │                          │                                 │
│        ▼                          ▼                                 │
│  ┌───────────────┐         ┌───────────────────────┐                │
│  │ CONNECTORS    │         │  STORES (SQLite)      │                │
│  │ site:cheerio  │         │  workspaces           │                │
│  │ site:github   │         │  product-profile      │                │
│  │ (simulated)   │         │  connections          │                │
│  │ — capabilities│         │  skill-runs           │                │
│  │ — rollback    │         │  tool-calls           │                │
│  └───────────────┘         │  approvals            │                │
│        │                   │  audits               │                │
│        ▼                   │  performance          │                │
│   Live web                 │  events               │                │
│                            └───────────────────────┘                │
│                                                                     │
│  SCHEDULER (node-cron) ── weekly-seo-audit @ "0 6 * * 1"             │
└─────────────────────────────────────────────────────────────────────┘
            │                                              │
            ▼                                              ▼
       Google Gemini                          .agents/skills/<id>/SKILL.md
       (2.5 Flash)                            41 marketing skills (knowledge)
```

### The three big ideas

**1. Three-tier autonomy.** Every tool the agent can call is tagged GREEN, YELLOW, or RED:
- 🟢 **GREEN** — reads. Run silently. (`web_search`, `crawl_site`, `audit_seo`)
- 🟡 **YELLOW** — reversible writes. Run + log a notify event. (`write_draft`, `add_alt_text`)
- 🔴 **RED** — high-stakes. Create an approval; don't run until a human says yes.

A single function — the **tier gate** — is called before every tool dispatch. Unknown tools default to RED ("fail closed").

**2. Skills vs. Tools vs. Connectors.** Three layers, one responsibility each:
- A **skill** (`.agents/skills/<id>/SKILL.md`) is *knowledge* — how to think about a marketing problem.
- A **tool** (in `lib/agent-tools.ts`) is a *verb* — a typed function the agent can call.
- A **connector** (in `lib/connectors/`) is an *adapter* to one external service, declaring its capabilities.

Skills never make HTTP calls. Tools never read other skills. Connectors never make decisions.

**3. Memory as a first-class input.** Before every run the agent loads a memory bundle (product profile + recent audits + recent performance) and prepends it to the prompt — so it never starts from a cold context.

---

## Folder structure

```
marketing-agent-platform/
├── AGENTS.md                          # project-wide rules (read first)
├── NOTES.md                           # detailed study/interview notes
├── README.md                          # this file
├── DEMO.md                            # interview walkthrough script
├── marketing-agent-framework.md       # full architectural spec (canonical)
├── frontend/
│   ├── AGENTS.md
│   └── app/
│       ├── page.tsx                   # ~2400 lines — the single-page app
│       └── globals.css
├── backend/
│   ├── AGENTS.md
│   └── src/
│       ├── server.ts                  # Express boot
│       ├── routes/
│       │   ├── agent.ts               # /api/agent/*
│       │   ├── approvals.ts           # /api/approvals/*
│       │   ├── tool-calls.ts          # /api/tool-calls/*
│       │   └── profile.ts             # /api/profile
│       ├── lib/
│       │   ├── agent-loop.ts          # the agent loop
│       │   ├── agent-tools.ts         # tool registry (declarations + tier + dispatch)
│       │   ├── agent/
│       │   │   └── tier-gate.ts       # the gate function
│       │   ├── connectors/
│       │   │   ├── types.ts
│       │   │   ├── site/cheerio.ts
│       │   │   └── github/mdx.ts      # simulation mode
│       │   ├── tools/seo/
│       │   │   ├── audit-checks.ts
│       │   │   └── add-alt-text.ts
│       │   ├── memory/load.ts         # loads + renders memory bundle
│       │   └── store/                 # SQLite-backed stores
│       └── scheduler/
│           ├── index.ts               # node-cron registration
│           └── weekly-seo-audit.ts
└── .agents/skills/                    # 41 SKILL.md files (upstream knowledge)
```

---

## Tech stack

**Frontend**: Next.js (App Router) · React 18 · TypeScript (strict) · Tailwind CSS v4 · inline SVG icons (no icon library)

**Backend**: Node 20+ · Express 4 · TypeScript · Google Gemini · cheerio · node-cron · `better-sqlite3` behind store interfaces

**Skills**: 41 markdown files from the marketingskills repo, loaded at runtime.

No new dependencies are added without checking [AGENTS.md §9](AGENTS.md#9-dependency-policy) first.

---

## How to extend

### Add a new tool

1. Implement it in `backend/src/lib/tools/<category>/<name>.ts` — a pure function from input to output.
2. Add a declaration to `toolDeclarations` in [backend/src/lib/agent-tools.ts](backend/src/lib/agent-tools.ts) (this is what Gemini sees).
3. Add an entry to `toolMeta` with its tier (GREEN / YELLOW / RED).
4. Add a `case` to `executeTool`.
5. If it writes anything, implement `rollback()` and add a branch in `rollbackToolCall()`.
6. Add a sanity test in `backend/src/lib/tools/<category>/__tests__/`.

### Add a new screen

1. Build a `<NameView />` function component in [frontend/app/page.tsx](frontend/app/page.tsx).
2. Route to it from `Home()` based on the sidebar `nav` state.
3. Fetch data from `${BACKEND_URL}/api/...` using the existing pattern (see `AuditsView` or `ApprovalsView`).
4. When the view grows past ~250 lines, extract into `frontend/app/views/<name>.tsx` per the frontend AGENTS.md.

### Add a new scheduled job

1. New file in `backend/src/scheduler/<job-name>.ts` exporting a `runX()` handler.
2. Register it in `backend/src/scheduler/index.ts` with a cron expression.
3. Restart the backend — `[scheduler] registered "<job>" — cron: <expr>` appears in the logs.

---

## Hard rules (excerpt from [AGENTS.md](AGENTS.md))

1. Every tool declares a tier or is RED by default.
2. Tier checks happen at the gate, not in the tool body.
3. Every write tool returns a `rollbackPayload`. No rollback → RED.
4. Connectors declare capabilities; tools check before writing.
5. Skills are knowledge; tools are verbs; connectors are adapters. Don't mix.
6. Budget guards are hard caps — even approval can't override.
7. PR-based writes preferred (free audit trail + rollback).
8. All LLM calls logged to the event log.
9. Approvals expire (TODO — currently never).
10. The agent never modifies the product profile. User-only.

Full list in [AGENTS.md §5](AGENTS.md#5-hard-rules-non-negotiable).

---

## Status

| Step | What | Status |
|---|---|---|
| 1 | Storage split (9 typed stores) | ✅ |
| 2 | Tier system + gate | ✅ |
| 3 | First connector (cheerio) + `audit_seo` | ✅ |
| 4 | Approvals inbox UI + campaign-brief modal | ✅ |
| 5 | First YELLOW write tool (`add_alt_text` — real PR when `GITHUB_TOKEN` set, simulation otherwise) | ✅ |
| 6 | Scheduler + memory wiring | ✅ |
| 7 | Wider tool coverage + missing UI screens | ✅ |

**The build plan is done.** Every nav item in the sidebar is now a real screen wired to the backend. A floating Chat widget gives reactive Gemini Q&A on every screen.

**What's NOT done yet** (deliberately deferred):
- Auth + multi-tenant (single workspace, no login)
- Full skill-specific workflows for all 41 downloaded skills
- Structured outputs for every skill category
- OAuth flows for GA4 / GSC / Meta Ads / WordPress
- Durable scheduling (node-cron only runs while the server is up)
- `page.tsx` is one large file — the frontend AGENTS.md says split when it grows, that's a future refactor

The next product phase is not "more SEO." It is making the downloaded skills first-class agent workflows with the right inputs, outputs, allowed tools, connector requirements, and approval behavior.

See [NOTES.md §15](NOTES.md) for the honest "what's NOT built yet" list.

---

## Documents

- [NOTES.md](NOTES.md) — detailed study/interview notes (glossary, FAQ, the whole thing)
- [DEMO.md](DEMO.md) — interview walkthrough script
- [AGENTS.md](AGENTS.md) — project-wide rules
- [marketing-agent-framework.md](marketing-agent-framework.md) — canonical product and architecture blueprint
- [frontend/AGENTS.md](frontend/AGENTS.md), [backend/AGENTS.md](backend/AGENTS.md) — folder-scoped rules

---

## License

Private. Built by Devansh, 2026.
