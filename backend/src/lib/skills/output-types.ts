// Structured-output shapes — one per OutputType declared in types.ts.
//
// The agent loop (or a per-skill orchestrator) attaches one or more of these
// to the SkillRun's finalReport so the frontend can render each kind of
// artifact with its own React component instead of as a wall of text.
//
// All shapes are intentionally minimal v1s. Add fields as real skills mature
// in Step 4 — do not pre-build for hypothetical needs.

export type AuditOutput = {
  title: string;
  url?: string;
  score?: number; // 0–100
  summary: string;
  sections: Array<{
    label: string; // "Meta tags" / "Performance" / "Accessibility"
    severity: "ok" | "warn" | "fail";
    findings: Array<{
      title: string;
      detail: string;
      recommendation?: string;
    }>;
  }>;
};

export type DraftOutput = {
  title: string;
  format: "markdown" | "plain" | "html";
  body: string;
};

export type RecommendationListOutput = {
  title: string;
  items: Array<{
    title: string;
    detail: string;
    priority?: "high" | "medium" | "low";
  }>;
};

export type ExperimentPlanOutput = {
  title: string;
  hypothesis: string;
  metric: string;
  variants: Array<{ name: string; description: string }>;
  durationDays?: number;
  successCriteria?: string;
};

export type EmailSequenceOutput = {
  title: string;
  audience: string;
  steps: Array<{
    stepNumber: number;
    delayHours: number; // hours after the previous step (0 = day 1)
    subject: string;
    body: string;
    cta?: string;
  }>;
};

export type AdVariantsOutput = {
  title: string;
  platform: string; // "Google Ads" / "Meta" / "LinkedIn"
  variants: Array<{
    name: string;
    headline: string;
    description: string;
    cta?: string;
  }>;
};

export type ContentCalendarOutput = {
  title: string;
  items: Array<{
    date: string; // ISO date
    channel: string; // "Blog" / "LinkedIn" / "X" / "Email"
    title: string;
    summary: string;
  }>;
};

export type CompetitorProfileOutput = {
  title: string;
  competitors: Array<{
    name: string;
    url: string;
    positioning: string;
    strengths: string[];
    weaknesses: string[];
    yourAdvantages?: string[];
    yourGaps?: string[];
    quickWins?: string[];
  }>;
};

export type LaunchChecklistOutput = {
  title: string;
  launchDate?: string;
  groups: Array<{
    label: string; // "Pre-launch" / "Launch day" / "Post-launch"
    items: Array<{ task: string; owner?: string; done?: boolean }>;
  }>;
};

export type ApprovalRequestOutput = {
  title: string;
  whatWillHappen: string;
  why: string;
  risk: "low" | "medium" | "high";
  rollbackPlan: string;
};

// Discriminated union — the renderer switches on `.type`.
export type StructuredOutput =
  | { type: "audit"; data: AuditOutput }
  | { type: "draft"; data: DraftOutput }
  | { type: "recommendationList"; data: RecommendationListOutput }
  | { type: "experimentPlan"; data: ExperimentPlanOutput }
  | { type: "emailSequence"; data: EmailSequenceOutput }
  | { type: "adVariants"; data: AdVariantsOutput }
  | { type: "contentCalendar"; data: ContentCalendarOutput }
  | { type: "competitorProfile"; data: CompetitorProfileOutput }
  | { type: "launchChecklist"; data: LaunchChecklistOutput }
  | { type: "approvalRequest"; data: ApprovalRequestOutput };
