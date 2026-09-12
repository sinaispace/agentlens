import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CollectedEvent, CollectedSession, Reader, ReadOptions } from "./types.js";

/**
 * Codex CLI writes one JSONL rollout per session under
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<iso>-<uuid>.jsonl`.
 *
 * Verified against real rollouts:
 *  - `session_meta.payload` carries `id`, `timestamp` and `cwd`;
 *  - `turn_context.payload` carries `cwd` and `model` (which is not always an
 *    OpenAI model — these files contain `gpt-5-codex`, `anthropic/…` and
 *    `google/…`, because Codex can be pointed at other providers);
 *  - `event_msg.payload.token_count.info.last_token_usage` is the per-turn
 *    delta, while `total_token_usage` is cumulative — summing the latter would
 *    multiply the bill;
 *  - `response_item.payload.function_call` has `name`, `arguments`, `call_id`;
 *  - the matching `function_call_output.output` is a JSON string containing
 *    `metadata.exit_code` and `metadata.duration_seconds`, which is where tool
 *    success and duration come from.
 */

const CODEX_DIR = process.env.CODEX_HOME || join(homedir(), ".codex");
const SESSIONS_DIR = join(CODEX_DIR, "sessions");

type Line = {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
};

export const codexReader: Reader = {
  kind: "codex",
  displayName: "Codex CLI",
  vendor: "OpenAI",
  dataDir: SESSIONS_DIR,

  detect() {
    return existsSync(SESSIONS_DIR);
  },

  async read(options: ReadOptions): Promise<CollectedSession[]> {
    if (!this.detect()) return [];

    const files = listRollouts();
    const sinceMs = options.since ? Date.parse(options.since) : null;

    const candidates = files.filter((f) => {
      if (sinceMs === null) return true;
      try {
        // One hour of slack for clock skew, as in the Claude Code reader.
        return statSync(f).mtimeMs >= sinceMs - 3_600_000;
      } catch {
        return false;
      }
    });

    const ordered = candidates
      .map((f) => ({ f, m: safeMtime(f) }))
      .sort((a, b) => b.m - a.m)
      .map((x) => x.f);

    const out: CollectedSession[] = [];
    for (const file of ordered.slice(0, options.maxSessions ?? ordered.length)) {
      const s = parseRollout(file, options.redact);
      if (s && s.events.length > 0) out.push(s);
    }
    return out;
  },
};

function safeMtime(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

/** Sessions are nested year/month/day, so this walks rather than globbing. */
function listRollouts(dir = SESSIONS_DIR, depth = 0, out: string[] = []): string[] {
  if (depth > 4) return out;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listRollouts(p, depth + 1, out);
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

function parseRollout(file: string, redact: boolean): CollectedSession | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return null;
  }

  const lines: Line[] = [];
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    try {
      lines.push(JSON.parse(l) as Line);
    } catch {
      // A torn final line is normal while a session is live.
    }
  }
  if (lines.length === 0) return null;

  const meta = lines.find((l) => l.type === "session_meta")?.payload ?? {};
  const externalId =
    typeof meta.id === "string"
      ? meta.id
      : // Fall back to the uuid in the filename rather than dropping the session.
        basename(file, ".jsonl").split("-").slice(-5).join("-");

  // Pass 1: tool outcomes keyed by call_id.
  const outcomes = new Map<string, { ok: boolean | null; durationMs: number | null }>();
  for (const l of lines) {
    if (l.payload?.type !== "function_call_output") continue;
    const callId = l.payload.call_id;
    if (typeof callId !== "string") continue;
    outcomes.set(callId, parseOutcome(l.payload.output));
  }

  const events: CollectedEvent[] = [];
  const modelCounts = new Map<string, number>();
  let repoPath: string | null = typeof meta.cwd === "string" ? meta.cwd : null;
  let seq = 0;
  let first: string | null = typeof meta.timestamp === "string" ? meta.timestamp : null;
  let last: string | null = first;

  /**
   * `token_count` arrives as its own line, not on the message it describes, so
   * usage is attached to the most recent assistant message. Emitting it as a
   * separate event would inflate the message count; dropping it would lose the
   * tokens entirely.
   */
  let lastAssistant: CollectedEvent | null = null;
  let pendingUsage: ReturnType<typeof parseUsage> | null = null;

  for (const l of lines) {
    const ts = l.timestamp ?? (typeof meta.timestamp === "string" ? meta.timestamp : null);
    if (ts) {
      if (!first || ts < first) first = ts;
      if (!last || ts > last) last = ts;
    }
    if (!ts) continue;

    if (l.type === "turn_context") {
      const m = l.payload?.model;
      if (typeof m === "string" && m) modelCounts.set(m, (modelCounts.get(m) ?? 0) + 1);
      if (typeof l.payload?.cwd === "string" && !repoPath) repoPath = l.payload.cwd;
      continue;
    }

    if (l.type === "event_msg") {
      const p = l.payload ?? {};

      if (p.type === "user_message") {
        const text = typeof p.message === "string" ? p.message : null;
        events.push({
          seq: seq++,
          ts,
          kind: "message",
          role: "user",
          body: redact || !text ? null : { prompt: text },
        });
        continue;
      }

      if (p.type === "agent_message") {
        const text = typeof p.message === "string" ? p.message : null;
        const ev: CollectedEvent = {
          seq: seq++,
          ts,
          kind: "message",
          role: "assistant",
          model: dominant(modelCounts),
          body: redact || !text ? null : { response: text },
        };
        // Usage reported before the message it belongs to.
        if (pendingUsage) {
          Object.assign(ev, pendingUsage);
          pendingUsage = null;
        }
        events.push(ev);
        lastAssistant = ev;
        continue;
      }

      if (p.type === "token_count") {
        const usage = parseUsage(p.info);
        if (!usage) continue;
        if (lastAssistant) Object.assign(lastAssistant, usage);
        else pendingUsage = usage;
        continue;
      }
      continue;
    }

    if (l.type === "response_item" && l.payload?.type === "function_call") {
      const callId = typeof l.payload.call_id === "string" ? l.payload.call_id : null;
      const outcome = callId ? outcomes.get(callId) : undefined;
      events.push({
        seq: seq++,
        ts,
        kind: "tool_call",
        model: dominant(modelCounts),
        toolName: typeof l.payload.name === "string" ? l.payload.name : "unknown",
        toolOk: outcome?.ok ?? null,
        durationMs: outcome?.durationMs ?? null,
      });
    }
  }

  if (!first) return null;

  return {
    agentKind: codexReader.kind,
    agentName: codexReader.displayName,
    vendor: codexReader.vendor,
    externalId,
    repoPath,
    startedAt: new Date(first).toISOString(),
    endedAt: last ? new Date(last).toISOString() : null,
    model: dominant(modelCounts),
    events,
  };
}

/**
 * `input_tokens` includes the cached portion, mirroring OpenAI's usage shape,
 * so uncached input is the difference. Reporting the raw figure as `input`
 * while also reporting `cached` would double-count.
 */
function parseUsage(info: unknown) {
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>).last_token_usage;
  if (typeof last !== "object" || last === null) return null;

  const u = last as Record<string, unknown>;
  const input = num(u.input_tokens);
  const cached = Math.min(num(u.cached_input_tokens), input);

  return {
    inputTokens: input - cached,
    cacheReadTokens: cached,
    // `reasoning_output_tokens` is a subset of `output_tokens`, not an
    // addition — adding it would inflate output by the reasoning again.
    outputTokens: num(u.output_tokens),
    cacheWriteTokens: 0,
  };
}

/** `output` is a JSON string carrying `metadata.exit_code` and duration. */
function parseOutcome(output: unknown): {
  ok: boolean | null;
  durationMs: number | null;
} {
  if (typeof output !== "string") return { ok: null, durationMs: null };
  try {
    const parsed = JSON.parse(output) as { metadata?: Record<string, unknown> };
    const meta = parsed.metadata;
    if (!meta) return { ok: null, durationMs: null };

    const exit = meta.exit_code;
    const seconds = meta.duration_seconds;
    return {
      ok: typeof exit === "number" ? exit === 0 : null,
      durationMs:
        typeof seconds === "number" && Number.isFinite(seconds)
          ? Math.round(seconds * 1000)
          : null,
    };
  } catch {
    // Not every tool returns JSON; an unparseable output is unknown, not failed.
    return { ok: null, durationMs: null };
  }
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

function dominant(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestN = 0;
  for (const [m, n] of counts) {
    if (n > bestN) {
      best = m;
      bestN = n;
    }
  }
  return best;
}
