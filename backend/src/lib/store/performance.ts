// Performance snapshots. One row per day per workspace — a thin time-series.
// The agent reads recent rows as memory context before each run; the
// scheduler writes a new row daily once analytics connectors land (Step 6).

import type { PerformanceSnapshot } from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspaces";
import { getJson, listJson, putJson } from "./sqlite";

// Key = `${workspaceId}:${date}` so we can upsert one row per day.
function key(workspaceId: string, date: string): string {
  return `${workspaceId}:${date}`;
}

export const performanceStore = {
  upsert(snapshot: PerformanceSnapshot): PerformanceSnapshot {
    return putJson("performance_snapshots", key(snapshot.workspaceId, snapshot.date), snapshot, {
      workspaceId: snapshot.workspaceId,
      date: snapshot.date,
    });
  },

  get(
    date: string,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): PerformanceSnapshot | undefined {
    return getJson<PerformanceSnapshot>("performance_snapshots", key(workspaceId, date));
  },

  recent(
    days: number,
    workspaceId: string = DEFAULT_WORKSPACE_ID,
  ): PerformanceSnapshot[] {
    return listJson<PerformanceSnapshot>("performance_snapshots", {
      workspaceId,
      orderBy: "date_desc",
      limit: days,
    });
  },
};
