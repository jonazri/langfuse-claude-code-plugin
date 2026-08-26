/**
 * Langfuse run construction and submission — JS/TS SDK v5 (OTLP ingestion).
 *
 * Converts parsed Turns into observation trees:
 *   Agent (Turn root — carries the turn's input/output, v5 root-IO model)
 *   ├── Generation: "LLM Call 1/3"  (model, usage, thinking, prompt link)
 *   │    ├── Tool: Glob             (input, output, duration)
 *   │    └── Tool: Read
 *   ├── Generation: "LLM Call 2/3"
 *   └── Generation: "LLM Call 3/3"  (final response)
 *
 * v5 semantics honored here:
 *   - Correlating attributes (userId, sessionId, metadata) ride EVERY
 *     observation via propagateAttributes — the observations-first model.
 *   - The turn's overall input/output live on the ROOT observation; trace
 *     input/output is deprecated and not written.
 *   - Ingestion is OTLP (`/api/public/otel/v1/traces`, version-4 header) via
 *     FetchOtlpExporter — classic `/api/public/ingestion` trace events are
 *     removed from Langfuse Cloud on 2026-11-16.
 *   - The trace id stays deterministic (transcript user-row uuid) through
 *     QueuedIdGenerator; observation ids are OTEL span ids, so the duplicate
 *     guard is the state file's line offsets, as in the pre-fork plugin.
 */
import { randomBytes } from "node:crypto";
import { LangfuseClient } from "@langfuse/client";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startObservation } from "@langfuse/tracing";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { TraceFlags, type SpanContext } from "@opentelemetry/api";
import type { Turn, LLMCall, ToolCall, Usage, SessionState } from "./types.js";
import { readTranscript, groupIntoTurns, extractText, extractThinking } from "./transcript.js";
import { FetchOtlpExporter, QueuedIdGenerator, deriveTraceId, getTransportErrors } from "./otel-exporter.js";
import * as logger from "./logger.js";

// ─── Client setup ───────────────────────────────────────────────────────────

let provider: NodeTracerProvider | null = null;
let processor: LangfuseSpanProcessor | null = null;
let idGenerator: QueuedIdGenerator | null = null;
let apiClient: LangfuseClient | null = null;

export function getSdkErrors(): string[] {
  return getTransportErrors();
}

export function initClient(publicKey: string, secretKey: string, baseUrl: string): void {
  idGenerator = new QueuedIdGenerator();
  processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    exporter: new FetchOtlpExporter({ baseUrl, publicKey, secretKey }),
  });
  provider = new NodeTracerProvider({ idGenerator, spanProcessors: [processor] });
  provider.register();
  // Non-tracing API (scores) — fetch-based, so it traverses the same proxy.
  apiClient = new LangfuseClient({ publicKey, secretKey, baseUrl });
}

/** Flush all pending spans so traces are sent before the hook exits. */
export async function flushTraces(): Promise<void> {
  if (!processor) {
    logger.warn("Cannot flush: processor not initialized");
    return;
  }
  logger.debug("Flushing Langfuse spans...");
  await processor.forceFlush();
  logger.debug("Langfuse spans flushed");
}

/** Shut down the provider (flushes remaining spans and pending scores). */
export async function shutdownClient(): Promise<void> {
  try {
    await apiClient?.flush();
  } catch {
    // Best-effort — score delivery failures surface via the outcome line
  }
  if (!provider) return;
  try {
    await provider.shutdown();
  } catch {
    // Best-effort shutdown
  }
}

// ─── Score posting (for /feedback and /journey CLIs) ────────────────────────

export interface PostScoreOptions {
  /** Deterministic, idempotent score ID — Langfuse upserts on this key. */
  id: string;
  /** Score name (e.g. "turn_feedback" or "session_feedback"). */
  name: string;
  /** Numeric value (e.g. +1 / -1). */
  value: number;
  /** Optional comment shown in the Langfuse score detail. */
  comment?: string;
  /** Attach to a trace (turn-scope). Mutually exclusive with sessionId in practice. */
  traceId?: string;
  /** Attach to a session (session-scope). */
  sessionId?: string;
}

/**
 * Post a score. Idempotent on `id`. Score writes remain a supported ingestion
 * event type after the v4 cutover (deprecated-API guide) — no direct REST
 * workaround needed.
 */
export function postScore(options: PostScoreOptions): void {
  if (!apiClient) {
    logger.warn("Cannot post score: client not initialized");
    return;
  }
  apiClient.score.create({
    id: options.id,
    name: options.name,
    value: options.value,
    comment: options.comment,
    traceId: options.traceId,
    sessionId: options.sessionId,
  });
}

/** Flush pending score writes (separate pipeline from the span processor). */
export async function flushScores(): Promise<void> {
  try {
    await apiClient?.flush();
  } catch (err) {
    logger.error(`Score flush failed: ${err}`);
  }
}

// ─── Truncation ─────────────────────────────────────────────────────────────

let maxChars = 50000;

export function setMaxChars(max: number): void {
  maxChars = max;
}

function truncate(text: string): string {
  if (!text || text.length <= maxChars) return text;
  return text.slice(0, maxChars) + `\n\n[...truncated, ${text.length - maxChars} more chars]`;
}

function truncateValue(v: unknown): unknown {
  if (typeof v === "string") return truncate(v);
  if (Array.isArray(v)) return v.map(truncateValue);
  if (v && typeof v === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(v)) {
      result[key] = truncateValue(val);
    }
    return result;
  }
  return v;
}

// ─── Usage formatting ───────────────────────────────────────────────────────

function buildUsage(usage: Usage): Record<string, number> | undefined {
  const details: Record<string, number> = {};
  if (usage.input_tokens > 0) details.input = usage.input_tokens;
  if (usage.output_tokens > 0) details.output = usage.output_tokens;
  if (usage.cache_read_input_tokens) details.cache_read_input_tokens = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens) details.cache_creation_input_tokens = usage.cache_creation_input_tokens;
  if (usage.input_tokens > 0 || usage.output_tokens > 0) {
    details.total = (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
  }
  return Object.keys(details).length > 0 ? details : undefined;
}

// ─── Turn emission ──────────────────────────────────────────────────────────

export interface EmitTurnOptions {
  sessionId: string;
  turnNum: number;
  turn: Turn;
  transcriptName: string;
  /** Pre-allocated trace ID (32-hex or uuid) from UserPromptSubmit. */
  traceId?: string;
  /** Tool start times from PreToolUse (tool_use_id -> wall-clock ms). */
  toolStartTimes?: Record<string, number>;
  /** Registered prompt to link on every generation (promptName/promptVersion). */
  promptRef?: { name: string; version: number };
  /** Extra trace-level metadata (e.g. interrupted: "true"). Values must be
   *  strings — propagateAttributes requires Record<string, string>. */
  extraMetadata?: Record<string, string>;
}

/** First `sender_id="…"` embedded in the formatted user content is the turn's
 *  author; a batch can carry several — the rest are tagged in metadata. */
export function extractSenderIds(userText: string): string[] {
  const out: string[] = [];
  const re = /\bsender_id="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(userText)) !== null) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** Root span context of the most recent emitTurn — the parent for the
 *  subagent pass (v3 could re-open a trace by id; OTLP cannot). The turn's
 *  correlating attributes ride along so the subagent pass can re-establish
 *  the propagation scope: its spans are part of the same trace and its
 *  generations are cost-bearing, so session cost must include them. */
let lastRootSpanContext: SpanContext | null = null;
let lastRootPropagation: { sessionId: string; userId?: string } | null = null;

function toDate(iso: string): Date {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Emit one turn as a trace: an agent-typed root observation carrying the
 * turn's input/output, with nested generations and tool observations.
 * Returns the (deterministic) 32-hex trace ID used.
 */
export function emitTurn(options: EmitTurnOptions): string {
  const { sessionId, turnNum, turn, transcriptName, traceId, toolStartTimes, promptRef, extraMetadata } = options;

  if (!idGenerator) throw new Error("Langfuse tracing not initialized — call initClient() first");

  const traceName = `Claude Code - Turn ${turnNum}`;
  const userText =
    typeof turn.userContent === "string" ? truncate(turn.userContent) : JSON.stringify(turn.userContent);
  const finalText =
    turn.llmCalls.length > 0 ? truncate(extractText(turn.llmCalls[turn.llmCalls.length - 1].content)) : "";

  const senders = extractSenderIds(
    typeof turn.userContent === "string" ? turn.userContent : JSON.stringify(turn.userContent),
  );

  const traceIdHex = deriveTraceId(traceId || turn.userUuid || `${sessionId}:${turnNum}`);
  idGenerator.queueTraceId(traceIdHex);

  const turnStart = toDate(turn.userTimestamp);
  const lastLlm = turn.llmCalls[turn.llmCalls.length - 1];
  const turnEnd = lastLlm ? toDate(lastLlm.endTime) : turnStart;

  // v5 observations-first model: correlating attributes propagate to every
  // observation created in this scope — session cost then includes every
  // cost-bearing generation.
  propagateAttributes(
    {
      traceName,
      sessionId,
      ...(senders[0] ? { userId: senders[0] } : {}),
      metadata: {
        source: "claude-code",
        turn_number: String(turnNum),
        transcript: transcriptName,
        is_complete: String(turn.isComplete),
        ...(turn.promptId ? { prompt_id: turn.promptId } : {}),
        ...(senders.length > 1 ? { other_senders: JSON.stringify(senders.slice(1)) } : {}),
        ...(extraMetadata ?? {}),
      },
    },
    () => {
      const root = startObservation(
        traceName,
        {
          // Root-observation IO — the v5 replacement for deprecated trace IO.
          input: { role: "user", content: userText },
          output: { role: "assistant", content: finalText },
        },
        { asType: "agent", startTime: turnStart },
      );
      lastRootSpanContext = root.otelSpan.spanContext();
      lastRootPropagation = { sessionId, ...(senders[0] ? { userId: senders[0] } : {}) };

      for (let i = 0; i < turn.llmCalls.length; i++) {
        emitLLMCall(
          lastRootSpanContext,
          i + 1,
          turn.llmCalls.length,
          turn.llmCalls[i],
          userText,
          toolStartTimes,
          promptRef,
        );
      }

      root.end(turnEnd);
    },
  );

  return traceIdHex;
}

/**
 * Emit one LLM call as a generation with child tool observations. The child
 * method form (`parent.startObservation`) accepts no startTime — retrospective
 * emission needs explicit timestamps, so children are created with the free
 * function and an explicit parentSpanContext instead.
 */
function emitLLMCall(
  parentCtx: SpanContext,
  index: number,
  total: number,
  llm: LLMCall,
  userText: string,
  toolStartTimes?: Record<string, number>,
  promptRef?: { name: string; version: number },
): void {
  const genName = total > 1 ? `LLM Call ${index}/${total}` : "Claude Response";

  const text = truncate(extractText(llm.content));
  const thinking = extractThinking(llm.content);
  const output: Record<string, unknown> = { role: "assistant", text };
  if (thinking) output.thinking = truncate(thinking);
  if (llm.toolCalls.length > 0) {
    output.tool_calls = llm.toolCalls.map((tc) => ({ name: tc.tool_use.name, id: tc.tool_use.id }));
  }

  const gen = startObservation(
    genName,
    {
      model: llm.model,
      input: { role: "user", content: userText },
      output,
      usageDetails: buildUsage(llm.usage),
      ...(promptRef ? { prompt: { name: promptRef.name, version: promptRef.version, isFallback: false } } : {}),
      metadata: {
        stop_reason: llm.stopReason ?? "",
        timestamp: llm.endTime,
        has_thinking: String(!!thinking),
        ...(llm.messageId ? { message_id: llm.messageId } : {}),
        ...(llm.synthetic ? { synthetic: true } : {}),
      },
    },
    { asType: "generation", startTime: toDate(llm.startTime), parentSpanContext: parentCtx },
  );

  const genCtx = gen.otelSpan.spanContext();
  for (const tc of llm.toolCalls) {
    emitTool(genCtx, tc, toolStartTimes);
  }

  gen.end(toDate(llm.endTime));
}

/** Emit one tool call as a tool-typed observation under its generation. */
function emitTool(parentCtx: SpanContext, tc: ToolCall, toolStartTimes?: Record<string, number>): void {
  const meta: Record<string, unknown> = { tool_id: tc.tool_use.id };
  if (tc.result?.durationMs !== undefined) meta.duration_ms = tc.result.durationMs;
  if (tc.result?.timestamp) meta.timestamp = tc.result.timestamp;
  if (tc.agentId) meta.agent_id = tc.agentId;

  const wallClockStart = toolStartTimes?.[tc.tool_use.id];
  const startTime = wallClockStart ? new Date(wallClockStart) : undefined;
  const endTime = tc.result?.timestamp ? new Date(tc.result.timestamp) : undefined;

  const span = startObservation(
    `Tool: ${tc.tool_use.name}`,
    {
      input: truncateValue(tc.tool_use.input),
      output: tc.result ? truncateValue(tc.result.content) : undefined,
      metadata: meta,
    },
    { asType: "tool", parentSpanContext: parentCtx, ...(startTime ? { startTime } : {}) },
  );
  span.end(endTime);
}

/**
 * Emit one observation into an EXISTING trace by id — the OTLP replacement
 * for v3's re-open-a-trace upsert (`client.trace({id, …})`), used by the
 * StopFailure error marker and the PostCompact span. The observation parents
 * onto a synthetic remote span context carrying the stored trace id: it lands
 * in the right trace (rendered as a detached child) without competing with
 * the turn's real root. With no trace id, it becomes a standalone root.
 */
export function emitDetachedObservation(options: {
  traceId?: string;
  name: string;
  asType?: "event" | "span";
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  startTime?: Date;
  endTime?: Date;
  sessionId?: string;
}): void {
  if (!idGenerator) throw new Error("Langfuse tracing not initialized");
  const opts: { startTime?: Date; parentSpanContext?: SpanContext } = {};
  if (options.startTime) opts.startTime = options.startTime;
  if (options.traceId) {
    opts.parentSpanContext = {
      traceId: deriveTraceId(options.traceId),
      spanId: randomBytes(8).toString("hex"),
      traceFlags: TraceFlags.SAMPLED,
      isRemote: true,
    };
  }
  const emit = (): void => {
    const attrs = { input: options.input, output: options.output, metadata: options.metadata };
    // Overloads resolve on the asType LITERAL — a union doesn't narrow.
    const obs =
      options.asType === "span"
        ? startObservation(options.name, attrs, { asType: "span", ...opts })
        : startObservation(options.name, attrs, { asType: "event", ...opts });
    obs.end(options.endTime);
  };
  if (options.sessionId) {
    propagateAttributes({ sessionId: options.sessionId }, emit);
  } else {
    emit();
  }
}

// ─── Interrupted turn recovery ──────────────────────────────────────────────

/**
 * Close an interrupted turn (Stop never fired for it): emit whatever the
 * transcript holds, tagged interrupted. Used by UserPromptSubmit (on next
 * prompt in same session) and SessionEnd.
 */
export async function closeInterruptedTurn(options: {
  sessionId: string;
  sessionState: SessionState;
  transcriptPath: string | undefined;
  config: { maxChars: number };
}): Promise<{ lastLine: number; turnsTraced: number; finalizedTraceId?: string }> {
  const { sessionId, sessionState, transcriptPath, config } = options;

  if (!idGenerator) throw new Error("Langfuse tracing not initialized");

  let lastLine = sessionState.last_line;
  let turnsTraced = 0;
  let finalizedTraceId: string | undefined;

  if (transcriptPath) {
    try {
      const { messages, lastLine: newLastLine } = readTranscript(transcriptPath, sessionState.last_line);
      if (messages.length > 0) {
        const turns = groupIntoTurns(messages);
        if (turns.length > 0) {
          setMaxChars(config.maxChars);
          finalizedTraceId = emitTurn({
            sessionId,
            turnNum: sessionState.turn_count + 1,
            turn: turns[turns.length - 1],
            transcriptName: transcriptPath.split("/").pop() ?? "",
            traceId: sessionState.current_trace_id,
            toolStartTimes: sessionState.tool_start_times,
            extraMetadata: { interrupted: "true", error: "User interrupt" },
          });
          lastLine = newLastLine;
          turnsTraced = 1;
        }
      }
    } catch (err) {
      logger.error(`Failed to trace interrupted turn transcript: ${err}`);
    }
  }

  await flushTraces();

  // ADR-008: interrupted turns count as substantive — caller writes this into
  // last_substantive_trace_id so /feedback can target them.
  return { lastLine, turnsTraced, finalizedTraceId: turnsTraced > 0 ? finalizedTraceId : undefined };
}

// ─── Subagent tracing ────────────────────────────────────────────────────────

export interface PendingSubagent {
  agent_id: string;
  agent_type: string;
  agent_transcript_path: string;
  session_id: string;
}

/**
 * Trace pending subagents queued by SubagentStop, nested under the most
 * recently emitted root observation (OTLP has no re-open-trace-by-id; the
 * root's live span context is the parent handle).
 */
export function tracePendingSubagents(options: {
  sessionId: string;
  pendingSubagents: PendingSubagent[];
  taskRunMap: Record<string, { observation_id: string; deferred: Record<string, unknown> }>;
  parentTraceId: string | undefined;
}): void {
  const { sessionId, pendingSubagents, taskRunMap } = options;

  if (!idGenerator) throw new Error("Langfuse tracing not initialized");
  const parentCtx = lastRootSpanContext;
  if (!parentCtx) {
    logger.warn("Cannot trace subagents: no root observation emitted this invocation");
    return;
  }

  // Re-establish the turn's propagation scope: subagent generations are
  // cost-bearing children of the same trace, and v5's observations-first
  // model wants session/user on every one of them.
  propagateAttributes(
    { sessionId, ...(lastRootPropagation?.userId ? { userId: lastRootPropagation.userId } : {}) },
    () => {
      emitSubagents(pendingSubagents, taskRunMap, parentCtx);
    },
  );
}

function emitSubagents(
  pendingSubagents: PendingSubagent[],
  taskRunMap: Record<string, { observation_id: string; deferred: Record<string, unknown> }>,
  parentCtx: SpanContext,
): void {
  for (const subagent of pendingSubagents) {
    try {
      const taskRunInfo = taskRunMap[subagent.agent_id];
      const toolName = subagent.agent_type || "Agent";

      logger.debug(`Processing subagent ${toolName} (${subagent.agent_id})`);

      if (taskRunInfo?.deferred) {
        const def = taskRunInfo.deferred;
        const agentToolSpan = startObservation(
          `Tool: Agent (${toolName})`,
          {
            input: def.tool_input as Record<string, unknown>,
            output: def.tool_output as Record<string, unknown>,
            metadata: { agent_id: subagent.agent_id, agent_type: toolName },
          },
          { asType: "tool", startTime: new Date(def.start_time as number), parentSpanContext: parentCtx },
        );
        agentToolSpan.end(new Date(def.end_time as number));
      }

      const { messages: subagentMessages } = readTranscript(subagent.agent_transcript_path, -1);
      if (subagentMessages.length === 0) {
        logger.debug(`Empty subagent transcript: ${subagent.agent_transcript_path}`);
        continue;
      }

      const subagentTurns = groupIntoTurns(subagentMessages);

      const subagentSpan = startObservation(
        `${toolName} Subagent`,
        { metadata: { agent_id: subagent.agent_id, agent_type: toolName, turns: subagentTurns.length } },
        { asType: "agent", parentSpanContext: parentCtx },
      );
      const subagentCtx = subagentSpan.otelSpan.spanContext();

      for (let i = 0; i < subagentTurns.length; i++) {
        const turn = subagentTurns[i];
        const userText =
          typeof turn.userContent === "string" ? truncate(turn.userContent) : JSON.stringify(turn.userContent);
        const finalText =
          turn.llmCalls.length > 0 ? truncate(extractText(turn.llmCalls[turn.llmCalls.length - 1].content)) : "";

        const turnSpan = startObservation(
          `Subagent Turn ${i + 1}`,
          {
            input: { role: "user", content: userText },
            output: { role: "assistant", content: finalText },
            metadata: { turn_number: i + 1 },
          },
          { parentSpanContext: subagentCtx },
        );
        const turnCtx = turnSpan.otelSpan.spanContext();

        for (let j = 0; j < turn.llmCalls.length; j++) {
          emitLLMCall(turnCtx, j + 1, turn.llmCalls.length, turn.llmCalls[j], userText);
        }

        turnSpan.end();
      }

      subagentSpan.end();
      logger.log(`Traced subagent ${toolName} (${subagent.agent_id}): ${subagentTurns.length} turn(s)`);
    } catch (err) {
      logger.error(`Failed to trace subagent ${subagent.agent_id}: ${err}`);
    }
  }
}
