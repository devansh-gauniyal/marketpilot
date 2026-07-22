import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
  process.env.MARKETPILOT_DB_PATH = path.join(
    os.tmpdir(),
    "marketpilot-tests",
    `maintenance-test-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`,
  );

  const { eventsStore, skillRunsStore } = await import("../index.js");
  const {
    databaseHealth,
    exportDatabaseSnapshot,
    writeDatabaseBackup,
  } = await import("../sqlite.js");

  const run = skillRunsStore.create("maintenance-run-1", "seo-audit", {
    campaignGoal: "Check persistence controls",
  });
  eventsStore.append("maintenance_test_event", { skillRunId: run.taskId });

  const health = databaseHealth();
  assert(health.databasePath.endsWith(".sqlite"), "health reports database path");
  assert(health.tableCounts.skill_runs >= 1, "health counts skill runs");
  assert(health.tableCounts.events >= 1, "health counts events");

  const snapshot = exportDatabaseSnapshot();
  assert(snapshot.tables.skill_runs.length >= 1, "export includes skill runs");
  assert(snapshot.tables.events.length >= 1, "export includes events");
  assert(snapshot.tableCounts.skill_runs === health.tableCounts.skill_runs, "export includes table counts");

  const backup = writeDatabaseBackup();
  assert(existsSync(backup.backupPath), "backup writes a JSON file");
  assert(backup.tableCounts.events >= 1, "backup returns table counts");

  console.log("Database maintenance tests passed.");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
