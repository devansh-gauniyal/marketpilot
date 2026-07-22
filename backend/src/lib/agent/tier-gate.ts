// Tier gate. The single guard the agent loop calls BEFORE every tool dispatch.
//
// Framework rule §5.2: "Tier checks happen at the gate, never inside the tool
// body. Tools assume they're authorized when called."
//
// Inputs:  toolName + input + skillRunId
// Outputs: a decision { kind, tier, ... } the loop branches on
//
//   GREEN  → { kind: "execute" }                 (run it, no notify)
//   YELLOW → { kind: "execute-and-notify" }      (run it, log a notify event)
//   RED    → { kind: "blocked", approvalId }     (do NOT run; create an approval)
//
// The gate also writes one `tool_gated` event to the log every time it's
// called. That trail is what the Activity feed will eventually read from.

import { toolMeta } from "../agent-tools";
import {
  approvalsStore,
  DEFAULT_WORKSPACE_ID,
  eventsStore,
  skillRunsStore,
  type Tier,
} from "../store";

export type GateDecision =
  | { kind: "execute"; tier: "GREEN" }
  | { kind: "execute-and-notify"; tier: "YELLOW" }
  | { kind: "blocked"; tier: "RED"; approvalId: string };

// Resolve a tool's tier — supports static and dynamic (input-dependent) tiers.
// Unknown tool → RED. We fail closed: any tool that isn't registered in
// toolMeta cannot auto-execute.
export function resolveTier(
  toolName: string,
  input: Record<string, unknown>,
): Tier {
  const meta = toolMeta[toolName];
  if (!meta) return "RED";
  return typeof meta.tier === "function" ? meta.tier(input) : meta.tier;
}

export function tierGate(args: {
  skillRunId: string;
  toolName: string;
  input: Record<string, unknown>;
}): GateDecision {
  const tier = resolveTier(args.toolName, args.input);
  const workspaceId = skillRunsStore.get(args.skillRunId)?.workspaceId ?? DEFAULT_WORKSPACE_ID;

  if (tier === "GREEN") {
    eventsStore.append("tool_gated", {
      skillRunId: args.skillRunId,
      toolName: args.toolName,
      tier,
      decision: "execute",
    }, workspaceId);
    return { kind: "execute", tier };
  }

  if (tier === "YELLOW") {
    eventsStore.append("tool_gated", {
      skillRunId: args.skillRunId,
      toolName: args.toolName,
      tier,
      decision: "execute-and-notify",
    }, workspaceId);
    return { kind: "execute-and-notify", tier };
  }

  // RED — create an approval and block the call.
  const approvalTitle =
    typeof args.input.approvalTitle === "string"
      ? args.input.approvalTitle
      : `Approve ${args.toolName}`;
  const approvalSummary =
    typeof args.input.approvalSummary === "string"
      ? args.input.approvalSummary
      : `Agent wants to call ${args.toolName}.`;
  const approvalReasoning =
    typeof args.input.approvalReasoning === "string"
      ? args.input.approvalReasoning
      : "Tier RED — human approval required by framework rule §5.3 (no rollback available or stakes too high).";
  const expectedImpact =
    typeof args.input.expectedImpact === "string"
      ? args.input.expectedImpact
      : "Unknown";
  const rollbackPlan =
    typeof args.input.rollbackPlan === "string"
      ? args.input.rollbackPlan
      : "Reject the approval — no execution will occur.";
  const proposedActionJson =
    isRecord(args.input.proposedActionJson)
      ? args.input.proposedActionJson
      : { toolName: args.toolName, input: args.input };

  const approval = approvalsStore.create({
    workspaceId,
    skillRunId: args.skillRunId,
    toolCallId: "", // populated once we promote tool calls to the store (Step 3+)
    title: approvalTitle,
    summary: approvalSummary,
    reasoning: approvalReasoning,
    proposedActionJson,
    expectedImpact,
    rollbackPlan,
  });

  eventsStore.append("tool_gated", {
    skillRunId: args.skillRunId,
    toolName: args.toolName,
    tier,
    decision: "blocked",
    approvalId: approval.id,
  }, workspaceId);

  return { kind: "blocked", tier, approvalId: approval.id };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
