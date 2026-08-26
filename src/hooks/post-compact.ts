#!/usr/bin/env node
/**
 * PostCompact hook entry point.
 *
 * Fires after Claude Code completes a compact operation.
 * Creates a Langfuse span capturing the compaction event and summary.
 */

import { debug, error } from "../logger.js";
import { initClient, emitDetachedObservation, flushTraces, shutdownClient } from "../langfuse.js";
import { loadState, atomicUpdateState, getSessionState } from "../state.js";
import { initHook } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";

interface PostCompactHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
  hook_event_name: "PostCompact";
  trigger: "manual" | "auto";
  compact_summary: string;
}

async function main(): Promise<void> {
  const input: PostCompactHookInput = await readStdin();

  const config = initHook();
  if (!config) return;

  debug(`PostCompact hook started, session=${input.session_id}, trigger=${input.trigger}`);

  initClient(config.publicKey, config.secretKey, config.baseUrl);

  const state = loadState(config.stateFilePath);
  const sessionState = getSessionState(state, input.session_id);

  const endTime = Date.now();
  const startTime = sessionState.compaction_start_time ?? endTime;

  // Detached span in the open trace when one exists; standalone root
  // otherwise (OTLP has no re-open-a-trace upsert).
  try {
    emitDetachedObservation({
      traceId: sessionState.current_trace_id,
      name: `Context Compaction (${input.trigger})`,
      asType: "span",
      input: {},
      output: { compact_summary: input.compact_summary },
      metadata: { source: "claude-code", trigger: input.trigger, session_id: input.session_id },
      startTime: new Date(startTime),
      endTime: new Date(endTime),
      sessionId: input.session_id,
    });
    debug(
      sessionState.current_trace_id
        ? `Created compaction span under trace ${sessionState.current_trace_id}`
        : "Created standalone compaction observation",
    );
  } catch (err) {
    error(`Failed to record compaction: ${err}`);
  }

  // Clear compaction_start_time from state
  await atomicUpdateState(config.stateFilePath, (s) => {
    const ss = getSessionState(s, input.session_id);
    return {
      ...s,
      [input.session_id]: { ...ss, compaction_start_time: undefined },
    };
  });

  await flushTraces();
  await shutdownClient();
}

main().catch((err) => {
  try {
    error(`PostCompact hook fatal error: ${err}`);
  } catch {
    // Last resort
  }
  process.exit(0);
});
