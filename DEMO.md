# Interview Demo — MarketPilot AI

A 7-step walkthrough that takes ~5 minutes and hits every interview-worthy part of the system. Each step has:
- **You say** — the one-line pitch in plain English
- **You do** — the click/command
- **They see** — what shows up
- **If they ask** — likely follow-up + good answer

Open **two terminals + one browser** before you start.

---

## Setup (90 seconds)

```powershell
# Terminal 1
cd backend ; npm run dev

# Terminal 2
cd frontend ; npm run dev
```

Open http://localhost:3000.

Confirm:
- `[scheduler] registered "weekly-seo-audit" — cron: 0 6 * * 1` appears in Terminal 1.
- The frontend loads on the Dashboard with "Good evening, Devansh".

---

## Step 1 — Pitch the product (30s)

**You say**:
> "MarketPilot AI is an autonomous marketing agent platform. The big idea is the **autonomy isn't binary** — every tool the agent can call is tagged green, yellow, or red. Reads run silently. Reversible writes auto-execute and log. High-stakes writes wait for me to approve. The agent's never asking me 'should I check the meta description?' — it just does. But it'll never publish to my homepage without me clicking yes."

**You do**: scroll the Dashboard. Point at the **+ New Run** button, **Proposed Actions** in the sidebar (note the red badge if any), and **SEO Reports**.

**If they ask "why three tiers?"**:
> "Two tiers is what you see in most agent demos — execute, or ask. That breaks at scale. A real marketing agent runs 50 actions a week; humans don't want to click 'yes' fifty times. Three tiers lets reads happen for free, lets reversible writes auto-execute with a paper trail, and reserves the click-yes flow for things you can't undo."

---

## Step 2 — Set up the product profile (45s)

**You say**:
> "Before the agent runs, it needs context. Every run reads a 'memory bundle' — product profile, recent audits, recent performance — and prepends it to the prompt. So it never starts cold."

**You do**:
1. Click **Product Profile** in the sidebar.
2. Show the form is **populated from the backend** (`/api/profile`).
3. Edit the **Tagline** field. Top-right shows **"Unsaved changes"** in amber.
4. Click **Save changes**. It flips to **"✓ Saved Xs ago"** in green.
5. Point at the **Profile Strength** ring on the right — it's computed live from a 12-check list.

**If they ask "where's this saved?"**:
> "Right now in an in-memory `Map`. The store has a stable interface — `get`, `set` — so swapping to SQLite or Postgres later is a single-file change. Repository pattern."

---

## Step 3 — Launch an agent run (60s)

**You say**:
> "Now I'll launch a real run. The agent picks the right tool, calls it, looks at the result, and decides the next step. It's a ReAct loop wrapped around Gemini's function calling."

**You do**:
1. Click **+ New Run** in the sidebar (or **+ Launch a campaign** on the Dashboard).
2. Pick **SEO Audit**.
3. Product name: `Demo`. Campaign goal: `Audit https://example.com using audit_seo`.
4. Click **Launch agents**.
5. Modal closes, auto-navigates to **Proposed Actions** (still loading).

**You say** (while it runs):
> "Right now Gemini is reading the brief plus the workspace memory. It'll decide to call `audit_seo` — the tool wraps a cheerio-based site connector that fetches the URL, parses the HTML, and runs about ten SEO checks. The findings get a 0-100 score and persist into the audits store."

**If they ask "what stops the agent from going rogue?"**:
> "Two things. Every tool has a hard-coded tier. And every tool call goes through the gate — a single function called before dispatch. The gate fails closed on unknown tools, so a typo can't smuggle a call past."

---

## Step 4 — Approvals inbox (45s)

**You do**: wait ~30 seconds. The page polls every 5 seconds, so as soon as the agent calls `finish()` the approvals appear. The sidebar shows a red badge with the count.

**You say**:
> "When the agent finishes, every action it proposes gets a real approval record. This is the inbox. I can approve or reject inline."

**You do**:
1. Click **Approve** on one card.
2. It flips to "approved", the sidebar badge drops by one.
3. Click the **filter pills**: Pending / Approved / Rejected / All.

**If they ask "what happens when you approve?"**:
> "Right now: the simulated execution stub fires. In production, approval would trigger the actual write tool — like opening a Meta Ads campaign, or queuing an email send. The approval row stores the rollback plan so you can always undo."

---

## Step 5 — The audits screen (30s)

**You do**:
1. Click **SEO Reports** in the sidebar.
2. Click the audit card to expand it.

**You say**:
> "Every audit is structured data — title length, missing meta, alt-text gaps, schema, canonical, language, viewport. Click any card to see all findings. Severity-tagged. Score is deterministic — same inputs, same score."

**If they ask "how does the agent know what's a finding?"**:
> "The checks are a pure function. `runAuditChecks(crawledPage) → findings[]`. No I/O, easy to unit-test. We have a test that crawls example.com and asserts the full chain."

---

## Step 6 — Show the YELLOW write flow + rollback (60s)

**You say**:
> "This is the real magic. Yellow tier = reversible write. We have one wired today — `add_alt_text`. It opens a Pull Request to fix alt-text. PR-based means rollback is automatic — just close the PR."

**You do** in a third terminal (PowerShell):
```powershell
# Force the agent to call add_alt_text
Invoke-RestMethod -Method Post -Uri "http://localhost:4000/api/agent/start" `
  -ContentType "application/json" `
  -Body (@{
    skillId = "seo-audit"
    productName = "Demo"
    targetAudience = "any"
    campaignGoal = "Call add_alt_text once with patches [{filepath:'content/blog/x.mdx', imageSrc:'/img/hero.png', altText:'Demo alt text'}], reason: 'demo'. Then call finish."
    brandTone = "Professional"
    mainChannel = "Website SEO"
    campaignBudget = "Low"
    launchTimeline = "now"
  } | ConvertTo-Json)

Start-Sleep 30

# See the tool call persisted (with rollback payload)
Invoke-RestMethod "http://localhost:4000/api/tool-calls" | ConvertTo-Json -Depth 6
```

Point at the **simulated PR URL** in `outputJson.changeId` and the **rollback payload** with the patches in it.

```powershell
# Roll it back
$id = (Invoke-RestMethod "http://localhost:4000/api/tool-calls").toolCalls[0].id
Invoke-RestMethod -Method Post "http://localhost:4000/api/tool-calls/$id/rollback"
```

**You say**:
> "PR closed. Tool call status flips to 'rolled_back'. Rollback gets logged to the event store too. Today the connector is simulated — when I add a GitHub token, the connector body switches to a real Octokit call. Nothing else changes."

**If they ask "is anything real about this?"**:
> "The cheerio connector and `audit_seo` are 100% real — they hit live URLs. The GitHub-MDX connector is simulated until I wire OAuth. The point of the simulation is to prove the **mechanism** — gate → tool → rollback payload → store → rollback API — end to end, without spending OAuth time before the architecture is settled."

---

## Step 7 — Show the under-the-hood plumbing (60s)

**You do** in the terminal:
```powershell
# Every gate decision is in the event log
Invoke-RestMethod "http://localhost:4000/api/events?limit=15" | ConvertTo-Json -Depth 4

# Run the tier-gate unit test (no Gemini, no server needed)
cd backend
npx tsx src/lib/agent/__tests__/tier-gate.test.ts

# Run the SEO audit unit test against a live URL
npx tsx src/lib/tools/seo/__tests__/audit-seo.test.ts

# Run the memory loader test
npx tsx src/lib/memory/__tests__/load.test.ts

# Trigger the weekly cron manually instead of waiting for Monday 6am
Invoke-RestMethod -Method Post "http://localhost:4000/api/scheduler/run/weekly-seo-audit"
```

**You say**:
> "Every gate decision, every tool call, every approval, every rollback writes one event to the log. Append-only. That's how the future Activity feed works, and it's the only place I do anything resembling logging — routes never `console.log` business data."

---

## Common questions + good answers

**Q: Why Gemini, not Claude or GPT?**
A: Engineering tradeoff. Generous free tier, reliable function calling, fast inference with 2.5 Flash. The framework spec actually called for Claude — I picked Gemini and documented the deviation. Swapping is a single-file change inside `lib/agent/` because the rest of the code doesn't know which LLM is underneath.

**Q: Why in-memory storage?**
A: Solo project, pre-launch. Real databases add ops complexity I don't need yet. Each store has a stable interface (`create`, `get`, `list`, `update`), so swapping `Map` for `better-sqlite3` later is one file per store.

**Q: How do you stop the agent from looping forever?**
A: Hard cap of 12 tool iterations per run. Plus the `finish` tool — the agent's contract is "call `finish` when done." If it hits the cap, the loop wraps up gracefully and reports what it has.

**Q: How does the agent know what's safe vs unsafe?**
A: It doesn't. **The system does.** The tier is hard-coded next to the tool declaration, in code I control. Gemini never sees the tier — that's our control plane, not the agent's prompt surface.

**Q: How would you scale to 100 customers?**
A: Three changes. (1) Replace in-memory stores with Postgres. (2) Swap `node-cron` for Inngest for durable scheduled jobs. (3) Add Clerk for auth. The agent loop and tool system don't change.

**Q: What's the hardest design decision you faced?**
A: Where to draw the line between automation and approval. Too automatic — agent ships a typo to your homepage. Too gated — every read needs a click, defeats the point. Three tiers was the answer. Plus budget guards as hard caps on top.

**Q: What would you build next?**
A: Real OAuth for GitHub so `add_alt_text` opens actual PRs. Then more YELLOW write tools — `add_schema_markup`, `update_meta_tag`, `pause_underperforming_ad`. Then connections for GA4 and Meta Ads so the agent has real performance data in memory.

---

## Quick reference — every endpoint

```
GET  /health                              backend alive?
POST /api/agent/start                     start a skill run
GET  /api/agent/:taskId                   poll a run
POST /api/agent/:taskId/approve           legacy approve (still works)
GET  /api/profile                         read product profile
PUT  /api/profile                         save product profile
GET  /api/approvals?status=pending        approvals inbox
POST /api/approvals/:id/decide            decide one
GET  /api/approvals-count                 sidebar badge
GET  /api/audits                          audits history
GET  /api/audits/:id                      one audit
GET  /api/tool-calls                      every rollbackable tool call
POST /api/tool-calls/:id/rollback         undo one
GET  /api/events?limit=N                  event log
GET  /api/scheduler/jobs                  registered cron jobs
POST /api/scheduler/run/:jobId            fire a job manually
```

---

## Last-minute checklist before the demo

- [ ] `backend/.env` has a valid `GEMINI_API_KEY`
- [ ] Backend starts and prints `[scheduler] registered "weekly-seo-audit"`
- [ ] Frontend loads on the Dashboard, not on an error screen
- [ ] Product Profile loads with the seeded data (not "Loading…")
- [ ] You can launch a run and see approvals appear within 30 seconds
- [ ] Two terminal windows + one browser pre-arranged on the screen
- [ ] [NOTES.md](NOTES.md) open in another tab — your interview cheat sheet

Good luck, Devansh.
