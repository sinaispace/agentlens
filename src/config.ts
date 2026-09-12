import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `~/.agentlens/config.json`, chmod 600 — it holds the collector token.
 *
 * The sync watermark lives here too, per agent, so a re-sync only walks files
 * touched since the last successful upload.
 */

export type Config = {
  url: string;
  token: string;
  redact: boolean;
  /** agent kind → ISO timestamp of the newest session accepted by the server. */
  watermarks: Record<string, string>;
};

const CONFIG_PATH =
  process.env.AGENTLENS_CONFIG || join(homedir(), ".agentlens", "config.json");

const DEFAULTS: Config = {
  url: "https://agentlensapp.sinaispace.com",
  token: "",
  redact: false,
  watermarks: {},
};

export function configPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): Config {
  // Environment wins over the file, so CI can run without writing one.
  const env = {
    url: process.env.AGENTLENS_URL,
    token: process.env.AGENTLENS_TOKEN,
  };

  let onDisk: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as Partial<Config>;
    } catch {
      // Corrupt config shouldn't wedge the CLI — fall back to defaults and let
      // `connect` rewrite it.
    }
  }

  return {
    url: (env.url || onDisk.url || DEFAULTS.url).replace(/\/+$/, ""),
    token: env.token || onDisk.token || "",
    redact: onDisk.redact ?? DEFAULTS.redact,
    watermarks: onDisk.watermarks ?? {},
  };
}

export function saveConfig(config: Config): void {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  try {
    chmodSync(CONFIG_PATH, 0o600);
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
}
