# AGENTS.md — Project root

This file governs the **whole project**. Every agent (human or AI) working anywhere in this repo must read it first.

Sub-folder rules live in:
- `frontend/AGENTS.md` — UI screens, design tokens, frontend coding rules, API contract from the consumer side
- `backend/AGENTS.md` — agent loop, tools, connectors, stores, scheduler, API contract from the producer side

The full architectural spec is `marketing-agent-framework.md` at this same level. **When this file is ambiguous, the framework doc wins.**

---

## 1. What this is

**MarketPilot AI** — an autonomous marketing agent platform.

A Node/TypeScript backend runs an LLM agent that loads memory (product profile + history + performance), plans, then executes tools through a **tier gate** (GREEN auto-runs, YELLOW auto-runs + notifies + can revert, RED waits for human approval). Tools call **connectors** that declare their capabilities and return rollback payloads. A **scheduler** fires weekly/daily skill runs. A Next.js frontend renders the dashboard, approvals inbox, audits, workstreams, and a chat surface.

This is not an SEO-only app. SEO is the first deeply implemented workflow because it was built first. The product target is a general autonomous marketing agent where **all 41 downloaded skills** can become runnable specialist workflows. Shared infrastructure must stay skill-agnostic.

Treat this as a production SaaS app, not a prototype. Quality bar: Linear / Vercel / Stripe.

## 2. Repo map

```
marketing-agent-platform/
├── AGENTS.md                          # this file — project-wide rules
├── marketing-agent-framework.md       # full architectural spec (canonical)
├── frontend/                          # Next.js app (UI only)
│   └── AGENTS.md
├── backend/                           # Node/Express agent service
│   └── AGENTS.md
└── .agents/skills/<skill-id>/SKILL.md # 41 marketing skills (upstream — do not edit)
```

`marketingskills` is the source of truth for **how to do marketing tasks**. This codebase is the source of truth for **how the agent operates**.

Every skill under `.agents/skills/` is intended to become usable in the web app over time. A skill may start as draft-only, then mature into guided, executable, and eventually autonomous-safe behavior as its briefs, outputs, tools, connectors, and approvals are added.

## 3. Stack snapshot

- **Backend**: Node.js 20+ · TypeScript 5 (strict) · Express 4 · Google Gemini (2.5 Pro for planning, 2.5 Flash for execute) · zod · SQLite-backed stores
- **Frontend**: Next.js App Router · React 18 · TypeScript · Tailwind CSS v4 · inline SVG icons
- **Skills**: 41 markdown skills under `.agents/skills/`
- **Storage**: `better-sqlite3` behind a stable store interface (will graduate to Postgres when multi-tenant scale requires it)
- **Scheduling**: not yet — `node-cron` lands at Step 6
- **Auth**: local dev user + workspace context (`x-user-id`, `x-workspace-id`); real external auth still pending

## 4. Stack deviations from `marketing-agent-framework.md` (intentional)

| Framework says | We use | Why |
|---|---|---|
| Anthropic Claude | Google Gemini | Already wired and working |
| Postgres + Drizzle | `better-sqlite3` locally → later Postgres | Durable memory with low ops while solo |
| Inngest | `node-cron` inside Express | Single process, no FaaS yet |
| Clerk / Supabase Auth | Local dev user/workspace context | Avoid auth complexity while making data properly workspace-scoped |
| shadcn/ui | Plain Tailwind | Lower dep surface |
| Supabase Realtime | Polling | Works fine for <50 approvals |

These are **swap-when-needed**, not architectural debts. Always code to the interface, not the implementation. If you find code that assumes "Gemini" or "Map" specifically outside the layers that own them (`lib/agent/` and `lib/store/`), that's a bug — flag it.

## 5. Hard rules (non-negotiable)

These come from `marketing-agent-framework.md` §12 and govern every change.

1. **Every tool declares a tier** (`GREEN` | `YELLOW` | `RED`) or a dynamic `tier(input)` resolver. No untyped tools.
2. **Tier checks happen at the gate**, never inside the tool body. Tools assume they're authorized when called.
3. **Every write tool returns a `rollbackPayload`** and implements `rollback(payload, ctx)`. If you can't write rollback, the tool is `RED`.
4. **Every write tool implements `verify(input, output, ctx)`** that re-fetches state and confirms the change landed. Verification failures trigger rollback.
5. **Connectors declare `capabilities`.** Tools check capabilities before attempting writes.
6. **Skills are knowledge, tools are verbs.** Skills (`SKILL.md` files) describe how to think. They never make HTTP calls directly — only the tool registry talks to the world.
7. **Budget guards are hard caps.** Cannot be overridden by approval. Caps live in workspace config.
8. **PR-based writes preferred** wherever the connector supports it (GitHub-MDX, etc.) — free audit trail and rollback.
9. **No recursive self-invocation.** An agent run never spawns another agent run; the scheduler does.
10. **All LLM calls are logged** to the event log with model id, token counts (when available), latency, and purpose.
11. **Approvals expire.** Stale RED approvals auto-reject after a configurable window.
12. **The agent never modifies the product profile.** Profile changes are user-only.

When proposing a change that touches any of these, **cite the rule number** in your plan and in your response (see §11).

## 6. Tier system (canonical definition)

| Tier | Behavior | Examples |
|---|---|---|
| **GREEN** | Execute immediately. Log. No notification. | `crawl_site`, `audit_seo`, `fetch_analytics`, `draft_copy` (draft only), `submit_sitemap` |
| **YELLOW** | Execute. Notify (Slack/email + dashboard activity feed). Show with one-click revert. | `update_meta_tags`, `publish_blog_post`, `pause_underperforming_ad`, `queue_email_to_test_segment`, `deploy_ab_variant` |
| **RED** | Do NOT execute. Create approval record. Wait. | `change_pricing`, `launch_new_ad_campaign`, `send_email_to_full_list`, `rewrite_homepage_hero`, `delete_page`, any spend > daily budget cap |

**Auto-escalation**: a tool may start YELLOW and escalate to RED based on input (e.g. `publish_blog_post` becomes RED if the post mentions pricing or affects more than N pages). Encode escalation in the tool's `tier(input)` function, never at the call site.

**Budget guards** are independent of tier and are **hard caps**:
- `daily_ad_spend_cap`
- `email_recipients_cap_yellow`
- `pages_modified_per_day_cap`

A cap-exceeded call becomes RED regardless of the tool's declared tier.

## 7. Skills vs. tools (canonical distinction)

- A **skill** (`SKILL.md`) is *knowledge* — it tells the agent how to think about a marketing problem (SEO audit, copywriting, paid-ads pacing).
- A **tool** is a *verb* — a registered, tiered, schema-validated function the agent can call.
- Skills declare which tools they're allowed to use (`backend/src/lib/skills/manifest.ts`). The loop passes **only allowed tools** to the LLM.
- Skills never make HTTP calls. Tools never read other skills. Cross-skill logic is the orchestrator's job, not a skill's.
- SEO is a reference implementation, not the model for every workflow. Avoid SEO assumptions in shared UI, stores, agent runtime, route names, connector contracts, and approval surfaces.

## 8. Build stages — where we are

Track here. Update as we close each step.

**Current stage: build plan complete — operating in product-polish mode.**

| Step | Goal | Status |
|---|---|---|
| 1 | Storage split (9 typed stores) | ✅ done |
| 2 | Tier system + gate | ✅ done |
| 3 | First connector + `audit_seo` | ✅ done |
| 4 | Approvals inbox UI + campaign-brief modal | ✅ done |
| 5 | First YELLOW write tool (`add_alt_text`, real PR via `GITHUB_TOKEN`) | ✅ done |
| 6 | Scheduler + memory wiring | ✅ done |
| 7 | Wider UI: Agents, Drafts, Connections, Settings, Chat + per-skill tool manifests | ✅ done |

Post-plan backlog (not blocking; pick up as needed):
- Migrate SQLite JSON tables to a relational schema when reporting/query needs grow
- Add Clerk auth + multi-tenant
- Real OAuth for GA4 / GSC / Meta Ads / WordPress
- Split `page.tsx` into `views/` + `components/`
- Switch scheduler to Inngest for durability
- Streaming chat
- Real deploy config (Vercel + Render)

Rule: **finish one step before starting the next.** A half-finished step blocks every step downstream.

## 9. Dependency policy

Allowed without asking (already in or trivially needed when their stage arrives):
- `cheerio`, `node-fetch` — site connector (Step 3)
- `node-cron` — scheduler (Step 6)
- `zod` — tool input validation (Step 2)
- `@octokit/rest` — GitHub-MDX connector (Step 5)
- `better-sqlite3` — storage upgrade when in-memory stops fitting

**Ask before adding** anything else, especially:
- ORMs, auth libraries, UI libraries, icon libraries
- Anything with a postinstall script
- Anything that pulls in 50+ transitive deps
- Anything used in only one file

When in doubt, write the helper in 30 lines instead of pulling a package.

## 10. Workflow (project-wide)

Before non-trivial changes — anywhere in the repo:
1. **Inspect** the files in scope. Actually read them; don't assume from filenames.
2. **Plan** in 3–5 bullets and share before editing. State which framework rule (§5) the change implements or affects.
3. **Edit** only what's in scope. No drive-by refactors. No "while I'm here" cleanups.

When changes span frontend + backend (e.g. new endpoint + new screen):
- Define the contract first in the backend AGENTS.md endpoint table.
- Implement backend → confirm with a `curl` → then frontend.
- Never ship a frontend call to an endpoint that doesn't exist yet.

When in doubt between "simpler now" and "matches the framework": **pick the framework**. Simpler-now turns into rewrite-later.

Destructive actions (deleting files, force-pushing, dropping stores) require explicit confirmation in the same message that proposes them. Approval of one destructive action does not generalize to others.

## 11. Response format (project baseline)

After every meaningful change, tell Devansh:
1. **What changed** — short bullets
2. **Which files** — markdown paths with line numbers when relevant
3. **How to test** — exact commands + what to click / check
4. **Framework rule(s) implemented or touched** — cite from §5 above
5. **Next step** — one sentence

Keep it short. No essays. No emojis unless he asks.

## 12. Developer profile

The developer is **Devansh**, beginner-level.

All code must be:
- Simple and readable. No clever one-liners. No point-free style.
- Well-commented **where the WHY is non-obvious**. Don't narrate what the code does.
- Typed. No `any` without a comment justifying it.
- Broken into small files with single responsibilities.

Explanations to Devansh must be:
- Plain English, not jargon
- Specific (file paths + line numbers), not vague
- Honest about what wasn't tested

## 13. What to never do

- Edit files in `.agents/skills/` (upstream content)
- Add a dependency without checking §9
- Skip the tier gate "just this once"
- Write a tool without `verify` + `rollback` and call it YELLOW (it's RED)
- Make the agent edit the product profile (rule §5.12)
- Call `fetch()` outside `backend/src/lib/connectors/` or `frontend/app/lib/api.ts`
- Call Gemini outside `backend/src/lib/agent/`
- `console.log` business data — use the event log
- Claim "tested" when the dev server wasn't actually run
- Rewrite the framework spec to match the current code. The framework is the target; the code is what we're moving toward.

## 14. Reference

- `marketing-agent-framework.md` — full architectural spec (canonical)
- `frontend/AGENTS.md` — frontend-specific rules
- `backend/AGENTS.md` — backend-specific rules
- `.agents/skills/<skill-id>/SKILL.md` — per-skill marketing knowledge (upstream)
