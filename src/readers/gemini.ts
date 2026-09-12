import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CollectedEvent, CollectedSession, Reader, ReadOptions } from "./types.js";

/**
 * Gemini CLI writes one JSONL per session under
 * `~/.gemini/tmp/<project>/chats/session-<ts>-<shortId>.jsonl`.
 *
 * The file is an append log with occasional snapshots, which is the one thing
 * that must be got right — verified against a real session:
 *
 *  - line 0 is session metadata (`sessionId`, `projectHash`, `startTime`);
 *  - most lines are `$set` mutations, and a few of those carry a full
 *    `messages[]` snapshot of the history so far;
 *  - the rest are individual message records.
 *
 * In the verified session all 34 ids in the snapshot also appeared as
 * individual records, so reading both naively double-counts 34 messages and
 * their tokens. Messages are therefore deduplicated by `id`, last write wins,
 * which is correct whichever order they arrive in.
 *
 * Token semantics, also verified: `total === input + output + thoughts + tool`,
 * and `cached` is a *subset* of `input` (12055 in, 8117 cached, total 12121).
 * Reporting `input` raw alongside `cached` would double-count the cache.
 */

const GEMINI_DIR = process.env.GEMINI_CLI_HOME || join(homedir(), ".gemini");
const TMP_DIR = join(GEMINI_DIR, "tmp");

type Tokens = {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
  total?: number;
};

type Message = {
  id?: string;
  timestamp?: string;
  type?: string;
  content?: unknown;
  model?: string;
  tokens?: Tokens;
  toolCalls?: {
    id?: string;
    name?: string;
    status?: string;
    timestamp?: string;
  }[];
};

type Line = {
  sessionId?: string;
  projectHash?: string;
  startTime?: string;
  $set?: { messages?: Message[] };
} & Message;

export const geminiReader: Reader = {
  kind: "gemini-cli",
  displayName: "Gemini CLI",
  vendor: "Google",
  dataDir: TMP_DIR,

  detect() {
    return existsSync(TMP_DIR);
  },

  async read(options: ReadOptions): Promise<CollectedSession[]> {
    if (!this.detect()) return [];

    const files = listChatFiles();
    const sinceMs = options.since ? Date.parse(options.since) : null;

    const candidates = files.filter((f) => {
      if (sinceMs === null) return true;
      try {
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
      const s = parseSession(file, options.redact);
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

/** `~/.gemini/tmp/<project>/chats/*.jsonl` — the project folder name varies. */
function listChatFiles(): string[] {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = readdirSync(TMP_DIR);
  } catch {
    return out;
  }

  for (const p of projects) {
    const chats = join(TMP_DIR, p, "chats");
    try {
      if (!statSync(chats).isDirectory()) continue;
      for (const f of readdirSync(chats)) {
        if (f.endsWith(".jsonl")) out.push(join(chats, f));
      }
    } catch {
      // Not every tmp entry is a project directory.
    }
  }
  return out;
}

function parseSession(file: string, redact: boolean): CollectedSession | null {
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
      // Torn trailing line while the session is live.
    }
  }
  if (lines.length === 0) return null;

  const meta = lines[0] ?? {};
  const externalId = meta.sessionId ?? basename(file, ".jsonl");

  // Snapshots and individual records describe the same messages, so collapse
  // them by id before doing anything else.
  const byId = new Map<string, Message>();
  let order = 0;
  const seen = new Map<string, number>();

  const remember = (m: Message) => {
    if (!m?.id || !m.type) return;
    if (!seen.has(m.id)) seen.set(m.id, order++);
    byId.set(m.id, m);
  };

  for (const line of lines) {
    if (Array.isArray(line.$set?.messages)) {
      for (const m of line.$set.messages) remember(m);
    }
    if (line.type && line.id) remember(line);
  }

  const messages = [...byId.values()].sort(
    (a, b) => (seen.get(a.id!) ?? 0) - (seen.get(b.id!) ?? 0),
  );
  if (messages.length === 0) return null;

  const events: CollectedEvent[] = [];
  const modelCounts = new Map<string, number>();
  let seq = 0;
  let first: string | null = meta.startTime ?? null;
  let last: string | null = null;
  let repoPath: string | null = null;

  for (const m of messages) {
    const ts = m.timestamp ?? meta.startTime;
    if (!ts) continue;
    if (!first || ts < first) first = ts;
    if (!last || ts > last) last = ts;

    if (m.model) modelCounts.set(m.model, (modelCounts.get(m.model) ?? 0) + 1);

    const text = textOf(m.content);
    if (!repoPath && text) repoPath = workspaceFrom(text);

    if (m.type === "user") {
      events.push({
        seq: seq++,
        ts,
        kind: "message",
        role: "user",
        body: redact || !text ? null : { prompt: text },
      });
    } else if (m.type === "gemini") {
      events.push({
        seq: seq++,
        ts,
        kind: "message",
        role: "assistant",
        model: m.model ?? null,
        ...usage(m.tokens),
        body: redact || !text ? null : { response: text },
      });
    } else if (m.type === "error") {
      events.push({ seq: seq++, ts, kind: "error" });
    }
    // `info` records are UI bookkeeping — no analytic value.

    for (const call of m.toolCalls ?? []) {
      events.push({
        seq: seq++,
        ts: call.timestamp ?? ts,
        kind: "tool_call",
        model: m.model ?? null,
        toolName: call.name ?? "unknown",
        // Anything other than an explicit success/error is unknown, not failed.
        toolOk:
          call.status === "success"
            ? true
            : call.status === "error" || call.status === "cancelled"
              ? false
              : null,
      });
    }
  }

  if (!first) return null;

  return {
    agentKind: geminiReader.kind,
    agentName: geminiReader.displayName,
    vendor: geminiReader.vendor,
    externalId,
    // Falls back to the tmp folder name, which is the project's basename and
    // is exactly what a bare `repos:` rule matches on.
    repoPath: repoPath ?? projectFolder(file),
    startedAt: new Date(first).toISOString(),
    endedAt: last ? new Date(last).toISOString() : null,
    model: dominant(modelCounts),
    events,
  };
}

/**
 * `cached` is a subset of `input`, so uncached input is the difference.
 * `thoughts` are generated tokens billed as output; `tool` tokens are context
 * fed back in, so they count as input.
 */
function usage(t: Tokens | undefined) {
  if (!t) return {};
  const input = num(t.input);
  const cached = Math.min(num(t.cached), input);

  return {
    inputTokens: input - cached + num(t.tool),
    outputTokens: num(t.output) + num(t.thoughts),
    cacheReadTokens: cached,
    cacheWriteTokens: 0,
  };
}

/**
 * Gemini seeds a session with a context block naming the workspace. It is the
 * only place the absolute path appears — the folder name is just a basename
 * and the metadata carries a hash, not a path.
 */
function workspaceFrom(text: string): string | null {
  // The heading is markdown-bold in practice ("**Workspace Directories:**"),
  // so anything up to the newline is skipped rather than assumed absent.
  const m = text.match(/Workspace Directories:[^\n]*\n\s*-\s*(\/[^\n]+)/);
  return m ? m[1].trim() : null;
}

function projectFolder(file: string): string {
  // …/tmp/<project>/chats/<file>.jsonl
  const parts = file.split("/");
  const i = parts.lastIndexOf("chats");
  return i > 0 ? parts[i - 1] : "";
}

function textOf(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const c of content as Record<string, unknown>[]) {
    if (typeof c?.text === "string") parts.push(c.text);
  }
  const joined = parts.join("\n").trim();
  return joined || null;
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
