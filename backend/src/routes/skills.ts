// /api/skills — read-only catalog endpoint for the frontend skill picker.
//
// The frontend used to hardcode 10 of the 41 skills. It now reads the full
// catalog from here so every skill is visible (draft-only or otherwise).

import { Router } from "express";
import { getSkill, listSkills } from "../lib/skills/catalog";

export const skillsRouter = Router();

skillsRouter.get("/", (_req, res) => {
  res.json({ skills: listSkills() });
});

skillsRouter.get("/:id", (req, res) => {
  const skill = getSkill(req.params.id);
  if (!skill) {
    return res.status(404).json({ error: "Skill not found." });
  }
  res.json(skill);
});
