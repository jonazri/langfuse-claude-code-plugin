/**
 * OTLP transport for the v5 migration (GabAI patch set).
 *
 * Two pieces the stock stack cannot provide here:
 *
 * - FetchOtlpExporter: the default @langfuse/otel exporter rides
 *   @opentelemetry/exporter-trace-otlp-http, whose node http transport ignores
 *   proxy env vars — and this plugin's requests must traverse an
 *   authenticating egress gateway (OneCLI) that injects the real credential in
 *   transit. Global fetch honors HTTPS_PROXY under NODE_USE_ENV_PROXY=1, so
 *   the exporter serializes spans to OTLP-JSON and posts them with fetch.
 *   `x-langfuse-ingestion-version: 4` marks the payload for the v4 real-time
 *   read model.
 *
 * - QueuedIdGenerator: OTEL mints trace ids internally; queueing the next root
 *   trace id keeps this plugin's deterministic-id property (trace id derived
 *   from the turn's transcript user-row uuid) without synthesizing a fake
 *   remote parent, which would leave every root observation orphaned.
 */
import { createHash, randomBytes } from "node:crypto";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import type { ExportResult } from "@opentelemetry/core";
import type { ReadableSpan, SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { IdGenerator } from "@opentelemetry/sdk-trace-base";

/** Ingestion/network errors this invocation — flushes resolve even on failure,
 *  so the machine-readable outcome line reads this. */
const transportErrors: string[] = [];

export function getTransportErrors(): string[] {
  return transportErrors;
}

export class FetchOtlpExporter implements SpanExporter {
  private url: string;
  private authorization: string;
  private pending: Promise<void>[] = [];

  constructor(params: { baseUrl: string; publicKey: string; secretKey: string }) {
    this.url = `${params.baseUrl.replace(/\/$/, "")}/api/public/otel/v1/traces`;
    this.authorization = `Basic ${Buffer.from(`${params.publicKey}:${params.secretKey}`).toString("base64")}`;
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    const body = JsonTraceSerializer.serializeRequest(spans);
    if (!body) {
      resultCallback({ code: 0 });
      return;
    }
    const p = fetch(this.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-langfuse-ingestion-version": "4",
        authorization: this.authorization,
      },
      body: body as unknown as BodyInit,
    })
      .then(async (res) => {
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 300);
          transportErrors.push(`OTLP export HTTP ${res.status}: ${detail}`);
          resultCallback({ code: 1, error: new Error(`HTTP ${res.status}`) });
        } else {
          resultCallback({ code: 0 });
        }
      })
      .catch((err: unknown) => {
        transportErrors.push(`OTLP export failed: ${err instanceof Error ? err.message : String(err)}`);
        resultCallback({ code: 1, error: err instanceof Error ? err : new Error(String(err)) });
      })
      .then(() => undefined);
    this.pending.push(p);
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.pending);
  }

  async shutdown(): Promise<void> {
    await this.forceFlush();
  }
}

/** Deterministic 32-hex OTEL trace id from a transcript identifier: a uuid's
 *  hex is used as-is (dashes stripped); anything else hashes. */
export function deriveTraceId(id: string): string {
  const stripped = id.replace(/-/g, "").toLowerCase();
  if (/^[0-9a-f]{32}$/.test(stripped) && stripped !== "0".repeat(32)) return stripped;
  return createHash("sha256").update(id).digest("hex").slice(0, 32);
}

export class QueuedIdGenerator implements IdGenerator {
  private nextTraceId: string | null = null;

  /** Queue the trace id the NEXT root span will receive. Emission is
   *  strictly sequential in this plugin, so one slot suffices. */
  queueTraceId(traceIdHex: string): void {
    this.nextTraceId = traceIdHex;
  }

  generateTraceId(): string {
    const id = this.nextTraceId ?? randomBytes(16).toString("hex");
    this.nextTraceId = null;
    return id;
  }

  generateSpanId(): string {
    return randomBytes(8).toString("hex");
  }
}
