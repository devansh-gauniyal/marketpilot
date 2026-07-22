// /api/drafts — flat view of every draft across every skill run.
// Powers the Drafts gallery screen.

import { Router } from "express";
import { skillRunsStore } from "../lib/store";
import {
  resolveRequestContext,
  sendContextError,
} from "../lib/workspace/request-context";

export const draftsRouter = Router();

draftsRouter.get("/", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const runs = skillRunsStore.list().filter((run) => run.workspaceId === ctx.workspaceId);
  const drafts = runs.flatMap((r) =>
    r.drafts.map((d) => ({
      ...d,
      taskId: r.taskId,
      skillId: r.skillId,
      productName: r.inputContext.productName ?? null,
    })),
  );
  drafts.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  res.json({ drafts });
});
