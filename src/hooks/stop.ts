#!/usr/bin/env node
/**
 * Stop hook entry point.
 *
 * Invoked by Claude Code when the main agent finishes responding.
 * Reads the transcript, identifies new messages since last run,
 * groups them into turns, and sends traces to Langfuse.
 *
 * Produces nested traces: Trace → Generation(s) → Tool span(s),
 * preserving the causal relationship between LLM calls and tool use.
 */

import { readTranscript, groupIntoTurns, extractText } from "../transcript.js";
import { log, warn, debug, error } from "../logger.js";
import { loadState, atomicUpdateState, getSessionState, pruneOldSessions } from "../state.js";
import {
  initClient,
  setMaxChars,
  emitTurn,
  tracePendingSubagents,
  flushTraces,
  shutdownClient,
  getSdkErrors,
} from "../langfuse.js";
import { initHook, expandHome } from "../utils/hook-init.js";
import { readStdin } from "../utils/stdin.js";
import { isFeedbackCommand } from "../scoring/match.js";
import type { StopHookInput, ContentBlock } from "../types.js";

/**
 * Machine-readable outcome line on stdout — the ONLY reliable success signal:
 * every exit path here returns 0 (Claude Code must not be affected), per-turn
 * failures are caught in the emit loop, and the SDK swallows flush errors.
 * A driving runner parses this line into its upload-outcome record.
 */
function printOutcome(turnsTraced: number, turnsFailed: number, flush: string, errors?: string[]): void {
  const outcome: Record<string, unknown> = {
    turns_traced: turnsTraced,
    turns_failed: turnsFailed,
    flush,
  };
  if (errors && errors.length > 0) outcome.errors = errors.slice(0, 3);
  console.log(`LANGFUSE_UPLOAD_OUTCOME ${JSON.stringify(outcome)}`);
}

async function main(): Promise<void> {
  const startTime = Date.now();

  const input: StopHookInput = await readStdin();

  const config = initHook();
  if (!config) {
    printOutcome(0, 0, "skipped:gate");
    return;
  }

  debug(`Stop hook started, session=${input.session_id}`);

  // Skip recursive hook calls.
  if (input.stop_hook_active) {
    debug("stop_hook_active=true, skipping");
    printOutcome(0, 0, "skipped:recursive");
    return;
  }

  // Validate input.
  const transcriptPath = expandHome(input.transcript_path);
  if (!input.session_id || !transcriptPath) {
    warn(`Invalid input: session=${input.session_id}, transcript=${transcriptPath}`);
    printOutcome(0, 0, "skipped:invalid-input");
    return;
  }

  initClient(config.publicKey, config.secretKey, config.baseUrl);
  setMaxChars(config.maxChars);

  // Load state and read new messages.
  const state = loadState(config.stateFilePath);
  const sessionState = getSessionState(state, input.session_id);

  debug(`Last line: ${sessionState.last_line}, turn count: ${sessionState.turn_count}`);

  // Wait briefly for the transcript writer to flush.
  await new Promise((r) => setTimeout(r, 200));

  const { messages, lastLine } = readTranscript(transcriptPath, sessionState.last_line);
  if (messages.length === 0) {
    debug("No new messages");
    if (sessionState.current_trace_id) {
      await atomicUpdateState(config.stateFilePath, (s) => {
        const ss = getSessionState(s, input.session_id);
        return { ...s, [input.session_id]: { ...ss, current_trace_id: undefined } };
      });
    }
    printOutcome(0, 0, "ok");
    return;
  }

  // ADR-002 / EIS §3.9(a): if UserPromptSubmit skipped trace allocation (because
  // the prompt was a /feedback or /journey command), there's nothing to emit.
  // Just advance last_line past the feedback turn so the next Stop doesn't
  // reprocess it.
  //
  // Seam mode is the exception: no UserPromptSubmit hook runs at all, so
  // current_trace_id is never set — emitTurn mints a deterministic id from the
  // turn's user-row transcript uuid instead, and this branch must not swallow
  // every turn.
  if (!sessionState.current_trace_id && !config.seamMode) {
    debug(
      `No current_trace_id — likely a feedback turn. ` +
        `Advancing last_line ${sessionState.last_line} → ${lastLine} and exiting.`,
    );
    await atomicUpdateState(config.stateFilePath, (s) => {
      const ss = getSessionState(s, input.session_id);
      return {
        ...s,
        [input.session_id]: { ...ss, last_line: lastLine, updated: new Date().toISOString() },
      };
    });
    printOutcome(0, 0, "skipped:feedback-turn");
    return;
  }

  log(`Found ${messages.length} new messages`);

  // Group into turns and trace each one.
  const turns = groupIntoTurns(messages);

  // Patch the last turn if the final LLM response is missing from transcript.
  if (turns.length > 0 && input.last_assistant_message) {
    const lastTurn = turns[turns.length - 1];
    const lastLlm = lastTurn.llmCalls[lastTurn.llmCalls.length - 1];
    if (lastLlm && lastLlm.toolCalls.length > 0) {
      debug("Final LLM response missing from transcript, synthesizing from last_assistant_message");
      const syntheticStart = sessionState.last_tool_end_time
        ? new Date(sessionState.last_tool_end_time).toISOString()
        : (lastLlm.toolCalls[lastLlm.toolCalls.length - 1].result?.timestamp ?? lastLlm.endTime);
      const syntheticEnd = new Date(startTime).toISOString();
      lastTurn.llmCalls.push({
        content: [{ type: "text", text: input.last_assistant_message }],
        model: lastLlm.model,
        usage: { input_tokens: 0, output_tokens: 0 },
        startTime: syntheticStart,
        endTime: syntheticEnd,
        toolCalls: [],
        synthetic: true,
      });
    }
  }

  let tracedTurns = 0;
  let failedTurns = 0;
  // Seam mode mints trace ids inside emitTurn, so the subagent pass below
  // cannot rely on current_trace_id — track the last successfully emitted one.
  let lastEmittedTraceId: string | undefined;
  const currentTraceId = sessionState.current_trace_id;
  const transcriptName = transcriptPath.split("/").pop() ?? "";
  const promptRef =
    config.promptName && config.promptVersion !== undefined
      ? { name: config.promptName, version: config.promptVersion }
      : undefined;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const isLastTurn = i === turns.length - 1;
    const turnNum = sessionState.turn_count + tracedTurns + 1;

    // Only the last turn gets the pre-allocated trace from UserPromptSubmit
    const traceId = isLastTurn ? currentTraceId : undefined;

    try {
      lastEmittedTraceId = emitTurn({
        sessionId: input.session_id,
        turnNum,
        turn,
        transcriptName,
        traceId,
        toolStartTimes: isLastTurn ? sessionState.tool_start_times : undefined,
        promptRef,
      });
      tracedTurns++;
    } catch (err) {
      failedTurns++;
      error(`Failed to trace turn ${turnNum}: ${err}`);
    }
  }

  // Re-read state for pending subagent traces
  const freshState = loadState(config.stateFilePath);
  const freshSession = getSessionState(freshState, input.session_id);
  const mergedTaskRunMap = { ...freshSession.task_run_map };

  const pendingSubagents = freshSession.pending_subagent_traces || [];
  if (pendingSubagents.length > 0) {
    debug(`Processing ${pendingSubagents.length} pending subagent trace(s)`);
    tracePendingSubagents({
      sessionId: input.session_id,
      pendingSubagents,
      taskRunMap: mergedTaskRunMap,
      // Seam mode: current_trace_id is never allocated — parent under the last
      // minted trace instead.
      parentTraceId: freshSession.current_trace_id ?? lastEmittedTraceId,
    });
  }

  // ADR-003 / EIS §3.9(b): promote current_trace_id → last_substantive_trace_id
  // when the last traced turn was a real user turn (not a feedback command).
  // The defensive double-check on the user content covers the (paranoid) case
  // that a feedback turn somehow slipped through the UserPromptSubmit filter.
  let promoteTraceId: string | undefined = undefined;
  if (tracedTurns > 0 && currentTraceId) {
    const lastTurn = turns[turns.length - 1];
    const userText =
      typeof lastTurn.userContent === "string"
        ? lastTurn.userContent
        : extractText(lastTurn.userContent as unknown as ContentBlock[]);
    if (!isFeedbackCommand(userText)) {
      promoteTraceId = currentTraceId;
    } else {
      debug(
        "Last turn looked like a feedback command (defensive check); not promoting last_substantive_trace_id",
      );
    }
  }

  // Save updated state
  const savedLastLine = tracedTurns > 0 ? lastLine : sessionState.last_line;
  await atomicUpdateState(config.stateFilePath, (latestState) => {
    const latestSession = getSessionState(latestState, input.session_id);
    const updatedState = {
      ...latestState,
      [input.session_id]: {
        ...latestSession,
        last_line: savedLastLine,
        turn_count: latestSession.turn_count + tracedTurns,
        updated: new Date().toISOString(),
        current_trace_id: undefined,
        // Promote substantive trace; preserve previous value when this turn wasn't substantive.
        last_substantive_trace_id: promoteTraceId ?? latestSession.last_substantive_trace_id,
        pending_subagent_traces: [],
        tool_start_times: {},
        task_run_map: {},
      },
    };
    return pruneOldSessions(updatedState);
  });

  // Flush outside the lock. flushAsync resolves even on ingestion errors, so
  // the outcome's flush field reads the SDK "error" events instead.
  let flushOutcome = "ok";
  try {
    await flushTraces();
    await shutdownClient();
  } catch (err) {
    flushOutcome = "error";
    error(`Flush failed: ${err}`);
  }
  const sdkErrors = getSdkErrors();
  if (sdkErrors.length > 0 && flushOutcome === "ok") flushOutcome = "error";
  printOutcome(tracedTurns, failedTurns, flushOutcome, sdkErrors);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`Processed ${tracedTurns} turns in ${duration}s`);

  if (Date.now() - startTime > 180_000) {
    warn(`Hook took ${duration}s (>3min), consider optimizing`);
  }
}

main().catch((err) => {
  try {
    error(`Stop hook fatal error: ${err}`);
    printOutcome(0, 0, "fatal", [String(err).slice(0, 500)]);
  } catch {
    // Last resort
  }
  process.exit(0); // Always exit 0 so Claude Code isn't affected.
});
