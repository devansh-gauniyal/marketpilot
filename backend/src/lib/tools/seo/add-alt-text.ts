// Tool: add_alt_text
// Tier: YELLOW — reversible write (PR-based, root AGENTS.md §5.8).
//
// Input shape:
//   {
//     patches: [{ filepath, imageSrc, altText }],
//     reason: string (why these alt-texts were chosen — saved in PR body)
//   }
//
// Output to the agent:
//   - PR URL + per-patch summary in tool_result text
//   - structured rollback payload returned to the loop for persistence

import { githubMdxConnector } from "../../connectors";
import type { AltTextPatch } from "../../connectors/types";

export type AddAltTextInput = {
  patches: AltTextPatch[];
  reason?: string;
};

export type AddAltTextOutput = {
  result: string;
  changeId: string;
  rollbackPayload: unknown;
  success: boolean;
};

export async function addAltText(
  input: AddAltTextInput,
): Promise<AddAltTextOutput> {
  // Capability check (root AGENTS.md §5.5 — tools verify capabilities before
  // writing).
  if (!githubMdxConnector.capabilities.canFixAltText) {
    return {
      success: false,
      result: "GitHub-MDX connector does not advertise canFixAltText.",
      changeId: "",
      rollbackPayload: null,
    };
  }

  if (!input.patches || input.patches.length === 0) {
    return {
      success: false,
      result: "add_alt_text: no patches provided. Pass at least one { filepath, imageSrc, altText }.",
      changeId: "",
      rollbackPayload: null,
    };
  }

  const write = await githubMdxConnector.fixAltText!(input.patches);

  if (!write.success) {
    return {
      success: false,
      result: "add_alt_text: connector returned failure (see backend logs).",
      changeId: "",
      rollbackPayload: null,
    };
  }

  const lines = input.patches.map(
    (p) => `  • ${p.filepath} :: ${p.imageSrc} → "${p.altText}"`,
  );
  const result = [
    `Opened PR ${write.changeId} with ${input.patches.length} alt-text patch(es).`,
    ...(input.reason ? [`Reason: ${input.reason}`] : []),
    ...lines,
    `Rollback: close the PR (this tool call is also rollbackable from /api/tool-calls/:id/rollback).`,
  ].join("\n");

  return {
    success: true,
    result,
    changeId: write.changeId,
    rollbackPayload: write.rollbackPayload,
  };
}
