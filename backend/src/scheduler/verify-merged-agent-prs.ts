import {
  inspectToolCallWriteStatus,
  verifyToolCall,
} from "../lib/agent-tools";
import { eventsStore, toolCallsStore } from "../lib/store";
import type { ToolCall, ToolCallWriteStatus } from "../lib/store";
import type { ExternalWriteStatus } from "../lib/connectors";

export type VerifyMergedAgentPrsResult = {
  checked: number;
  waiting: number;
  verified: number;
  skipped: number;
  failed: number;
  message: string;
};

const WATCHED_TOOLS = new Set(["add_alt_text", "apply_seo_fixes"]);

export async function verifyMergedAgentPrs(): Promise<VerifyMergedAgentPrsResult> {
  const calls = toolCallsStore
    .listAll()
    .filter((call) => call.status === "executed")
    .filter((call) => WATCHED_TOOLS.has(call.toolName))
    .filter((call) => call.verified !== true);

  let checked = 0;
  let waiting = 0;
  let verified = 0;
  let skipped = 0;
  let failed = 0;

  for (const call of calls) {
    if (call.rollbackPayloadJson === undefined || call.rollbackPayloadJson === null) {
      skipped++;
      continue;
    }

    try {
      const writeStatus = await inspectToolCallWriteStatus(
        call.toolName,
        call.rollbackPayloadJson,
      );
      checked++;
      persistWriteStatus(call, writeStatus);

      if (writeStatus.state === "open" || writeStatus.state === "simulated") {
        waiting++;
        continue;
      }

      if (writeStatus.state === "closed" || writeStatus.state === "not_found") {
        skipped++;
        continue;
      }

      if (writeStatus.state !== "merged") {
        failed++;
        continue;
      }

      const verification = await verifyToolCall(call.toolName, call.inputJson);
      const outputJson = mergeOutputJson(call.outputJson, {
        writeStatus,
        verification: verification.details ?? null,
      });

      toolCallsStore.update(call.id, {
        verified: verification.success,
        verificationResult: verification.result,
        outputJson,
      });

      eventsStore.append("tool_auto_verified", {
        toolCallId: call.id,
        toolName: call.toolName,
        success: verification.success,
        impact: readVerificationImpact(verification.details),
      });

      if (verification.success) verified++;
      else failed++;
    } catch (err) {
      failed++;
      toolCallsStore.update(call.id, {
        writeStatus: "unknown",
        writeStatusCheckedAt: new Date().toISOString(),
        verificationResult: `Automatic verification failed: ${
          err instanceof Error ? err.message : "unknown"
        }`,
      });
      eventsStore.append("tool_auto_verify_failed", {
        toolCallId: call.id,
        toolName: call.toolName,
        message: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  return {
    checked,
    waiting,
    verified,
    skipped,
    failed,
    message:
      `Checked ${checked} agent PR write(s): ` +
      `${verified} verified, ${waiting} waiting, ${skipped} skipped, ${failed} failed.`,
  };
}

function readVerificationImpact(details: unknown): unknown {
  if (typeof details !== "object" || details === null || Array.isArray(details)) {
    return undefined;
  }
  return (details as Record<string, unknown>).impact;
}

function persistWriteStatus(
  call: ToolCall,
  writeStatus: ExternalWriteStatus,
): void {
  const mapped = mapWriteStatus(writeStatus);
  const shouldUpdateResult =
    writeStatus.state !== "merged" || call.verificationResult === undefined;

  toolCallsStore.update(call.id, {
    writeStatus: mapped,
    writeStatusCheckedAt: writeStatus.checkedAt,
    verificationResult: shouldUpdateResult
      ? writeStatus.summary
      : call.verificationResult,
    outputJson: mergeOutputJson(call.outputJson, { writeStatus }),
  });

  eventsStore.append("tool_write_status_checked", {
    toolCallId: call.id,
    toolName: call.toolName,
    writeStatus: mapped,
  });
}

function mapWriteStatus(status: ExternalWriteStatus): ToolCallWriteStatus {
  if (status.state === "open") return "pr_open";
  if (status.state === "merged") return "pr_merged";
  if (status.state === "closed") return "pr_closed";
  if (status.state === "not_found") return "pr_not_found";
  if (status.state === "simulated") return "simulated";
  return "unknown";
}

function mergeOutputJson(
  current: unknown,
  updates: Record<string, unknown>,
): Record<string, unknown> {
  if (typeof current !== "object" || current === null || Array.isArray(current)) {
    return updates;
  }
  return { ...(current as Record<string, unknown>), ...updates };
}
