import {
  approvalsStore,
  DEFAULT_WORKSPACE_ID,
  eventsStore,
  skillRunsStore,
  toolCallsStore,
  type GeminiContent,
  type ProposedAction,
} from "./store";
import { toolDeclarations, executeTool } from "./agent-tools";
import { tierGate } from "./agent";
import { loadMemory, renderMemoryForPrompt } from "./memory/load";
import { allowedToolsFor } from "./skills/manifest";
import { getSkill } from "./skills/catalog";
import { runSeoAuditOrchestrator } from "./agent/seo-orchestrator";
import { runCompetitorProfilingOrchestrator } from "./agent/competitor-orchestrator";

const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";

const MAX_ITERATIONS = 12;

function buildInitialPrompt(
  _skillId: string,
  skillContent: string,
  inputContext: Record<string, string>,
  memoryText: string,
): string {
  return [
    "You are MarketPilot AI, an autonomous marketing agent.",
    "MarketPilot AI is the software running this workflow. It is NOT automatically the user's product or brand.",
    "",
    "Complete this marketing task end-to-end. Do all research, analysis, and content drafting yourself — do not ask the user for mid-flow approvals.",
    "",
    memoryText,
    "",
    "SKILL INSTRUCTIONS (follow these):",
    skillContent,
    "",
    "RUN BRIEF (structured user input):",
    JSON.stringify(inputContext, null, 2),
    "",
    "WORKFLOW:",
    "1. Use web_search and read_url to gather real information about the audience, channels, and trends relevant to this campaign. For SEO-related tasks use audit_seo (full audit + structured findings) or crawl_site (parsed page data) — they return STRUCTURED fields instead of raw text.",
    "2. Use write_draft to save deliverables (copy, content, plans). Save freely — these are the user's outputs.",
    "3. Handle any dependent sub-tasks internally (e.g., if marketing-ideas needs to reason about budget allocation, do it yourself — do not ask the user).",
    "4. Call finish() with executiveSummary, findings, recommendations, nextSteps, and proposedActions.",
    "",
    "RULES:",
    "- Never ask the user mid-flow. Be autonomous.",
    "- Proposed actions are only for real executable work the system could perform after approval, such as sending an email, publishing content, launching an ad, or updating SEO. For research/reporting skills, use an empty proposedActions array and put advice in recommendations/nextSteps.",
    `- You have up to ${MAX_ITERATIONS} tool calls. Use them efficiently — research, draft, finish.`,
    "- Reference real findings from your research in your drafts and recommendations.",
  ].join("\n");
}

export async function runAgentLoop(
  taskId: string,
  skillContent: string,
): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    skillRunsStore.update(taskId, {
      status: "failed",
      error: "GEMINI_API_KEY is not set in backend/.env",
    });
    return;
  }

  const task = skillRunsStore.get(taskId);
  if (!task) return;

  // === seo-audit is fully orchestrated (no LLM in the driver's seat) ===
  // The orchestrator scripts: audit live URL → scan repo → ask Gemini for copy
  // → open ONE PR → finalize. This replaces the previous non-deterministic
  // LLM-driven path that sometimes never called add_alt_text. Other skills
  // keep the generic loop below.
  if (task.skillId === "seo-audit") {
    await runSeoAuditOrchestrator(taskId, skillContent);
    return;
  }

  // === competitor-profiling is also orchestrated ===
  // The orchestrator scripts: crawl each competitor → optionally crawl the
  // user's product → ask Gemini ONCE for typed JSON → validate → build markdown
  // draft from the JSON → finalize. Replaces the previous loop that asked the
  // LLM to write markdown and then regex-parsed the markdown back.
  if (task.skillId === "competitor-profiling") {
    await runCompetitorProfilingOrchestrator(taskId, skillContent);
    return;
  }

  // === Step 6: load memory before the agent starts ===
  // Profile + recent audits + recent performance get rendered into the prompt
  // so the agent never works from a cold context.
  const memory = loadMemory(task.workspaceId);
  const memoryText = renderMemoryForPrompt(memory, {
    currentSkillId: task.skillId,
  });

  eventsStore.append("memory_loaded", {
    skillRunId: taskId,
    hasProfile: !!memory.profile,
    audits: memory.recentAudits.length,
    performanceDays: memory.recentPerformance.length,
  }, task.workspaceId);

  const contents: GeminiContent[] = [
    {
      role: "user",
      parts: [
        {
          text: buildInitialPrompt(
            task.skillId,
            skillContent,
            task.inputContext,
            memoryText,
          ),
        },
      ],
    },
  ];

  // Filter toolDeclarations to only the tools this skill is allowed to use.
  // Framework rule §5.6 — skills declare which tools they need.
  const allowed = new Set(allowedToolsFor(task.skillId));
  const filtered = {
    functionDeclarations: toolDeclarations.functionDeclarations.filter((d) =>
      allowed.has(d.name),
    ),
  };

  eventsStore.append("skill_tools_filtered", {
    skillRunId: taskId,
    skillId: task.skillId,
    allowed: filtered.functionDeclarations.map((d) => d.name),
  }, task.workspaceId);

  await runLoop(taskId, contents, apiKey, filtered);
}

// Convert raw proposedActions from the agent into the canonical shape used
// on the SkillRun's finalReport — AND mirror each one into the approvalsStore
// so the Approvals Inbox UI (Step 4) can show them as first-class records.
//
// We store the actionId we generated here on BOTH the proposedAction and the
// new Approval, so the two records can be linked later (approve in the inbox
// → eventually update the proposedAction's status too).
function attachActionIds(
  raw: Array<{ type: string; title: string; description: string }>,
  skillRunId: string,
  workspaceId: string,
): ProposedAction[] {
  return raw.map((a) => {
    const actionId = crypto.randomUUID();

    approvalsStore.create({
      workspaceId,
      skillRunId,
      toolCallId: actionId, // reuse the actionId as a stable link for now
      title: a.title,
      summary: a.description,
      reasoning: `Proposed by agent at end of skill run ${skillRunId}.`,
      proposedActionJson: {
        actionId,
        type: a.type,
        title: a.title,
        description: a.description,
      },
      expectedImpact: "See description.",
      rollbackPlan: "Reject the approval — no execution will occur.",
    });

    return {
      actionId,
      type: a.type,
      title: a.title,
      description: a.description,
      status: "pending",
    };
  });
}

async function runLoop(
  taskId: string,
  contents: GeminiContent[],
  apiKey: string,
  tools: typeof toolDeclarations = toolDeclarations,
): Promise<void> {
  let iterations = 0;
  const task = skillRunsStore.get(taskId);
  const workspaceId = task?.workspaceId ?? DEFAULT_WORKSPACE_ID;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    let responseJson: unknown;

    try {
      const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents,
          tools: [tools],
          generationConfig: { temperature: 0.4 },
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        skillRunsStore.update(taskId, {
          status: "failed",
          error: `Gemini API error (${res.status}): ${errText.slice(0, 300)}`,
        });
        return;
      }

      responseJson = await res.json();
    } catch (err) {
      skillRunsStore.update(taskId, {
        status: "failed",
        error: `Network error: ${err instanceof Error ? err.message : "unknown"}`,
      });
      return;
    }

    const resp = responseJson as Record<string, unknown>;
    const candidate = (resp?.candidates as Record<string, unknown>[])?.[0];
    const contentObj = candidate?.content as Record<string, unknown> | undefined;
    const parts = contentObj?.parts as unknown[] | undefined;

    if (!parts || parts.length === 0) {
      skillRunsStore.update(taskId, {
        status: "failed",
        error: "Gemini returned an empty response.",
      });
      return;
    }

    contents.push({ role: "model", parts });

    const functionCallPart = parts.find(
      (p) => (p as Record<string, unknown>).functionCall,
    ) as Record<string, unknown> | undefined;

    if (!functionCallPart) {
      // No function call — wrap up with whatever text came back.
      const textPart = parts.find(
        (p) => typeof (p as Record<string, unknown>).text === "string",
      ) as Record<string, unknown> | undefined;

      const currentTask = skillRunsStore.get(taskId);
      skillRunsStore.update(taskId, {
        status: "completed",
        finalReport: {
          executiveSummary:
            (textPart?.text as string) ??
            "Task completed without a structured report.",
          findings: [],
          recommendations: [],
          nextSteps: [],
          drafts: currentTask?.drafts ?? [],
          proposedActions: [],
        },
      });
      return;
    }

    const { name, args } = functionCallPart.functionCall as {
      name: string;
      args: Record<string, unknown>;
    };

    skillRunsStore.addStep(taskId, {
      type: "tool_call",
      toolName: name,
      toolArgs: args,
      content: `Using tool: ${name}`,
    });

    if (name === "finish") {
      const currentTask = skillRunsStore.get(taskId);
      const executiveSummary = (args.executiveSummary as string) ?? "";
      const findings = (args.findings as string[]) ?? [];
      const recommendations = (args.recommendations as string[]) ?? [];
      const nextSteps = (args.nextSteps as string[]) ?? [];
      const rawActions =
        (args.proposedActions as Array<{
          type: string;
          title: string;
          description: string;
        }>) ?? [];
      const skillEntry = currentTask ? getSkill(currentTask.skillId) : undefined;
      const shouldCreateApprovals = skillEntry
        ? skillEntry.defaultApprovalBehavior !== "drafts-only"
        : true;
      const nextStepsForReport = shouldCreateApprovals
        ? nextSteps
        : [
            ...nextSteps,
            ...rawActions.map((action) =>
              `${action.title}: ${action.description}`,
            ),
          ];

      // Structured outputs are produced by per-skill orchestrators (e.g.
      // seo-audit, competitor-profiling) — not by the generic loop. The
      // generic loop just returns the plain finalReport shape.
      skillRunsStore.update(taskId, {
        status: "completed",
        finalReport: {
          executiveSummary,
          findings,
          recommendations,
          nextSteps: nextStepsForReport,
          drafts: currentTask?.drafts ?? [],
          proposedActions: shouldCreateApprovals
            ? attachActionIds(
                rawActions,
                taskId,
                currentTask?.workspaceId ?? workspaceId,
              )
            : [],
        },
      });
      return;
    }

    // === Tier gate ===
    // Before dispatching, ask the gate what tier this call is and whether
    // we're even allowed to execute it. RED-tier calls produce an approval
    // record and DO NOT execute — we tell Gemini the call was blocked and
    // let it choose another path (or call finish).
    const decision = tierGate({ skillRunId: taskId, toolName: name, input: args });

    if (decision.kind === "blocked") {
      const blockedMessage =
        `This action requires user approval (approvalId: ${decision.approvalId}). ` +
        `It has NOT been executed. Continue with a different approach or call finish().`;

      skillRunsStore.addStep(taskId, {
        type: "tool_result",
        toolName: name,
        content: `BLOCKED (RED tier): ${blockedMessage}`,
      });

      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name,
              response: { result: blockedMessage },
            },
          },
        ],
      });
      continue;
    }

    // GREEN or YELLOW — execute.
    const toolResult = await executeTool(taskId, name, args);

    if (decision.kind === "execute-and-notify") {
      // YELLOW: log a notify event so the Activity feed (and, later, Slack)
      // can surface it. Reversible, but the user should see it happened.
      eventsStore.append("tool_executed_notify", {
        skillRunId: taskId,
        toolName: name,
        tier: decision.tier,
      }, workspaceId);

      // If the tool returned a rollback payload, persist a ToolCall record so
      // the rollback endpoint can undo it later. Framework rule §5.3: every
      // write tool persists rollbackPayload.
      if (toolResult.rollbackPayload !== undefined) {
        toolCallsStore.create({
          skillRunId: taskId,
          toolName: name,
          tier: "YELLOW",
          inputJson: args,
          outputJson: { result: toolResult.result, changeId: toolResult.changeId },
          rollbackPayloadJson: toolResult.rollbackPayload,
          status: "executed",
          executedAt: new Date().toISOString(),
        });
      }
    }

    skillRunsStore.addStep(taskId, {
      type: "tool_result",
      toolName: name,
      content: toolResult.result.slice(0, 500),
    });

    contents.push({
      role: "user",
      parts: [
        {
          functionResponse: {
            name,
            response: toolResult,
          },
        },
      ],
    });
  }

  // Hit max iterations — wrap up gracefully.
  const currentTask = skillRunsStore.get(taskId);
  skillRunsStore.update(taskId, {
    status: "completed",
    finalReport: {
      executiveSummary:
        "Agent reached the maximum number of steps. Results gathered so far are below.",
      findings: [],
      recommendations: ["Re-run with a more focused brief to finish remaining work."],
      nextSteps: [],
      drafts: currentTask?.drafts ?? [],
      proposedActions: [],
    },
  });
}
