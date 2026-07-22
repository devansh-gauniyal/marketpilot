// Event log. Append-only. Every meaningful event — tool calls, plans,
// approvals, verification failures, rollbacks, LLM calls — goes here.
// Required by root AGENTS.md §5.10 ("All LLM calls are logged").
// Routes never console.log business data; they emit events here.

import type { AgentEvent } from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspaces";
import { listJson, putJson } from "./sqlite";

export const eventsStore = {
  append(
    type: string,
    payload: unknown,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): AgentEvent {
    const event: AgentEvent = {
      id: crypto.randomUUID(),
      workspaceId,
      type,
      payload,
      createdAt: new Date().toISOString(),
    };
    return putJson("events", event.id, event, {
      workspaceId: event.workspaceId,
      type: event.type,
      createdAt: event.createdAt,
    });
  },

  // Read the tail of the log, newest first.
  tail(
    limit = 100,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
    since?: string,
  ): AgentEvent[] {
    let view = listJson<AgentEvent>("events", {
      workspaceId,
      orderBy: "created_at_desc",
      limit: since ? undefined : limit,
    });
    if (since) view = view.filter((e) => e.createdAt > since);
    return view.slice(0, limit);
  },
};
