// /api/profile — single-workspace read/write of the product profile.
// The agent never writes here (framework rule §5.12). Only users do.

import { Router } from "express";
import { productProfileStore } from "../lib/store";
import {
  resolveRequestContext,
  sendContextError,
} from "../lib/workspace/request-context";

export const profileRouter = Router();

// GET /api/profile
profileRouter.get("/", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const profile = productProfileStore.ensure(ctx.workspaceId, ctx.workspace.name);
  if (!profile) {
    return res.status(404).json({ error: "Profile not seeded." });
  }
  res.json(profile);
});

// PUT /api/profile
profileRouter.put("/", (req, res) => {
  const ctx = resolveRequestContext(req);
  if (sendContextError(res, ctx)) return;

  const body = req.body ?? {};
  const current = productProfileStore.ensure(ctx.workspaceId, ctx.workspace.name);
  if (!current) {
    return res.status(404).json({ error: "Profile not seeded." });
  }
  const strArr = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string")
      ? (v as string[])
      : fallback;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;

  // Merge — only allow whitelisted fields to be updated.
  const next = productProfileStore.set({
    ...current,
    productName:
      typeof body.productName === "string" ? body.productName : current.productName,
    tagline: typeof body.tagline === "string" ? body.tagline : current.tagline,
    industry: typeof body.industry === "string" ? body.industry : current.industry,
    stage: ["Pre-launch", "MVP", "Growth", "Scale"].includes(body.stage)
      ? body.stage
      : current.stage,
    siteUrl: typeof body.siteUrl === "string" ? body.siteUrl : current.siteUrl,
    positioning:
      typeof body.positioning === "string" ? body.positioning : current.positioning,
    features: strArr(body.features, current.features),
    differentiators: strArr(body.differentiators, current.differentiators),
    icp: typeof body.icp === "string" ? body.icp : current.icp,
    voiceTone: strArr(body.voiceTone, current.voiceTone),
    mrr: num(body.mrr, current.mrr),
    monthlyTraffic: num(body.monthlyTraffic, current.monthlyTraffic),
    northStar:
      typeof body.northStar === "string" ? body.northStar : current.northStar,
    pricingJson: body.pricingJson ?? current.pricingJson,
    competitorsJson: body.competitorsJson ?? current.competitorsJson,
    brandGuidelines:
      typeof body.brandGuidelines === "string"
        ? body.brandGuidelines
        : current.brandGuidelines,
  });
  res.json(next);
});
