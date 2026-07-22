import { Router } from "express";
import {
  databaseHealth,
  exportDatabaseSnapshot,
  writeDatabaseBackup,
} from "../lib/store/sqlite";

export const databaseRouter = Router();

databaseRouter.get("/health", (_req, res) => {
  res.json(databaseHealth());
});

databaseRouter.get("/export", (_req, res) => {
  res.json(exportDatabaseSnapshot());
});

databaseRouter.post("/backup", (_req, res) => {
  res.json(writeDatabaseBackup());
});
