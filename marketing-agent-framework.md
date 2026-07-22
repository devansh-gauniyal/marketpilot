# MarketPilot AI Framework

This is the canonical product and architecture blueprint for MarketPilot AI.
When this document conflicts with another project note, this document wins.

## 1. Product Definition

MarketPilot AI is an autonomous marketing agent platform.

The product is not an SEO tool. SEO is the first deeply implemented workflow
because it was built first. The intended product is a multi-skill marketing
agent that can use every downloaded marketing skill as a specialist workflow.

The core promise:

```text
Connect your business context and marketing systems. Pick a marketing skill.
The agent plans, researches, drafts, audits, and executes safe work
autonomously. It asks permission only for important or risky actions.
```

## 2. Product Mental Model

MarketPilot is made of five layers:

```text
Workspace context
  -> Skills
  -> Agent loop
  -> Tier-gated tools
  -> Connectors
```

### Workspace Context

The workspace stores the user's business context:

- product profile
- website URL
- connected GitHub repo
- future analytics, ads, CMS, email, and CRM connections
- previous runs
- drafts
- audits
- approvals
- tool calls
- event log

The agent can read this context as memory. The agent must never edit the product
profile directly. Profile changes are user-only.

### Skills

Skills are specialist marketing playbooks. They are knowledge, not actions.

The downloaded `.agents/skills/<skill-id>/SKILL.md` files describe how to think
about marketing work, such as:

- SEO audits
- AI search optimization
- copywriting
- content strategy
- paid ads
- cold email
- launch strategy
- pricing strategy
- churn prevention
- conversion optimization
- sales enablement

Every downloaded skill should eventually be usable from the web app as an agent
workflow.

### Agent Loop

The agent loop turns a user's instruction plus a skill into work.

The ideal lifecycle:

```text
1. Load workspace memory.
2. Load selected skill instructions.
3. Load tools allowed for that skill.
4. Plan the work.
5. Execute GREEN work automatically.
6. Execute YELLOW work automatically, notify, and preserve rollback.
7. Pause RED work for human approval.
8. Save drafts, audits, decisions, tool calls, and events.
9. Finish with a structured report.
```

### Tools

Tools are verbs. A tool is something the agent can do.

Examples:

- crawl a site
- audit SEO
- read a URL
- write a draft
- scan a repo
- create a pull request
- fetch analytics
- draft an email sequence
- propose an A/B test

Every tool must declare a tier or dynamic tier resolver.

### Connectors

Connectors talk to external systems. Tools call connectors.

Examples:

- site crawler
- GitHub repo connector
- Google Search Console
- GA4
- WordPress
- Webflow
- email provider
- ad platform

Connectors declare capabilities. Tools check capabilities before writes.

## 3. Autonomy And Permission Model

The agent should be autonomous by default, but safe by design.

### GREEN

GREEN actions run automatically.

Use for safe reads and low-risk draft work.

Examples:

- crawl public site
- audit page
- read URL
- draft copy
- summarize competitors

### YELLOW

YELLOW actions run automatically but notify the user and preserve rollback.

Use for reversible writes.

Examples:

- create a draft
- create a GitHub PR with reversible changes
- queue a test email to a small segment
- pause a clearly underperforming ad set if rollback is available

YELLOW write tools must return rollback payloads and support verification.

### RED

RED actions require approval before execution.

Use for important, risky, expensive, public, or hard-to-revert actions.

Examples:

- change pricing
- launch a new ad campaign
- send email to a full list
- rewrite a homepage hero
- delete a page
- exceed a budget cap

Budget caps are hard caps. Approval cannot override them unless workspace
configuration changes first.

## 4. SEO Is A Reference Workflow, Not The Product Center

SEO currently has the most mature end-to-end flow:

```text
Audit site
  -> scan repo
  -> prepare fixes
  -> wait for approval
  -> create GitHub PR
  -> verify/rollback
```

This flow is useful as a reference implementation for other skills.

It should teach the rest of the system how to:

- load context
- use a skill
- run safe tools
- create approvals
- generate previews
- write through connectors
- verify work
- preserve rollback

But shared product areas must not assume every workflow is SEO.

## 5. All Skills Must Become Runnable Workflows

A skill is considered product-usable when it has:

- display name
- category
- clear description
- input brief fields
- expected output shape
- allowed tools
- risk behavior
- connector requirements
- frontend rendering plan
- test prompt or local verification path

Maturity levels:

```text
Draft-only:
  The agent can research, reason, and produce drafts/recommendations.

Guided:
  The agent has skill-specific inputs and structured outputs.

Executable:
  The agent can perform real actions through tools/connectors.

Autonomous-safe:
  The agent can run scheduled/proactive workflows and asks approval only
  for important or risky actions.
```

The project should build one skill deeply at a time while keeping the system
general enough for all skills.

## 6. Priority Skill Waves

The first mature wave should cover breadth across marketing jobs.

Recommended first 10:

1. `seo-audit`
2. `copywriting`
3. `content-strategy`
4. `page-cro`
5. `cold-email`
6. `email-sequence`
7. `paid-ads`
8. `ad-creative`
9. `competitor-profiling`
10. `launch-strategy`

These should receive skill-specific briefs, structured outputs, and better UI
before the long tail of skills is polished.

## 7. Skill Briefs

The app should not force every skill through the same generic campaign form.

Examples:

```text
Cold Email:
  ICP, offer, sender role, proof points, objection handling, CTA.

Page CRO:
  page URL, conversion goal, traffic source, current conversion rate,
  known friction.

Paid Ads:
  channel, offer, audience, budget, current performance, constraints.

Pricing Strategy:
  current tiers, value metric, buyer segments, competitors, pricing worries.

Launch Strategy:
  product/feature, launch date, audience, channels, assets, constraints.
```

Skill-specific inputs should be stored with the skill run so the agent has
structured context and future runs can learn from past work.

## 8. Structured Outputs

The UI should not treat agent work as one blob of text.

Common output types:

- draft
- audit
- recommendation list
- experiment plan
- email sequence
- ad variants
- content calendar
- competitor profile
- launch checklist
- approval request

Each skill should declare which output types it produces.

## 9. Approval Experience

Approvals are the trust layer of the product.

An approval should explain:

- what the agent wants to do
- why it recommends the action
- what systems/files/pages/accounts are affected
- before/after summary when available
- risk level
- expected impact
- rollback plan
- connector used
- tool used

The user should be able to approve or reject without reading source code.

## 10. Connectors Roadmap

Build connectors in the order that unlocks the most useful workflows:

1. GitHub
2. Site crawler
3. Google Search Console
4. GA4
5. Email provider
6. CMS
7. Google Ads / Meta Ads / LinkedIn Ads
8. CRM / RevOps systems

When a connector is missing, the skill should degrade gracefully:

```text
This run can produce drafts and recommendations.
Connect GA4 to include conversion performance.
Connect GitHub to let the agent propose PRs.
```

## 11. Event And Memory Requirements

Every meaningful agent action should be recorded.

Log:

- run started
- memory loaded
- skill loaded
- tools filtered
- LLM call
- tool gated
- tool executed
- approval created
- approval decided
- verification result
- rollback result
- run completed or failed

Memory should help future runs, but the agent must not silently rewrite the
user's product profile.

## 12. Non-Negotiable Rules

1. Every tool declares GREEN, YELLOW, RED, or a dynamic tier resolver.
2. Tier checks happen at the gate, never inside the tool body.
3. Every write tool returns a rollback payload. If rollback is not possible,
   the tool is RED.
4. Every write tool verifies the result after execution.
5. Connectors declare capabilities.
6. Skills are knowledge; tools are verbs; connectors are adapters.
7. Budget guards are hard caps.
8. PR-based writes are preferred where available.
9. The agent never recursively starts another agent run.
10. LLM calls are logged.
11. Approvals expire.
12. The agent never modifies the product profile.

## 13. Current Product Truth

The current codebase has strong foundations:

- Next.js frontend
- Express/TypeScript backend
- SQLite-backed stores
- workspace context
- product profile
- connections
- GitHub OAuth
- GitHub health check
- tier gate
- approvals
- tool calls
- audits
- scheduler
- SEO-to-PR reference workflow
- 41 downloaded marketing skills

The biggest current gap is not "more SEO." The gap is turning the downloaded
skills into first-class agent workflows with the right briefs, outputs, tools,
and approval behavior.

## 14. Build Direction

Move forward in this order:

1. Keep this blueprint current.
2. Design the skill catalog.
3. Pick the first 10 skills to mature.
4. Add skill-specific briefs.
5. Add structured outputs.
6. Improve the shared agent runner.
7. Expand tools by skill category.
8. Improve approvals and previews.
9. Expand connectors.
10. Refactor frontend structure.
11. Add onboarding.
12. Add real auth.
13. Expand scheduling.
14. Deploy.

Do not make shared infrastructure SEO-specific. SEO is the reference workflow,
not the final product boundary.
