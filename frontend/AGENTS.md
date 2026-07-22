<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Frontend — AGENTS.md

This file governs the **frontend only** (`frontend/`).
For backend rules see `backend/AGENTS.md`.
For project-wide rules (framework concepts, tier system, hard rules, build stages) see the root `AGENTS.md`. **Read the root file first** — the rules below assume it.

---

## 1. What this frontend is

The UI for **MarketPilot AI** — an autonomous marketing agent platform.
Treat it as a production SaaS app, not a prototype. Quality bar: Linear / Vercel / Stripe dashboards.

The frontend must support MarketPilot as a multi-skill agent platform, not as
an SEO-only tool. SEO Reports can remain a specific surface, but shared run,
approval, draft, agent, and connection UI should work for all marketing skills.

It renders six surfaces that the framework requires:
1. **Dashboard** — KPIs, live runs, proposed actions, recent drafts
2. **Workstreams** (currently labelled "Campaigns") — per-skill run detail with live trace
3. **Product Profile** — identity, narrative, brand DNA, KPIs, ecosystem, profile strength
4. **Approvals inbox** — Linear-style queue of RED-tier actions awaiting decision
5. **Audits** — historical audit reports with drill-down
6. **Chat** — free-form reactive prompt with streaming agent reasoning
7. **Connections** — real OAuth + connector health (today: stub on Product Profile)

| # | Screen | Sidebar label | Status |
|---|---|---|---|
| 1 | Dashboard | Dashboard | done (mock) |
| 2 | Workstreams | Campaigns | done (mock) |
| 3 | Product Profile | Product Profile | done (mock) |
| 4 | Approvals inbox | Proposed Actions | placeholder |
| 5 | Audits | SEO Reports | placeholder |
| 6 | Chat | Agents | placeholder |
| 7 | Connections | Integrations | placeholder |

## 2. Stack (frontend)

- Next.js (App Router) — read `node_modules/next/dist/docs/` before changing anything Next-specific
- React 18+ with TypeScript (strict)
- Tailwind CSS v4 (configured via `app/globals.css`)
- No UI library, no icon library — **inline SVGs only** (`components/icons.tsx` when extracted)

If a new dependency is needed, **ask first**. Defaults to no. See root AGENTS.md "Dependencies" for the short allow-list.

## 3. Current code shape

Today everything still lives in `app/page.tsx` (~6,100 lines, 9 view functions: Dashboard, RunDetail, ProductProfile, Approvals, Agents, Drafts, Connections, Settings, Audits). The split into `views/` + `components/` described below has **not happened yet** — every new screen has been added to `page.tsx` instead. **This is now actively painful to work in.** Extracting views per §4 is the highest-priority frontend cleanup; do it one view at a time when you touch a screen.

`app/globals.css` carries the theme tokens. The `prefers-color-scheme: dark` block is intentional — our root view wrapper sets explicit `bg-slate-50` to stay light regardless.

## 4. File structure (where new code goes)

```
frontend/app/
├── page.tsx                 # route entry — composes Sidebar + active view (keep < 150 lines)
├── globals.css              # tailwind + theme tokens (do not edit without asking)
├── layout.tsx               # next.js root layout (do not edit without asking)
├── views/                   # one file per top-level screen
│   ├── dashboard.tsx
│   ├── campaigns.tsx        # workstream / run detail
│   ├── product-profile.tsx
│   ├── approvals.tsx
│   ├── audits.tsx
│   ├── chat.tsx
│   └── connections.tsx
├── components/
│   ├── layout/              # Sidebar, TopBar
│   ├── ui/                  # Card, Badge, Input, Textarea, Select, ChipList, ProgressRing, StatCard, ...
│   └── icons.tsx            # all inline SVG icons in one file
└── lib/
    ├── api.ts               # fetch wrappers for backend endpoints — the ONLY place fetch() lives
    ├── types.ts             # shared TS types (mirror backend shapes)
    └── mock.ts              # mock fixtures for screens not yet wired
```

Rules:
- A view over **~250 lines** → split components into `components/`.
- A piece of UI used in **2+ views** → move to `components/ui/`.
- Never inline a `fetch()` in a view — go through `lib/api.ts`.
- Never duplicate a type — define once in `lib/types.ts`, mirroring the backend.
- `page.tsx` is glue only: read nav state, render `<Sidebar>` + `<TopBar>` + active view. No business logic.

When extracting from the current `page.tsx`, do it **one view at a time**, type-check after each, and don't refactor unrelated code in the same pass.

## 5. API contract with the backend

Backend runs at `http://localhost:4000` (override with `NEXT_PUBLIC_BACKEND_URL`).

**Current endpoints** (wire through `lib/api.ts`):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/agent/start` | Kick off a skill run. Body: `{ skillId, brief: Record<string, string>, campaignId? }` → `{ taskId, status }` |
| GET | `/api/agent/:taskId` | Poll a running task |
| POST | `/api/agent/:taskId/approve` | Approve/reject a proposed action. Body: `{ actionId, approved }` |

**Endpoints planned** (do NOT call yet — they may not exist; coordinate with backend before assuming):
`/api/profile`, `/api/connections`, `/api/audits`, `/api/approvals`, `/api/skill-runs`, `/api/events`, `/api/chat`.

When a screen is wired to a real endpoint, keep a `mock.ts` fallback so the UI still renders if the backend is down, and show a small **"Offline · using mock data"** pill in the top right. Be honest with the user about what's real.

Polling: while a task is `running`, poll `GET /api/agent/:taskId` every 1.5–3s. Stop on `completed` or `failed`. Don't poll forever — cap retries and surface errors.

## 6. Live, not static

The framework requires every screen to **feel alive**. The agent is actually working — show it.

- Running agent dot: `h-2 w-2 rounded-full bg-emerald-500 animate-pulse`
- Progress bars: soft gradient `from-indigo-500 to-violet-500`, animate width
- Timestamps: "12s ago", "just now", ticking
- Live activity ticker in sidebar footer (Step 6+)
- Trace console: monospace, color-coded by event kind (system / call / result / thought / error)

Avoid: bouncy springs, confetti, parallax, neon glows. Restrained motion only — think Stripe/Linear, never Stripe-Atlas-landing-page.

## 7. Design system (tokens already in use)

**Colors**
- Page bg: `bg-slate-50`; card bg: `bg-white`; dark panel: `bg-slate-900` (charts only)
- Primary: `indigo-600` / hover `indigo-700` / subtle `indigo-50`
- Accent gradient: `from-indigo-600 to-violet-600` (Launch buttons, Profile Strength card)
- Success: `emerald-500/600` · Warning: `amber-500/600` · Danger: `rose-500/600`
- Borders: `border-slate-200` (default) / `border-slate-100` (subtle)
- Text: `text-slate-900` (primary) / `text-slate-600` (body) / `text-slate-500` (muted) / `text-slate-400` (label)

**Shape & spacing**
- Card: `rounded-2xl border border-slate-200 bg-white p-5 shadow-sm`
- Button (primary): `rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-indigo-700`
- Button (secondary): `rounded-lg border border-slate-200 bg-white py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50`
- Pill / badge: `rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider`
- Section gap: `space-y-6` (between sections), `gap-4` (inside grids)

**Typography**
- Page title: `text-2xl font-semibold tracking-tight`
- Section title: `text-lg font-semibold`
- Card title: `text-base font-semibold`
- Body: `text-sm text-slate-600`
- Label: `text-[10px] font-semibold uppercase tracking-wider text-slate-500`
- Monospace (traces, API keys): use the `font-mono` Tailwind utility (Geist Mono via next/font once layout.tsx is updated)

**Avoid**: random color picks, dark mode toggles (not yet), heavy gradients outside the two accent uses above, custom font-sizes outside the scale above.

## 8. Coding rules

Use:
- React functional components only
- `useState` for local state; `useEffect` only with a real dependency array
- `array.map()` for repeated UI — never copy-paste rows
- Clear variable names (`liveRuns`, not `lr`)
- TypeScript strict — no `any` without a one-line comment explaining why
- `lib/api.ts` for every backend call

Do NOT:
- Install new packages without asking
- Reach for `useContext`, `useReducer`, Zustand, or Redux — local `useState` is enough until proven otherwise
- Use `style={{...}}` for anything Tailwind can express (only for dynamic width %, dynamic colors)
- Use `dangerouslySetInnerHTML`
- Edit `globals.css`, `next.config.ts`, `tsconfig.json`, `postcss.config.mjs`, `eslint.config.mjs` without asking
- Touch backend files from frontend tasks

## 9. Workflow

Before non-trivial changes:
1. **Inspect** the file(s) — actually read them; don't guess.
2. **Plan** in 3–5 bullets and share before editing.
3. **Edit** only what's needed. No drive-by refactors.

Small UI tweaks (copy, color, spacing): edit directly and say what changed.

When extracting code from `page.tsx` into the structure in §4: do **one view at a time**, type-check after each, commit between.

## 10. Testing

```bash
cd frontend
npm run dev
```

Click through every screen you touched, plus at least one you didn't. If you changed a `components/ui/` primitive, open **all** screens.

Always type-check before declaring done:

```bash
npx tsc --noEmit
```

If you cannot run the dev server in this environment, say so explicitly — never claim "looks good" without testing.

## 11. Response format

After editing, tell Devansh:
1. **What changed** — short bullets
2. **Which files** — markdown paths with line numbers when relevant
3. **How to test** — exact commands + what to click
4. **Framework rule(s) touched** — only if applicable (see root AGENTS.md §"Hard rules")
5. **Next step** — one sentence

Keep it short. No emojis unless he asks. The developer is a beginner — explanations should be plain English, not jargon.
