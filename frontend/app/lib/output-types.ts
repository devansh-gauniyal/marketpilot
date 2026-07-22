// Mirror of backend/src/lib/skills/output-types.ts.
// Kept in sync by hand for now — TS strict will surface drift the moment a
// backend field changes shape and the frontend tries to read it.

export type AuditOutput = {
  title: string;
  url?: string;
  score?: number;
  summary: string;
  sections: Array<{
    label: string;
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
    delayHours: number;
    subject: string;
    body: string;
    cta?: string;
  }>;
};

export type AdVariantsOutput = {
  title: string;
  platform: string;
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
    date: string;
    channel: string;
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
    label: string;
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
