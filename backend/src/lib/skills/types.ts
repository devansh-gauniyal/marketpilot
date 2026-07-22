// Skill Catalog types — the contract every skill entry must fill.
//
// One catalog entry per skill. The rest of the app reads from the catalog:
// the agent loop filters tools by `allowedTools`, the frontend skill picker
// renders `displayName` / `tagline` / `category` / `maturity`, the brief modal
// (Step 3) renders `briefFields`, and the output renderer (Step 2) picks a
// React component based on `outputs`.
//
// See marketing-agent-framework.md §5–§8 for the source-of-truth definitions
// of maturity levels and output types.

export type SkillCategory =
  | "seo"
  | "content"
  | "cro"
  | "paid"
  | "email"
  | "research"
  | "strategy"
  | "lifecycle";

export type SkillMaturity =
  | "draft-only"      // research + drafts only, no real writes
  | "guided"          // skill-specific brief + structured output
  | "executable"      // can perform real actions through tools/connectors
  | "autonomous-safe"; // safe to run on a schedule

export type OutputType =
  | "draft"
  | "audit"
  | "recommendationList"
  | "experimentPlan"
  | "emailSequence"
  | "adVariants"
  | "contentCalendar"
  | "competitorProfile"
  | "launchChecklist"
  | "approvalRequest";

export type ApprovalBehavior =
  | "drafts-only"   // never writes — no approval needed
  | "yellow-default" // reversible writes auto-run + notify
  | "red-default";   // most actions require approval

export type BriefFieldType =
  | "text"
  | "textarea"
  | "url"
  | "select"
  | "number";

export interface BriefField {
  key: string;
  label: string;
  type: BriefFieldType;
  required: boolean;
  placeholder?: string;
  helpText?: string;
  // Only used when type === "select".
  options?: string[];
}

export interface SkillCatalogEntry {
  id: string;
  displayName: string;
  category: SkillCategory;
  tagline: string;
  description: string;
  maturity: SkillMaturity;

  // Skill-specific input fields. Empty array means the brief modal falls back
  // to the generic campaign form until this skill is matured (Step 4).
  briefFields: BriefField[];

  // Which structured-output renderers this skill can emit.
  outputs: OutputType[];

  // Allowlist of tool names the agent loop will pass to the LLM for this
  // skill. Empty array means "fall back to DEFAULT_TOOLS" — see catalog.ts.
  allowedTools: string[];

  // Connectors gating — `required` blocks the run, `optional` degrades
  // gracefully ("connect GA4 to include conversion performance").
  requiredConnectors: string[];
  optionalConnectors: string[];

  // Starting risk posture. The tier-gate still has the final say per tool.
  defaultApprovalBehavior: ApprovalBehavior;

  // True when this skill can touch ad spend, email sends, or public pages
  // — workspace budget caps apply on top of approval gating.
  budgetSensitive: boolean;

  // Canonical prompt + expected artifacts — used by regression checks and
  // shown in the skill detail page as "what success looks like".
  testPrompt: string;
  expectedArtifacts: string[];

  // Optional one-liner shown in the picker for draft-only skills, e.g.
  // "Brief form and structured output coming in v2."
  comingSoonNote?: string;
}
