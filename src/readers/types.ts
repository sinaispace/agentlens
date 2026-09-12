/**
 * The contract every connector implements.
 *
 * Types are duplicated from `apps/web/lib/ingest/contract.ts` rather than
 * imported: this package is published to npm and installed by `npx` on
 * developer machines, so it must not depend on the server workspace. The
 * `version` field is what keeps the two in step — a mismatch is rejected by
 * the server with an explicit message.
 */

export const INGEST_VERSION = 1;

export type CollectedEvent = {
  seq: number;
  ts: string;
  kind: "message" | "tool_call" | "error";
  role?: "user" | "assistant" | "system" | null;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** 1-hour cache writes cost 2x input vs 1.25x for 5-minute — split matters. */
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
  toolName?: string | null;
  toolOk?: boolean | null;
  durationMs?: number | null;
  meta?: Record<string, unknown> | null;
  body?: { prompt?: string; response?: string; diff?: string } | null;
};

export type CollectedSession = {
  agentKind: string;
  agentName?: string;
  vendor?: string;
  externalId: string;
  repoPath?: string | null;
  startedAt: string;
  endedAt?: string | null;
  model?: string | null;
  events: CollectedEvent[];
};

export type Reader = {
  /** Stable connector id, e.g. "claude-code". */
  kind: string;
  displayName: string;
  vendor: string;
  /** Where this agent keeps its data, shown by `connect`. */
  dataDir: string;
  /** Cheap existence check — must not read or parse anything. */
  detect(): boolean;
  /**
   * Sessions started at or after `since`. Returning a session again is
   * expected and safe: the server dedupes on `(agent, externalId)` and
   * `(session, seq)`.
   */
  read(options: ReadOptions): Promise<CollectedSession[]>;
};

export type ReadOptions = {
  /** ISO timestamp watermark from the last successful sync, if any. */
  since?: string | null;
  /** Drop prompt/response/diff text, keeping metrics only. */
  redact: boolean;
  /** Safety valve for a first backfill on a very old machine. */
  maxSessions?: number;
};
