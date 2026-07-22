// Audits store. Historical audit reports (SEO / analytics / CRO / ads / churn).
// Populated at Step 3 when the first real connector + crawl_site + audit_seo
// tools land.

import type { Audit } from "./types";
import { DEFAULT_WORKSPACE_ID } from "./workspaces";
import { getJson, listJson, putJson } from "./sqlite";

function saveAudit(audit: Audit): Audit {
  return putJson("audits", audit.id, audit, {
    workspaceId: audit.workspaceId,
    type: audit.type,
    createdAt: audit.createdAt,
  });
}

export const auditsStore = {
  create(input: Omit<Audit, "id" | "createdAt">): Audit {
    const audit: Audit = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...input,
    };
    return saveAudit(audit);
  },

  get(id: string): Audit | undefined {
    return getJson<Audit>("audits", id);
  },

  list(
    workspaceId: string = DEFAULT_WORKSPACE_ID,
    type?: Audit["type"],
  ): Audit[] {
    return listJson<Audit>("audits", { workspaceId, type, orderBy: "created_at_desc" });
  },
};
