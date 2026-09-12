#!/usr/bin/env node
/**
 * Node prints an ExperimentalWarning to stderr the first time `node:sqlite` is
 * loaded, which the OpenCode reader needs. It lands in the middle of the sync
 * output and reads like a fault in AgentLens. Only that one warning is
 * filtered — everything else Node has to say still gets through.
 */
const emitWarning = process.emitWarning;
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning?.message;
  const type = typeof rest[0] === "string" ? rest[0] : undefined;
  if (type === "ExperimentalWarning" && /SQLite/i.test(text ?? "")) return;
  return (emitWarning as (...a: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

import { connect } from "./commands/connect.js";
import { status } from "./commands/status.js";
import { sync } from "./commands/sync.js";
import { bold, fail } from "./ui.js";
import { VERSION } from "./version.js";

const HELP = `${bold("agentlens")} ${VERSION} — usage, cost and performance analytics for AI coding agents

  ${bold("agentlens connect")} --token <token> [--url <url>] [--redact] [--no-sync]
      Detect local agents, verify the token, save config and backfill.

  ${bold("agentlens sync")} [--dry-run] [--full] [--max-sessions <n>]
      Upload sessions written since the last successful sync.
      --full re-reads everything; the server dedupes, so it is safe.

  ${bold("agentlens status")}
      Show what is connected and how far it has synced.

Environment:
  AGENTLENS_TOKEN     collector token (overrides config file)
  AGENTLENS_URL       server URL
  AGENTLENS_CONFIG    config path (default ~/.agentlens/config.json)
  CLAUDE_CONFIG_DIR   Claude Code data dir (default ~/.claude)

Everything is read-only. No model keys are read, stored or transmitted.
`;

type Flags = { values: Record<string, string | boolean>; positional: string[] };

/** Minimal parser — this CLI runs under npx, so it stays dependency-free. */
function parse(argv: string[]): Flags {
  const values: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      values[key] = next;
      i++;
    } else {
      values[key] = true;
    }
  }
  return { values, positional };
}

async function main(): Promise<number> {
  const { values, positional } = parse(process.argv.slice(2));
  const command = positional[0];

  if (values.version || values.v) {
    console.log(VERSION);
    return 0;
  }
  if (!command || values.help || values.h || command === "help") {
    console.log(HELP);
    return command || values.help || values.h ? 0 : 1;
  }

  const str = (k: string) => (typeof values[k] === "string" ? (values[k] as string) : undefined);
  const int = (k: string) => {
    const v = str(k);
    const n = v ? Number.parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };

  switch (command) {
    case "connect":
      return connect({
        token: str("token"),
        url: str("url"),
        redact: values.redact === true ? true : undefined,
        // `--no-sync` arrives as values.sync === false only with a parser that
        // understands negation; keep it explicit instead.
        noSync: values["no-sync"] === true,
      });

    case "sync":
      return sync({
        dryRun: values["dry-run"] === true,
        full: values.full === true,
        maxSessions: int("max-sessions"),
      });

    case "status":
      return status();

    default:
      fail(`Unknown command: ${command}`);
      console.error(HELP);
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
