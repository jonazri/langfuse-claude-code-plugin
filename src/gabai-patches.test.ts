/**
 * GabAI fork patches (docs/observability-design.md §7.2 in the GabAI repo):
 * gateway auth, seam mode, per-turn sender extraction, and the deterministic
 * turn identity fields carried out of the transcript.
 */
import { describe, expect, it } from "vitest";
import { extractSenderIds } from "./langfuse.js";
import { groupIntoTurns } from "./transcript.js";
import { loadConfig } from "./config.js";
import { shouldTrace } from "./utils/hook-init.js";
import type { TranscriptMessage } from "./types.js";

describe("extractSenderIds (P4 per-turn userId)", () => {
  it("returns every distinct sender_id in order, first = the turn's author", () => {
    const text =
      '<message from="A" sender_id="slack:U1" time="t">hi</message>\n' +
      '<message from="B" sender_id="slack:U2">yo</message>\n' +
      '<message from="A" sender_id="slack:U1">again</message>';
    expect(extractSenderIds(text)).toEqual(["slack:U1", "slack:U2"]);
  });

  it("returns [] when no sender ids are embedded (task wakes)", () => {
    expect(extractSenderIds("scheduled wake, no senders")).toEqual([]);
  });
});

describe("groupIntoTurns carries promptId/userUuid/messageId (P3, deterministic ids)", () => {
  it("stamps each turn with its user row's promptId and uuid, and LLM calls with message.id", () => {
    const messages = [
      {
        type: "user",
        uuid: "uuid-user-1",
        promptId: "prompt-1",
        timestamp: "2026-08-24T00:00:00Z",
        message: { role: "user", content: 'x sender_id="slack:U1"' },
      },
      {
        type: "assistant",
        timestamp: "2026-08-24T00:00:01Z",
        message: {
          id: "msg_abc",
          role: "assistant",
          model: "claude-sonnet-5",
          content: [{ type: "text", text: "hello" }],
          usage: { input_tokens: 1, output_tokens: 2 },
          stop_reason: "end_turn",
        },
      },
    ] as unknown as TranscriptMessage[];

    const turns = groupIntoTurns(messages);
    expect(turns).toHaveLength(1);
    expect(turns[0].promptId).toBe("prompt-1");
    expect(turns[0].userUuid).toBe("uuid-user-1");
    expect(turns[0].llmCalls[0].messageId).toBe("msg_abc");
  });
});

describe("gateway-auth and seam-mode config (P1/P2/P3 env surface)", () => {
  it("substitutes placeholder keys under CC_LANGFUSE_GATEWAY_AUTH", () => {
    const saved = { ...process.env };
    try {
      delete process.env.CC_LANGFUSE_PUBLIC_KEY;
      delete process.env.CC_LANGFUSE_SECRET_KEY;
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      process.env.CC_LANGFUSE_GATEWAY_AUTH = "true";
      process.env.CC_LANGFUSE_SEAM_MODE = "true";
      process.env.CC_LANGFUSE_PROMPT_NAME = "gabai/library-search";
      process.env.CC_LANGFUSE_PROMPT_VERSION = "3";
      const cfg = loadConfig();
      expect(cfg.gatewayAuth).toBe(true);
      expect(cfg.seamMode).toBe(true);
      expect(cfg.publicKey).toBe("gateway");
      expect(cfg.secretKey).toBe("gateway");
      expect(cfg.promptName).toBe("gabai/library-search");
      expect(cfg.promptVersion).toBe(3);
    } finally {
      process.env = saved;
    }
  });

  it("keeps the shouldTrace gate untouched — gateway auth does not imply tracing", () => {
    expect(shouldTrace({ CC_LANGFUSE_GATEWAY_AUTH: "true" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldTrace({ TRACE_TO_LANGFUSE: "true" } as NodeJS.ProcessEnv)).toBe(true);
  });
});
