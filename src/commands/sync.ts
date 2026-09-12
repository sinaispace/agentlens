import { ApiError, pushConfig, upload } from "../api.js";
import { loadConfig, saveConfig } from "../config.js";
import { findConfigFile } from "../config-file.js";
import { detected } from "../readers/index.js";
import type { CollectedSession } from "../readers/types.js";
import { bold, dim, fail, ok, warn } from "../ui.js";

export type SyncOptions = {
  /** Read and report without uploading. */
  dryRun?: boolean;
  /** Ignore stored watermarks and re-read everything. */
  full?: boolean;
  maxSessions?: number;
};

/**
 * Sessions are uploaded in batches rather than one request, because a first
 * backfill can be tens of thousands of events. A failed batch is retried with
 * backoff and then left for the next run — the server dedupes, so nothing is
 * lost or doubled by retrying.
 */
const SESSIONS_PER_BATCH = 25;
const MAX_ATTEMPTS = 4;

export async function sync(options: SyncOptions = {}): Promise<number> {
  const config = loadConfig();

  if (!config.token) {
    fail("Not connected. Run `agentlens connect --token <token>` first.");
    return 1;
  }

  const agents = detected();
  if (agents.length === 0) {
    warn("No supported agents found on this machine.");
    return 0;
  }

  // Applied before sessions upload, so newly declared projects can attribute
  // the very sessions this run is about to send.
  if (!options.dryRun) await applyConfigFile(config.url, config.token);

  let totalSessions = 0;
  let totalEvents = 0;
  let failed = false;

  for (const reader of agents) {
    const since = options.full ? null : (config.watermarks[reader.kind] ?? null);

    let sessions: CollectedSession[];
    try {
      sessions = await reader.read({
        since,
        redact: config.redact,
        maxSessions: options.maxSessions,
      });
    } catch (err) {
      fail(`${reader.displayName}: could not read ${reader.dataDir} — ${msg(err)}`);
      failed = true;
      continue;
    }

    const events = sessions.reduce((n, s) => n + s.events.length, 0);
    if (sessions.length === 0) {
      console.log(`${dim("·")} ${reader.displayName.padEnd(14)} up to date`);
      continue;
    }

    if (options.dryRun) {
      console.log(
        `${dim("·")} ${reader.displayName.padEnd(14)} ${sessions.length} sessions, ${events} events ${dim("(dry run)")}`,
      );
      totalSessions += sessions.length;
      totalEvents += events;
      continue;
    }

    let watermark = since;
    let uploaded = 0;
    let uploadedEvents = 0;

    for (let i = 0; i < sessions.length; i += SESSIONS_PER_BATCH) {
      const batch = sessions.slice(i, i + SESSIONS_PER_BATCH);
      try {
        const res = await withRetry(() => upload(config.url, config.token, batch));
        uploaded += res.sessions;
        uploadedEvents += res.events;
        if (res.watermark && (!watermark || res.watermark > watermark)) {
          watermark = res.watermark;
        }
      } catch (err) {
        fail(`${reader.displayName}: ${msg(err)}`);
        failed = true;
        // Stop this agent but keep the watermark from batches that did land,
        // so the next run resumes rather than restarting.
        break;
      }
    }

    if (uploaded > 0) {
      ok(
        `${reader.displayName.padEnd(14)} ${uploaded} sessions, ${uploadedEvents} new events`,
      );
      totalSessions += uploaded;
      totalEvents += uploadedEvents;
    }

    if (watermark && watermark !== since) {
      config.watermarks[reader.kind] = watermark;
      saveConfig(config);
    }
  }

  if (totalSessions > 0) {
    const verb = options.dryRun ? "Would sync" : "Synced";
    const target = options.dryRun ? dim(`(nothing sent to ${config.url})`) : `→ ${config.url}`;
    console.log(`\n${bold(verb)} ${totalSessions} sessions · ${totalEvents} events ${target}`);
  }
  return failed ? 1 : 0;
}

/** Best effort: a malformed agentlens.yml must not block telemetry upload. */
async function applyConfigFile(url: string, token: string): Promise<void> {
  const found = findConfigFile();
  if (!found) return;

  try {
    const r = await pushConfig(url, token, found.text);
    const parts = [
      r.projectsCreated ? `${r.projectsCreated} created` : null,
      r.projectsUpdated ? `${r.projectsUpdated} updated` : null,
      r.sessionsAttributed ? `${r.sessionsAttributed} sessions attributed` : null,
    ].filter(Boolean);
    ok(`${"agentlens.yml".padEnd(14)} ${parts.length ? parts.join(", ") : "no changes"}`);
  } catch (err) {
    warn(`agentlens.yml not applied — ${msg(err)}`);
  }
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (err instanceof ApiError && !err.retryable) throw err;
      if (attempt === MAX_ATTEMPTS) break;
      // 1s, 2s, 4s — enough to ride out a restart without stalling a shell.
      await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
