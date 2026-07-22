// Product profile store. One profile per workspace. The agent reads this at
// the start of every run; the agent NEVER writes it (root AGENTS.md §5.12).
//
// We seed a default profile for ws_default so the agent always has SOMETHING
// to read as memory. PUT /api/profile lets the user replace it.

import type { ProductProfile } from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspaces";
import { getJson, putJson } from "./sqlite";

// Seed default profile so memory is never empty.
const defaultProfile: ProductProfile = {
  id: "pp_default",
  workspaceId: DEFAULT_WORKSPACE_ID,
  productName: "MarketPilot AI",
  tagline: "Autonomous marketing agents for early-stage SaaS teams.",
  industry: "SaaS / AI",
  stage: "MVP",
  siteUrl: process.env.SCHEDULED_AUDIT_URL ?? "https://example.com",
  positioning:
    "MarketPilot AI is an autonomous marketing agent platform that runs SEO audits, drafts copy, and proposes paid-ads and email actions for early-stage SaaS teams.",
  features: ["SEO Audit", "Copywriter", "Paid Ads Audit", "Approvals Inbox"],
  differentiators: ["Tier-gated autonomy", "PR-based rollbacks", "Real-data memory"],
  icp: "B2B SaaS founders and growth leads, 5-50 person teams, pre-Series-B.",
  voiceTone: ["Professional", "Technical", "Bold"],
  mrr: 0,
  monthlyTraffic: 0,
  northStar: "Ship Step 7 cleanly so the agent runs autonomously on a real site.",
  pricingJson: { tiers: ["Free", "Pro", "Enterprise"] },
  competitorsJson: ["jasper.ai", "ahrefs.com", "semrush.com"],
  brandGuidelines:
    "Indigo + violet accents. Linear-quality typography. Live, professional, never bouncy.",
  updatedAt: new Date().toISOString(),
};

if (!getJson<ProductProfile>("product_profiles", DEFAULT_WORKSPACE_ID)) {
  putJson("product_profiles", DEFAULT_WORKSPACE_ID, defaultProfile, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    updatedAt: defaultProfile.updatedAt,
  });
}

export const productProfileStore = {
  get(workspaceId: string = DEFAULT_WORKSPACE_ID): ProductProfile | undefined {
    return getJson<ProductProfile>("product_profiles", workspaceId);
  },

  ensure(workspaceId: string, productName = "MarketPilot AI"): ProductProfile {
    const existing = this.get(workspaceId);
    if (existing) return existing;

    const now = new Date().toISOString();
    return putJson(
      "product_profiles",
      workspaceId,
      {
        ...defaultProfile,
        id: `pp_${workspaceId}`,
        workspaceId,
        productName,
        updatedAt: now,
      },
      {
        workspaceId,
        updatedAt: now,
      },
    );
  },

  // Upsert. Only user-facing routes call this — the agent does not.
  set(profile: ProductProfile): ProductProfile {
    const next = { ...profile, updatedAt: new Date().toISOString() };
    return putJson("product_profiles", profile.workspaceId, next, {
      workspaceId: profile.workspaceId,
      updatedAt: next.updatedAt,
    });
  },
};
