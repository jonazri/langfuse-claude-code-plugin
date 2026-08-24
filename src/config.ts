/**
 * Configuration — reads from environment variables.
 */

export interface Config {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
  stateFilePath: string;
  debug: boolean;
  maxChars: number;
  /** Auth is injected by an egress gateway (e.g. OneCLI) that overwrites the
   *  Authorization header at request time — no real keys in this process. */
  gatewayAuth: boolean;
  /** Runner-driven drain-seam mode: no UserPromptSubmit hook runs, so Stop
   *  mints deterministic per-turn trace ids instead of early-returning when
   *  current_trace_id is absent. */
  seamMode: boolean;
  /** Prompt-management linkage stamped on every generation (name + version of
   *  the registered prompt the session is running). */
  promptName?: string;
  promptVersion?: number;
}

export function loadConfig(): Config {
  const gatewayAuth = (process.env.CC_LANGFUSE_GATEWAY_AUTH ?? "").toLowerCase() === "true";
  const seamMode = (process.env.CC_LANGFUSE_SEAM_MODE ?? "").toLowerCase() === "true";

  // Under gateway auth the SDK still builds a Basic header from these, but the
  // gateway replaces it in transit — placeholders keep the client constructible.
  const publicKey =
    process.env.CC_LANGFUSE_PUBLIC_KEY ??
    process.env.LANGFUSE_PUBLIC_KEY ??
    (gatewayAuth ? "gateway" : "");

  const secretKey =
    process.env.CC_LANGFUSE_SECRET_KEY ??
    process.env.LANGFUSE_SECRET_KEY ??
    (gatewayAuth ? "gateway" : "");

  const baseUrl =
    process.env.CC_LANGFUSE_BASE_URL ??
    process.env.LANGFUSE_BASE_URL ??
    "https://cloud.langfuse.com";

  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const stateFilePath = process.env.STATE_FILE ?? `${homeDir}/.claude/state/langfuse_state.json`;

  const debug = (process.env.CC_LANGFUSE_DEBUG ?? "").toLowerCase() === "true";

  const maxChars = parseInt(process.env.CC_LANGFUSE_MAX_CHARS ?? "50000", 10);

  const promptName = process.env.CC_LANGFUSE_PROMPT_NAME || undefined;
  const promptVersionRaw = parseInt(process.env.CC_LANGFUSE_PROMPT_VERSION ?? "", 10);
  const promptVersion = Number.isFinite(promptVersionRaw) ? promptVersionRaw : undefined;

  return {
    publicKey,
    secretKey,
    baseUrl,
    stateFilePath,
    debug,
    maxChars,
    gatewayAuth,
    seamMode,
    promptName,
    promptVersion,
  };
}
