// StructuredOutput renderer.
//
// When a SkillRun's finalReport has `structuredOutputs`, we render each one
// with its dedicated component instead of as a wall of text. Today only the
// SEO orchestrator emits real data (audit type). As more skills mature in
// Step 4, they emit their own types and the matching sub-component shows up
// automatically.

import type {
  AdVariantsOutput,
  ApprovalRequestOutput,
  AuditOutput,
  CompetitorProfileOutput,
  ContentCalendarOutput,
  DraftOutput,
  EmailSequenceOutput,
  ExperimentPlanOutput,
  LaunchChecklistOutput,
  RecommendationListOutput,
  StructuredOutput,
} from "../lib/output-types";

export function StructuredOutputList({
  outputs,
}: {
  outputs: StructuredOutput[] | undefined;
}) {
  if (!outputs || outputs.length === 0) return null;
  return (
    <div className="space-y-4">
      {outputs.map((o, i) => (
        <StructuredOutputCard key={i} output={o} />
      ))}
    </div>
  );
}

function StructuredOutputCard({ output }: { output: StructuredOutput }) {
  switch (output.type) {
    case "audit":
      return <AuditCard data={output.data} />;
    case "draft":
      return <DraftCard data={output.data} />;
    case "recommendationList":
      return <RecommendationListCard data={output.data} />;
    case "experimentPlan":
      return <ExperimentPlanCard data={output.data} />;
    case "emailSequence":
      return <EmailSequenceCard data={output.data} />;
    case "adVariants":
      return <AdVariantsCard data={output.data} />;
    case "contentCalendar":
      return <ContentCalendarCard data={output.data} />;
    case "competitorProfile":
      return <CompetitorProfileCard data={output.data} />;
    case "launchChecklist":
      return <LaunchChecklistCard data={output.data} />;
    case "approvalRequest":
      return <ApprovalRequestCard data={output.data} />;
    default:
      return null;
  }
}

/* ----------------------------- shared bits ---------------------------- */

function CardShell({
  label,
  title,
  subtitle,
  children,
}: {
  label: string;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wider text-indigo-600">
            {label}
          </div>
          <h3 className="mt-1 text-base font-semibold text-slate-900">
            {title}
          </h3>
          {subtitle && (
            <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>
          )}
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function severityChip(severity: "ok" | "warn" | "fail") {
  if (severity === "fail") {
    return "bg-rose-50 text-rose-700";
  }
  if (severity === "warn") {
    return "bg-amber-50 text-amber-700";
  }
  return "bg-emerald-50 text-emerald-700";
}

/* ------------------------------- audit -------------------------------- */

function AuditCard({ data }: { data: AuditOutput }) {
  return (
    <CardShell
      label="Audit"
      title={data.title}
      subtitle={data.url}
    >
      <div className="flex items-center gap-3">
        {typeof data.score === "number" && (
          <div className="rounded-xl bg-slate-50 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              Score
            </div>
            <div className="text-2xl font-semibold tracking-tight text-slate-900">
              {data.score}
              <span className="text-sm font-normal text-slate-500">/100</span>
            </div>
          </div>
        )}
        <p className="flex-1 text-sm text-slate-600">{data.summary}</p>
      </div>

      <div className="mt-4 space-y-3">
        {data.sections.map((section, si) => (
          <div
            key={si}
            className="rounded-xl border border-slate-200 bg-slate-50/60 p-4"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="text-sm font-semibold text-slate-900">
                {section.label}
              </div>
              <span
                className={
                  "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                  severityChip(section.severity)
                }
              >
                {section.severity === "ok"
                  ? "Passing"
                  : section.severity === "warn"
                    ? "Warning"
                    : "Critical"}
              </span>
            </div>
            <ul className="mt-2 space-y-1.5">
              {section.findings.map((f, fi) => (
                <li key={fi} className="text-xs leading-5 text-slate-700">
                  <span className="font-semibold text-slate-900">
                    {f.title}
                  </span>
                  <span className="text-slate-500"> — {f.detail}</span>
                  {f.recommendation && (
                    <div className="mt-0.5 text-slate-600">
                      <span className="font-semibold">Fix:</span>{" "}
                      {f.recommendation}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

/* ------------------------------- draft -------------------------------- */

function DraftCard({ data }: { data: DraftOutput }) {
  return (
    <CardShell label="Draft" title={data.title}>
      <pre className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs leading-5 text-slate-700">
        {data.body}
      </pre>
    </CardShell>
  );
}

/* ------------------------- recommendation list ------------------------ */

function RecommendationListCard({
  data,
}: {
  data: RecommendationListOutput;
}) {
  return (
    <CardShell label="Recommendations" title={data.title}>
      <ul className="space-y-2">
        {data.items.map((item, i) => (
          <li
            key={i}
            className="flex items-start gap-2 rounded-lg border border-slate-100 p-3"
          >
            {item.priority && (
              <span
                className={
                  "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                  (item.priority === "high"
                    ? "bg-rose-50 text-rose-700"
                    : item.priority === "medium"
                      ? "bg-amber-50 text-amber-700"
                      : "bg-slate-100 text-slate-600")
                }
              >
                {item.priority}
              </span>
            )}
            <div className="flex-1">
              <div className="text-sm font-semibold text-slate-900">
                {item.title}
              </div>
              <div className="text-xs text-slate-600">{item.detail}</div>
            </div>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

/* --------------------------- experiment plan -------------------------- */

function ExperimentPlanCard({ data }: { data: ExperimentPlanOutput }) {
  return (
    <CardShell label="Experiment plan" title={data.title}>
      <dl className="space-y-2 text-xs">
        <div>
          <dt className="font-semibold text-slate-700">Hypothesis</dt>
          <dd className="text-slate-600">{data.hypothesis}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-700">Metric</dt>
          <dd className="text-slate-600">{data.metric}</dd>
        </div>
        {data.successCriteria && (
          <div>
            <dt className="font-semibold text-slate-700">Success criteria</dt>
            <dd className="text-slate-600">{data.successCriteria}</dd>
          </div>
        )}
        {data.durationDays && (
          <div>
            <dt className="font-semibold text-slate-700">Duration</dt>
            <dd className="text-slate-600">{data.durationDays} days</dd>
          </div>
        )}
      </dl>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
        {data.variants.map((v, i) => (
          <div
            key={i}
            className="rounded-lg border border-slate-200 bg-slate-50 p-3"
          >
            <div className="text-sm font-semibold text-slate-900">{v.name}</div>
            <div className="text-xs text-slate-600">{v.description}</div>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

/* --------------------------- email sequence --------------------------- */

function EmailSequenceCard({ data }: { data: EmailSequenceOutput }) {
  return (
    <CardShell
      label="Email sequence"
      title={data.title}
      subtitle={`Audience: ${data.audience}`}
    >
      <ol className="space-y-3">
        {data.steps.map((s) => (
          <li
            key={s.stepNumber}
            className="rounded-lg border border-slate-200 p-3"
          >
            <div className="flex items-center justify-between">
              <div className="text-sm font-semibold text-slate-900">
                Step {s.stepNumber}
              </div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                {s.delayHours === 0
                  ? "Day 1"
                  : `+${Math.round(s.delayHours / 24)}d`}
              </div>
            </div>
            <div className="mt-1 text-xs">
              <span className="font-semibold text-slate-700">Subject:</span>{" "}
              <span className="text-slate-900">{s.subject}</span>
            </div>
            <p className="mt-2 whitespace-pre-wrap text-xs leading-5 text-slate-600">
              {s.body}
            </p>
            {s.cta && (
              <div className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-indigo-600">
                CTA: {s.cta}
              </div>
            )}
          </li>
        ))}
      </ol>
    </CardShell>
  );
}

/* ----------------------------- ad variants ---------------------------- */

function AdVariantsCard({ data }: { data: AdVariantsOutput }) {
  return (
    <CardShell
      label="Ad variants"
      title={data.title}
      subtitle={data.platform}
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {data.variants.map((v, i) => (
          <div
            key={i}
            className="rounded-lg border border-slate-200 bg-slate-50 p-3"
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {v.name}
            </div>
            <div className="mt-1 text-sm font-semibold text-slate-900">
              {v.headline}
            </div>
            <div className="text-xs text-slate-600">{v.description}</div>
            {v.cta && (
              <div className="mt-2 inline-block rounded-md bg-indigo-600 px-2 py-1 text-[10px] font-semibold uppercase text-white">
                {v.cta}
              </div>
            )}
          </div>
        ))}
      </div>
    </CardShell>
  );
}

/* -------------------------- content calendar -------------------------- */

function ContentCalendarCard({ data }: { data: ContentCalendarOutput }) {
  return (
    <CardShell label="Content calendar" title={data.title}>
      <ul className="space-y-2">
        {data.items.map((it, i) => (
          <li key={i} className="flex items-start gap-3 text-xs">
            <div className="shrink-0 rounded-md bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
              {it.date.slice(0, 10)}
            </div>
            <div className="shrink-0 rounded-md bg-indigo-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-indigo-700">
              {it.channel}
            </div>
            <div className="flex-1">
              <div className="font-semibold text-slate-900">{it.title}</div>
              <div className="text-slate-600">{it.summary}</div>
            </div>
          </li>
        ))}
      </ul>
    </CardShell>
  );
}

/* ------------------------- competitor profile ------------------------- */

function CompetitorProfileCard({ data }: { data: CompetitorProfileOutput }) {
  return (
    <CardShell
      label="Competitive intelligence"
      title={data.title}
      subtitle="Scan the gaps, advantages, and next moves without reading the full draft."
    >
      <div className="space-y-4">
        {data.competitors.map((c, i) => (
          <details
            key={i}
            open={i === 0}
            className="group rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
          >
            <summary className="flex cursor-pointer list-none items-start justify-between gap-4">
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  {c.name}
                </div>
                <p className="mt-1 max-w-3xl text-xs leading-5 text-slate-600">
                  {c.positioning}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <a
                  href={c.url}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
                >
                  Visit
                </a>
                <span className="text-xs font-semibold text-slate-400 group-open:hidden">
                  Expand
                </span>
                <span className="hidden text-xs font-semibold text-slate-400 group-open:inline">
                  Collapse
                </span>
              </div>
            </summary>

            <div className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-3">
              <IntelColumn
                label="You may be ahead"
                tone="good"
                items={c.yourAdvantages ?? []}
                fallback="No clear advantage captured yet."
              />
              <IntelColumn
                label="Gaps to fix"
                tone="risk"
                items={c.yourGaps ?? c.weaknesses}
                fallback="No clear gap captured yet."
              />
              <IntelColumn
                label="Quick wins"
                tone="action"
                items={c.quickWins ?? []}
                fallback="No quick win captured yet."
              />
            </div>

            <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-100 pt-4 sm:grid-cols-2">
              <IntelColumn
                label="Competitor strengths"
                tone="neutral"
                items={c.strengths}
                fallback="No strengths captured."
              />
              <IntelColumn
                label="Competitor weaknesses"
                tone="neutral"
                items={c.weaknesses}
                fallback="No weaknesses captured."
              />
            </div>
          </details>
        ))}
      </div>
    </CardShell>
  );
}

function IntelColumn({
  label,
  tone,
  items,
  fallback,
}: {
  label: string;
  tone: "good" | "risk" | "action" | "neutral";
  items: string[];
  fallback: string;
}) {
  const palette =
    tone === "good"
      ? { card: "border-emerald-200 bg-emerald-50/40", label: "text-emerald-700", dot: "bg-emerald-500", badge: "bg-emerald-100 text-emerald-700" }
      : tone === "risk"
        ? { card: "border-rose-200 bg-rose-50/40", label: "text-rose-700", dot: "bg-rose-500", badge: "bg-rose-100 text-rose-700" }
        : tone === "action"
          ? { card: "border-indigo-200 bg-indigo-50/40", label: "text-indigo-700", dot: "bg-indigo-500", badge: "bg-indigo-100 text-indigo-700" }
          : { card: "border-slate-200 bg-slate-50", label: "text-slate-600", dot: "bg-slate-400", badge: "bg-slate-200 text-slate-600" };
  const empty = items.length === 0;

  return (
    <div className={`rounded-lg border p-3.5 ${palette.card}`}>
      <div className="flex items-center justify-between gap-2">
        <div className={`text-[10px] font-semibold uppercase tracking-wider ${palette.label}`}>
          {label}
        </div>
        {!empty ? (
          <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${palette.badge}`}>
            {items.length}
          </span>
        ) : null}
      </div>
      {empty ? (
        <p className="mt-2 text-xs leading-5 text-slate-500">{fallback}</p>
      ) : (
        <ul className="mt-2.5 space-y-2">
          {items.map((item, index) => (
            <li key={index} className="flex gap-2 text-xs leading-5 text-slate-700">
              <span className={`mt-2 h-1.5 w-1.5 shrink-0 rounded-full ${palette.dot}`} aria-hidden />
              <span className="min-w-0 wrap-break-word">{item}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* -------------------------- launch checklist -------------------------- */

function LaunchChecklistCard({ data }: { data: LaunchChecklistOutput }) {
  return (
    <CardShell
      label="Launch checklist"
      title={data.title}
      subtitle={data.launchDate ? `Launch: ${data.launchDate}` : undefined}
    >
      <div className="space-y-3">
        {data.groups.map((g, gi) => (
          <div key={gi}>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
              {g.label}
            </div>
            <ul className="mt-1 space-y-1">
              {g.items.map((it, i) => (
                <li key={i} className="flex items-start gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={!!it.done}
                    readOnly
                    className="mt-0.5"
                  />
                  <span
                    className={
                      it.done
                        ? "text-slate-400 line-through"
                        : "text-slate-700"
                    }
                  >
                    {it.task}
                    {it.owner && (
                      <span className="ml-1 text-slate-400">
                        · {it.owner}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </CardShell>
  );
}

/* -------------------------- approval request -------------------------- */

function ApprovalRequestCard({ data }: { data: ApprovalRequestOutput }) {
  return (
    <CardShell label="Approval request" title={data.title}>
      <dl className="space-y-2 text-xs">
        <div>
          <dt className="font-semibold text-slate-700">What will happen</dt>
          <dd className="text-slate-600">{data.whatWillHappen}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-700">Why</dt>
          <dd className="text-slate-600">{data.why}</dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-700">Risk</dt>
          <dd>
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider " +
                (data.risk === "high"
                  ? "bg-rose-50 text-rose-700"
                  : data.risk === "medium"
                    ? "bg-amber-50 text-amber-700"
                    : "bg-emerald-50 text-emerald-700")
              }
            >
              {data.risk}
            </span>
          </dd>
        </div>
        <div>
          <dt className="font-semibold text-slate-700">Rollback plan</dt>
          <dd className="text-slate-600">{data.rollbackPlan}</dd>
        </div>
      </dl>
    </CardShell>
  );
}
