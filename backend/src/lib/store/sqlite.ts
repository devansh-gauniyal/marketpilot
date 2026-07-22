import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type RunResult = {
  changes: number;
  lastInsertRowid: number | bigint;
};

type Statement = {
  run: (...params: unknown[]) => RunResult;
  get: (...params: unknown[]) => unknown;
  all: (...params: unknown[]) => unknown[];
};

type SqliteDatabase = {
  exec: (sql: string) => void;
  pragma: (sql: string) => unknown;
  prepare: (sql: string) => Statement;
};

type BetterSqliteConstructor = new (filename: string) => SqliteDatabase;

const BetterSqlite = require("better-sqlite3") as BetterSqliteConstructor;

export type JsonTable =
  | "users"
  | "workspaces"
  | "workspace_members"
  | "product_profiles"
  | "connections"
  | "skill_runs"
  | "tool_calls"
  | "approvals"
  | "audits"
  | "performance_snapshots"
  | "events";

type JsonIndexes = {
  workspaceId?: string;
  skillRunId?: string;
  status?: string;
  type?: string;
  date?: string;
  createdAt?: string;
  updatedAt?: string;
};

type ListFilter = {
  workspaceId?: string;
  skillRunId?: string;
  status?: string;
  type?: string;
  date?: string;
  orderBy?: "created_at_desc" | "created_at_asc" | "updated_at_desc" | "date_desc";
  limit?: number;
};

type JsonRow = {
  json: string;
};

export const JSON_TABLES: JsonTable[] = [
  "users",
  "workspaces",
  "workspace_members",
  "product_profiles",
  "connections",
  "skill_runs",
  "tool_calls",
  "approvals",
  "audits",
  "performance_snapshots",
  "events",
];

const configuredDbPath = process.env.MARKETPILOT_DB_PATH?.trim();
const legacyProjectDbPath = path.resolve(process.cwd(), "data", "marketpilot.sqlite");
const dbPath = configuredDbPath
  ? resolveConfiguredDatabasePath(configuredDbPath)
  : defaultLocalDatabasePath();

mkdirSync(path.dirname(dbPath), { recursive: true });
migrateLegacyProjectDatabase(dbPath);

export const sqlite = new BetterSqlite(dbPath);

try {
  sqlite.pragma("journal_mode = WAL");
} catch {
  // OneDrive/Windows can block SQLite WAL cleanup on local dev machines.
  // Keep the rollback journal in memory so startup does not depend on
  // creating/deleting extra files in a synced folder.
  sqlite.pragma("journal_mode = MEMORY");
}
sqlite.pragma("foreign_keys = ON");

export type DatabaseHealth = {
  databasePath: string;
  tableCounts: Record<JsonTable, number>;
  checkedAt: string;
};

export type DatabaseExportSnapshot = {
  exportedAt: string;
  databasePath: string;
  tableCounts: Record<JsonTable, number>;
  tables: Record<JsonTable, unknown[]>;
};

export type DatabaseBackupResult = {
  backupPath: string;
  exportedAt: string;
  tableCounts: Record<JsonTable, number>;
};

for (const table of JSON_TABLES) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT PRIMARY KEY,
      workspace_id TEXT,
      skill_run_id TEXT,
      status TEXT,
      type TEXT,
      date TEXT,
      created_at TEXT,
      updated_at TEXT,
      json TEXT NOT NULL
    );
  `);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_workspace ON ${table}(workspace_id);`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_skill_run ON ${table}(skill_run_id);`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_status ON ${table}(status);`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_type ON ${table}(type);`);
  sqlite.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_created_at ON ${table}(created_at);`);
}

export function putJson<T>(
  table: JsonTable,
  id: string,
  value: T,
  indexes: JsonIndexes = {},
): T {
  sqlite.prepare(`
    INSERT INTO ${table} (
      id,
      workspace_id,
      skill_run_id,
      status,
      type,
      date,
      created_at,
      updated_at,
      json
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      skill_run_id = excluded.skill_run_id,
      status = excluded.status,
      type = excluded.type,
      date = excluded.date,
      created_at = excluded.created_at,
      updated_at = excluded.updated_at,
      json = excluded.json
  `).run(
    id,
    indexes.workspaceId,
    indexes.skillRunId,
    indexes.status,
    indexes.type,
    indexes.date,
    indexes.createdAt,
    indexes.updatedAt,
    JSON.stringify(value),
  );
  return value;
}

export function getJson<T>(table: JsonTable, id: string): T | undefined {
  const row = sqlite.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id);
  return readJsonRow<T>(row);
}

export function listJson<T>(table: JsonTable, filter: ListFilter = {}): T[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  addClause(clauses, params, "workspace_id", filter.workspaceId);
  addClause(clauses, params, "skill_run_id", filter.skillRunId);
  addClause(clauses, params, "status", filter.status);
  addClause(clauses, params, "type", filter.type);
  addClause(clauses, params, "date", filter.date);

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  const orderBy = orderBySql(filter.orderBy);
  const limit = filter.limit ? " LIMIT ?" : "";
  if (filter.limit) params.push(filter.limit);

  const rows = sqlite.prepare(`SELECT json FROM ${table}${where}${orderBy}${limit}`).all(...params);
  return rows
    .map((row) => readJsonRow<T>(row))
    .filter((record): record is T => record !== undefined);
}

export function databaseHealth(): DatabaseHealth {
  return {
    databasePath: dbPath,
    tableCounts: tableCounts(),
    checkedAt: new Date().toISOString(),
  };
}

export function exportDatabaseSnapshot(): DatabaseExportSnapshot {
  const tables = Object.fromEntries(
    JSON_TABLES.map((table) => [table, listJson<unknown>(table)]),
  ) as Record<JsonTable, unknown[]>;

  return {
    exportedAt: new Date().toISOString(),
    databasePath: dbPath,
    tableCounts: tableCounts(),
    tables,
  };
}

export function writeDatabaseBackup(): DatabaseBackupResult {
  const snapshot = exportDatabaseSnapshot();
  const backupDir = path.resolve(process.cwd(), "data", "backups");
  mkdirSync(backupDir, { recursive: true });

  const timestamp = snapshot.exportedAt.replace(/[:.]/g, "-");
  const backupPath = path.join(backupDir, `marketpilot-backup-${timestamp}.json`);
  writeFileSync(backupPath, JSON.stringify(snapshot, null, 2), "utf8");

  return {
    backupPath,
    exportedAt: snapshot.exportedAt,
    tableCounts: snapshot.tableCounts,
  };
}

function tableCounts(): Record<JsonTable, number> {
  return Object.fromEntries(
    JSON_TABLES.map((table) => {
      const row = sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get();
      return [table, isCountRow(row) ? row.count : 0];
    }),
  ) as Record<JsonTable, number>;
}

function addClause(
  clauses: string[],
  params: unknown[],
  column: string,
  value?: string,
): void {
  if (!value) return;
  clauses.push(`${column} = ?`);
  params.push(value);
}

function orderBySql(orderBy?: ListFilter["orderBy"]): string {
  if (orderBy === "created_at_asc") return " ORDER BY created_at ASC";
  if (orderBy === "updated_at_desc") return " ORDER BY updated_at DESC";
  if (orderBy === "date_desc") return " ORDER BY date DESC";
  return " ORDER BY created_at DESC";
}

function readJsonRow<T>(row: unknown): T | undefined {
  if (!isJsonRow(row)) return undefined;
  return JSON.parse(row.json) as T;
}

function isJsonRow(row: unknown): row is JsonRow {
  return typeof row === "object" && row !== null && "json" in row && typeof row.json === "string";
}

function isCountRow(row: unknown): row is { count: number } {
  return typeof row === "object" && row !== null && "count" in row && typeof row.count === "number";
}

function resolveConfiguredDatabasePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}

function defaultLocalDatabasePath(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "MarketPilot", "marketpilot.sqlite");
  }

  const base = process.env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), ".local", "share");
  return path.join(base, "marketpilot", "marketpilot.sqlite");
}

function migrateLegacyProjectDatabase(targetPath: string): void {
  if (configuredDbPath) return;
  if (path.resolve(targetPath) === legacyProjectDbPath) return;
  if (existsSync(targetPath) || !existsSync(legacyProjectDbPath)) return;

  try {
    copyFileSync(legacyProjectDbPath, targetPath);
  } catch {
    // If OneDrive has the old DB locked, continue with a fresh local DB.
  }
}
