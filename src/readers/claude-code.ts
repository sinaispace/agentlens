import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { CollectedEvent, CollectedSession, Reader, ReadOptions } from "./types.js";

/**
 * Claude Code writes one JSONL file per session under
 * `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`.
 *
 * Verified against real transcripts: `assistant` lines carry `message.usage`
 * with input/output/cache-read/cache-creation counts and `message.model`;
 * `tool_use` blocks live in assistant content; matching `tool_result` blocks
 * come back on the following `user` line and carry `is_error` when the call
 * failed. `cwd` and `gitBranch` are on both user and assistant lines.
 *
 * Line types we deliberately ignore: `attachment`, `queue-operation`,
 * `ai-title`, `last-prompt`, `mode` — UI bookkeeping with no analytic value.
 */

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const PROJECTS_DIR = join(CLAUDE_DIR, "projects");

/** Claude Code's placeholder model on synthetic messages — not a real call. */
const SYNTHETIC_MODEL = "<synthetic>";

type Line = {
  type?: string;
  timestamp?: string;
  cwd?: string;
  gitBranch?: string;
  sessionId?: string;
  subtype?: string;
  level?: string;
  message?: {
    role?: string;
    model?: string;
    content?: unknown;
    usage?: Record<string, unknown>;
  };
};

export const claudeCodeReader: Reader = {
  kind: "claude-code",
  displayName: "Claude Code",
  vendor: "Anthropic",
  dataDir: PROJECTS_DIR,

  detect() {
    return existsSync(PROJECTS_DIR);
  },

  async read(options: ReadOptions): Promise<CollectedSession[]> {
    if (!this.detect()) return [];

    const files = listSessionFiles();
    const sinceMs = options.since ? Date.parse(options.since) : null;

    // mtime is a cheap pre-filter: a session file is only appended to, so one
    // untouched since the last sync cannot contain new events. Slack of one
    // hour covers clock skew between machine and server.
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

    const limit = options.maxSessions ?? ordered.length;
    const sessions: CollectedSession[] = [];

    for (const file of ordered.slice(0, limit)) {
      const session = parseSessionFile(file, options.redact);
      if (session && session.events.length > 0) sessions.push(session);
    }

    return sessions;
  },
};

function safeMtime(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}

function listSessionFiles(): string[] {
  const out: string[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return out;
  }

  for (const d of dirs) {
    const dir = join(PROJECTS_DIR, d);
    try {
      if (!statSync(dir).isDirectory()) continue;
      for (const f of readdirSync(dir)) {
        if (f.endsWith(".jsonl")) out.push(join(dir, f));
      }
    } catch {
      // Unreadable project dir — skip rather than fail the whole sync.
    }
  }
  return out;
}

function parseSessionFile(file: string, redact: boolean): CollectedSession | null {
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
      // A torn last line is normal while a session is being written.
    }
  }
  if (lines.length === 0) return null;

  // Pass 1: tool outcomes, so a tool_use can be emitted with its result.
  const toolOk = new Map<string, boolean>();
  for (const l of lines) {
    if (l.type !== "user" || !Array.isArray(l.message?.content)) continue;
    for (const c of l.message.content as Record<string, unknown>[]) {
      if (c?.type === "tool_result" && typeof c.tool_use_id === "string") {
        toolOk.set(c.tool_use_id, c.is_error !== true);
      }
    }
  }

  const events: CollectedEvent[] = [];
  const modelCounts = new Map<string, number>();
  let repoPath: string | null = null;
  let gitBranch: string | null = null;
  let seq = 0;
  let first: string | null = null;
  let last: string | null = null;

  for (const l of lines) {
    if (l.cwd && !repoPath) repoPath = l.cwd;
    if (l.gitBranch && !gitBranch) gitBranch = l.gitBranch;

    const ts = l.timestamp;
    if (!ts) continue;
    if (!first || ts < first) first = ts;
    if (!last || ts > last) last = ts;

    if (l.type === "user") {
      const text = textOf(l.message?.content);
      // A user line that is only tool_result carries no prompt — its signal is
      // already on the tool_call event.
      if (text) {
        events.push({
          seq: seq++,
          ts,
          kind: "message",
          role: "user",
          body: redact ? null : { prompt: text },
        });
      }
      continue;
    }

    if (l.type === "assistant") {
      const model = normaliseModel(l.message?.model);
      if (model) modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1);

      const u = l.message?.usage ?? {};
      const text = textOf(l.message?.content);

      events.push({
        seq: seq++,
        ts,
        kind: "message",
        role: "assistant",
        model,
        inputTokens: num(u.input_tokens),
        outputTokens: num(u.output_tokens),
        cacheReadTokens: num(u.cache_read_input_tokens),
        cacheWriteTokens: num(u.cache_creation_input_tokens),
        body: redact || !text ? null : { response: text },
      });

      if (Array.isArray(l.message?.content)) {
        for (const c of l.message.content as Record<string, unknown>[]) {
          if (c?.type !== "tool_use") continue;
          const id = typeof c.id === "string" ? c.id : null;
          events.push({
            seq: seq++,
            ts,
            kind: "tool_call",
            model,
            toolName: typeof c.name === "string" ? c.name : "unknown",
            // No matching tool_result means the session ended mid-call —
            // unknown, not failed.
            toolOk: id && toolOk.has(id) ? toolOk.get(id)! : null,
          });
        }
      }
      continue;
    }

    // Hook failures and other surfaced errors.
    if (l.type === "system" && (l.level === "error" || l.subtype === "error")) {
      events.push({ seq: seq++, ts, kind: "error" });
    }
  }

  if (!first) return null;

  return {
    agentKind: claudeCodeReader.kind,
    agentName: claudeCodeReader.displayName,
    vendor: claudeCodeReader.vendor,
    externalId: basename(file, ".jsonl"),
    repoPath,
    startedAt: new Date(first).toISOString(),
    endedAt: last ? new Date(last).toISOString() : null,
    model: dominant(modelCounts),
    events,
  };
}

function normaliseModel(m: unknown): string | null {
  if (typeof m !== "string" || m.length === 0) return null;
  return m === SYNTHETIC_MODEL ? null : m;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.trunc(v) : 0;
}

/** Sessions can switch models mid-run; the session-level label is the modal one. */
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

/** Text of a message, whether it is a bare string or a content-block array. */
function textOf(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const c of content as Record<string, unknown>[]) {
    if (c?.type === "text" && typeof c.text === "string") parts.push(c.text);
  }
  const joined = parts.join("\n").trim();
  return joined || null;
}
