// Tool calls store. One record per tool invocation. Carries the rollback
// payload (rule §5.3) and verification result (rule §5.4). Populated at
// Step 2 when the tier gate goes in.

import type { ToolCall } from "./types";
import { getJson, listJson, putJson } from "./sqlite";

function saveToolCall(call: ToolCall): ToolCall {
  return putJson("tool_calls", call.id, call, {
    skillRunId: call.skillRunId,
    status: call.status,
    type: call.toolName,
    createdAt: call.executedAt,
  });
}

export const toolCallsStore = {
  create(input: Omit<ToolCall, "id">): ToolCall {
    const call: ToolCall = { id: crypto.randomUUID(), ...input };
    return saveToolCall(call);
  },

  get(id: string): ToolCall | undefined {
    return getJson<ToolCall>("tool_calls", id);
  },

  listForRun(skillRunId: string): ToolCall[] {
    return listJson<ToolCall>("tool_calls", { skillRunId });
  },

  listAll(): ToolCall[] {
    return listJson<ToolCall>("tool_calls");
  },

  update(id: string, updates: Partial<ToolCall>): ToolCall | undefined {
    const call = this.get(id);
    if (!call) return undefined;
    const next = { ...call, ...updates };
    return saveToolCall(next);
  },
};
