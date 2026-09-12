import { ApiError, verify } from "../api.js";
import { configPath, loadConfig, saveConfig } from "../config.js";
import { detected, readers } from "../readers/index.js";
import { arrow, bold, dim, fail, ok, warn } from "../ui.js";
import { sync } from "./sync.js";

export type ConnectOptions = {
  token?: string;
  url?: string;
  redact?: boolean;
  /** Detect and save, but skip the first backfill. */
  noSync?: boolean;
};

/**
 * The command the landing page promises: detect local agents, verify the token
 * against the server, save config, then backfill.
 */
export async function connect(options: ConnectOptions): Promise<number> {
  const config = loadConfig();
  const token = options.token || config.token;
  const url = (options.url || config.url).replace(/\/+$/, "");

  if (!token) {
    fail("A collector token is required.");
    console.error(
      "\n  Create one in AgentLens → Settings → Collector tokens, then run:\n" +
        `    ${bold("npx @sinaispace/agentlens connect --token al_...")}\n` +
        `\n  Or set ${bold("AGENTLENS_TOKEN")} in the environment.`,
    );
    return 1;
  }

  try {
    await verify(url, token);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      fail(
        "That token was rejected. It may have been revoked, or belong to another workspace.",
      );
    } else {
      fail(err instanceof Error ? err.message : String(err));
    }
    return 1;
  }

  const found = detected();
  for (const r of readers) {
    if (found.includes(r)) {
      ok(`detected ${r.kind.padEnd(14)} ${dim(r.dataDir)}`);
    } else {
      console.log(`${dim("·")} ${r.kind.padEnd(14)} ${dim("not found")}`);
    }
  }

  if (found.length === 0) {
    warn("No supported agents found. Nothing to sync yet — rerun after using one.");
  }

  saveConfig({
    ...config,
    url,
    token,
    redact: options.redact ?? config.redact,
  });
  arrow(`linked to ${url}  ${dim(`(config: ${configPath()})`)}`);

  if (options.redact ?? config.redact) {
    arrow("redaction on — prompt and response bodies stay on this machine");
  }

  if (options.noSync || found.length === 0) return 0;

  console.log("");
  return sync();
}
