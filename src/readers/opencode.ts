import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CollectedEvent, CollectedSession, Reader, ReadOptions } from "./types.js";

/**
 * OpenCode keeps everything in SQLite at
 * `~/.local/share/opencode/opencode.db` — no JSONL to walk.
 *
 * Verified against a real database:
 *  - `session` rows carry `directory`, `title`, `agent`, `model` and
 *    pre-aggregated token columns;
 *  - `message.data` is JSON with `role`, `time.created`, `modelID`,
 *    `providerID` and, for assistant turns,
 *    `tokens: { total, input, output, reasoning, cache: { read, write } }`;
 *  - `part.data` with `type: "tool"` carries `tool`, `callID` and
 *    `state.status`.
 *
 * Token semantics differ from the other connectors and this is the trap:
 * `input + output + reasoning + cache.read + cache.write === total` held for
 * every assistant message, so **`input` already excludes cache**. Subtracting
 * the cache here — as Gemini and Codex both require — would undercount input.
 *
 * Read through `node:sqlite`, which ships with Node rather than pulling a
 * native dependency into a package that has to stay `npx`-fast. It needs Node
 * 22+; on anything older the reader reports itself unavailable instead of
 * crashing the whole sync.
 */

const DATA_DIR =
  process.env.OPENCODE_DATA ||
  join(homedir(), ".local", "share", "opencode");
const DB_PATH = join(DATA_DIR, "opencode.db");

type SqliteModule = {
  DatabaseSync: new (
    path: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare: (sql: string) => { all: (...p: unknown[]) => Record<string, unknown>[] };
    close: () => void;
  };
};

async function loadSqlite(): Promise<SqliteModule | null> {
  try {
    return (await import("node:sqlite")) as unknown as SqliteModule;
  } catch {
    return null;
  }
}

export const opencodeReader: Reader = {
  kind: "opencode",
  displayName: "OpenCode",
  vendor: "SST",
  dataDir: DB_PATH,

  detect() {
    return existsSync(DB_PATH);
  },

  async read(options: ReadOptions): Promise<CollectedSession[]> {
    if (!this.detect()) return [];

    const sqlite = await loadSqlite();
    if (!sqlite) {
      throw new Error(
        "reading OpenCode needs Node 22+ (node:sqlite). Upgrade Node, or exclude this agent.",
      );
    }

    // Read-only: the user may have OpenCode open, and a collector must never
    // be able to modify an agent's own store.
    const db = new sqlite.DatabaseSync(DB_PATH, { readOnly: true });
    try {
      return collect(db, options);
    } finally {
      db.close();
    }
  },
};

function collect(
  db: {
    prepare: (sql: string) => { all: (...p: unknown[]) => Record<string, unknown>[] };
  },
  options: ReadOptions,
): CollectedSession[] {
  const sinceMs = options.since ? Date.parse(options.since) - 3_600_000 : 0;

  const sessions = db
    .prepare(
      `SELECT id, directory, title, agent, model, time_created
       FROM session
       WHERE time_created >= ?
       ORDER BY time_created DESC`,
    )
    .all(sinceMs) as unknown as {
    id: string;
    directory: string | null;
    title: string | null;
    agent: string | null;
    model: string | null;
    time_created: number;
  }[];

  const limited = sessions.slice(0, options.maxSessions ?? sessions.length);
  const out: CollectedSession[] = [];

  for (const s of limited) {
    const messages = db
      .prepare(
        `SELECT id, time_created, data FROM message
         WHERE session_id = ? ORDER BY time_created`,
      )
      .all(s.id) as unknown as {
      id: string;
      time_created: number;
      data: string;
    }[];

    const parts = db
      .prepare(
        `SELECT message_id, time_created, data FROM part
         WHERE session_id = ? ORDER BY time_created`,
      )
      .all(s.id) as unknown as {
      message_id: string;
      time_created: number;
      data: string;
    }[];

    const toolsByMessage = new Map<string, { name: string; ok: boolean | null; ts: number }[]>();
    for (const p of parts) {
      const d = safeJson(p.data);
      if (!d || d.type !== "tool") continue;

      const status = (d.state as Record<string, unknown> | undefined)?.status;
      const list = toolsByMessage.get(p.message_id) ?? [];
      list.push({
        name: typeof d.tool === "string" ? d.tool : "unknown",
        // Anything not explicitly completed or errored is unknown, not failed —
        // a session interrupted mid-call should not count against success rate.
        ok:
          status === "completed"
            ? true
            : status === "error" || status === "aborted"
              ? false
              : null,
        ts: p.time_created,
      });
      toolsByMessage.set(p.message_id, list);
    }

    const events: CollectedEvent[] = [];
    const modelCounts = new Map<string, number>();
    let seq = 0;
    let first = s.time_created;
    let last = s.time_created;

    for (const m of messages) {
      const d = safeJson(m.data);
      if (!d) continue;

      const created = numberOf(
        (d.time as Record<string, unknown> | undefined)?.created,
        m.time_created,
      );
      if (created < first) first = created;
      if (created > last) last = created;

      const model = modelIdOf(d);
      if (model) modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);

      const role = d.role === "user" ? "user" : d.role === "assistant" ? "assistant" : null;
      if (role) {
        events.push({
          seq: seq++,
          ts: new Date(created).toISOString(),
          kind: "message",
          role,
          model,
          ...(role === "assistant" ? usage(d.tokens) : {}),
          // Bodies live in `part` rows as text blocks; the collector keeps
          // metrics only for this connector until that mapping is verified.
          body: null,
        });
      }

      for (const t of toolsByMessage.get(m.id) ?? []) {
        if (t.ts < first) first = t.ts;
        if (t.ts > last) last = t.ts;
        events.push({
          seq: seq++,
          ts: new Date(t.ts).toISOString(),
          kind: "tool_call",
          model,
          toolName: t.name,
          toolOk: t.ok,
        });
      }
    }

    if (events.length === 0) continue;

    out.push({
      agentKind: opencodeReader.kind,
      agentName: opencodeReader.displayName,
      vendor: opencodeReader.vendor,
      externalId: s.id,
      repoPath: s.directory,
      startedAt: new Date(first).toISOString(),
      endedAt: new Date(last).toISOString(),
      model: dominant(modelCounts),
      events,
    });
  }

  return out;
}

/**
 * `input` already excludes cache here — verified, `input + output + reasoning +
 * cache.read + cache.write === total` on every assistant message. Subtracting
 * the cache as the Gemini and Codex readers must would undercount input.
 */
function usage(tokens: unknown) {
  if (typeof tokens !== "object" || tokens === null) return {};
  const t = tokens as Record<string, unknown>;
  const cache = (t.cache ?? {}) as Record<string, unknown>;

  return {
    inputTokens: num(t.input),
    // Reasoning tokens are generated and billed as output.
    outputTokens: num(t.output) + num(t.reasoning),
    cacheReadTokens: num(cache.read),
    cacheWriteTokens: num(cache.write),
  };
}

/** `{"providerID":"opencode","modelID":"big-pickle"}` → `opencode/big-pickle`. */
function modelIdOf(d: Record<string, unknown>): string | null {
  const provider = typeof d.providerID === "string" ? d.providerID : null;
  const model =
    typeof d.modelID === "string"
      ? d.modelID
      : typeof (d.model as Record<string, unknown> | undefined)?.modelID === "string"
        ? ((d.model as Record<string, unknown>).modelID as string)
        : null;

  if (!model) return null;
  return provider ? `${provider}/${model}` : model;
}

function safeJson(s: unknown): Record<string, unknown> | null {
  if (typeof s !== "string") return null;
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function numberOf(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
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
