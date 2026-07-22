// Shared types for the store layer.
// Field names mirror the framework spec's Drizzle/Postgres schema so a future
// swap to a real database is a copy/paste of these shapes.

import type { StructuredOutput } from "../skills/output-types";
export type { StructuredOutput };

/* ---------- Workspace ---------- */

export type User = {
  id: string;
  email: string;
  name: string;
  createdAt: string;
};

export type Workspace = {
  id: string;
  name: string;
  plan: "free" | "pro" | "enterprise";
  createdAt: string;
};

export type WorkspaceRole = "owner" | "admin" | "member";

export type WorkspaceMembership = {
  id: string;
  userId: string;
  workspaceId: string;
  role: WorkspaceRole;
  createdAt: string;
};

/* ---------- Product profile ---------- */

export type ProductProfile = {
  id: string;
  workspaceId: string;
  productName: string;
  tagline: string;          // short elevator pitch — different from `positioning` (long form)
  industry: string;
  stage: "Pre-launch" | "MVP" | "Growth" | "Scale";
  siteUrl: string;          // canonical site URL — used by the scheduler
  positioning: string;      // long-form narrative ("Describe your product")
  features: string[];       // core features chips
  differentiators: string[];// differentiator chips
  icp: string;              // ideal customer profile description
  voiceTone: string[];      // ["Professional", "Bold", "Technical"]
  mrr: number;              // current monthly recurring revenue ($)
  monthlyTraffic: number;   // monthly visitors
  northStar: string;        // 3-month north star
  pricingJson: unknown;
  competitorsJson: unknown;
  brandGuidelines: string;
  updatedAt: string;
};

/* ---------- Connections (site, GA4, GSC, ads, email, CMS, ...) ---------- */

export type ConnectionType =
  | "site"
  | "ga4"
  | "gsc"
  | "google_ads"
  | "meta_ads"
  | "linkedin_ads"
  | "github"
  | "wordpress"
  | "webflow"
  | "email";

export type ConnectionStatus = "active" | "expired" | "error" | "pending";

export type Connection = {
  id: string;
  workspaceId: string;
  type: ConnectionType;
  configJson: Record<string, unknown>;  // OAuth tokens (encrypted later), URLs, etc.
  status: ConnectionStatus;
  lastSyncedAt?: string;
};

/* ---------- Skill runs (was AgentTask) ---------- */

export type AgentStep = {
  stepId: string;
  type: "tool_call" | "tool_result";
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  content: string;
  timestamp: string;
};

export type AgentDraft = {
  title: string;
  content: string;
  type: string;
  createdAt: string;
};

export type ProposedActionStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "executed";

export type ProposedAction = {
  actionId: string;
  type: string;
  title: string;
  description: string;
  status: ProposedActionStatus;
  resolvedAt?: string;
  result?: string;
};

export type AgentDecision = {
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

export type FinalReport = {
  executiveSummary: string;
  findings: string[];
  recommendations: string[];
  nextSteps: string[];
  drafts: AgentDraft[];
  proposedActions: ProposedAction[];
  decision?: AgentDecision;
  // Optional — populated by skills that emit typed artifacts (audit, email
  // sequence, ad variants, etc.). The frontend renders each entry with a
  // dedicated component instead of plain text. See lib/skills/output-types.ts.
  structuredOutputs?: StructuredOutput[];
};

// Used internally by the agent loop to track the Gemini conversation.
// Never sent to the client.
export type GeminiContent = {
  role: string;
  parts: unknown[];
};

export type SkillRunStatus = "running" | "completed" | "failed";

// NOTE: field names kept identical to the legacy AgentTask shape so the JSON
// returned by /api/agent/:taskId stays byte-compatible with the frontend.
export type SkillRun = {
  taskId: string;
  workspaceId: string;
  campaignId?: string;
  status: SkillRunStatus;
  skillId: string;
  inputContext: Record<string, string>;
  steps: AgentStep[];
  drafts: AgentDraft[];
  finalReport?: FinalReport;
  error?: string;
  createdAt: string;
  updatedAt: string;
};

/* ---------- Tool calls ---------- */

export type Tier = "GREEN" | "YELLOW" | "RED";

export type ToolCallStatus =
  | "pending"
  | "executed"
  | "rolled_back"
  | "failed";

export type ToolCallWriteStatus =
  | "unknown"
  | "pr_open"
  | "pr_merged"
  | "pr_closed"
  | "pr_not_found"
  | "simulated";

export type ToolCall = {
  id: string;
  skillRunId: string;
  toolName: string;
  tier: Tier;
  inputJson: unknown;
  outputJson?: unknown;
  rollbackPayloadJson?: unknown;
  verified?: boolean;
  verificationResult?: string;
  writeStatus?: ToolCallWriteStatus;
  writeStatusCheckedAt?: string;
  status: ToolCallStatus;
  executedAt?: string;
};

/* ---------- Approvals (first-class, can outlive a skill run) ---------- */

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "modified"
  | "expired";

export type Approval = {
  id: string;
  workspaceId: string;
  skillRunId: string;
  toolCallId: string;
  title: string;
  summary: string;
  reasoning: string;
  proposedActionJson: unknown;
  expectedImpact: string;
  rollbackPlan: string;
  status: ApprovalStatus;
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  createdAt: string;
};

/* ---------- Audits (historical reports) ---------- */

export type AuditType = "seo" | "analytics" | "cro" | "ads" | "churn";

export type Audit = {
  id: string;
  workspaceId: string;
  type: AuditType;
  scopeJson: unknown;        // what the audit covered
  findingsJson: unknown;     // raw findings
  triagedActionsJson: unknown; // green / yellow / red split
  createdAt: string;
};

/* ---------- Performance snapshots (daily rows, time-series) ---------- */

export type PerformanceSnapshot = {
  date: string;              // YYYY-MM-DD
  workspaceId: string;
  trafficOrganic: number;
  trafficPaid: number;
  trafficDirect: number;
  conversions: number;
  mrr: number;
  cac: number;
  churnRate: number;
  adSpend: number;
  adRoas: number;
  rankingsJson: unknown;
};

/* ---------- Event log (append-only) ---------- */

export type AgentEvent = {
  id: string;
  workspaceId: string;
  type: string;              // "tool_call", "verify_failed", "approval_created", "llm_call", ...
  payload: unknown;
  createdAt: string;
};
