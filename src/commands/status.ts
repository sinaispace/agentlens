import { ApiError, remoteStatus } from "../api.js";
import { configPath, loadConfig } from "../config.js";
import { findConfigFile } from "../config-file.js";
import { detected, readers } from "../readers/index.js";
import { bold, dim, warn } from "../ui.js";

/** The `agentlens status` output the landing page shows. */
export async function status(): Promise<number> {
  const config = loadConfig();

  if (!config.token) {
    warn("Not connected. Run `agentlens connect --token <token>`.");
    return 1;
  }

  const found = detected();

  console.log(bold("agentlens status"));
  console.log("");
  console.log(`  server      ${config.url}`);
  console.log(`  token       ${config.token.slice(0, 11)}${dim("…")}`);
  console.log(`  config      ${dim(configPath())}`);
  console.log(`  redaction   ${config.redact ? "on" : "off"}`);
  console.log(`  agents      ${found.length} of ${readers.length} detected`);

  for (const r of found) {
    const mark = config.watermarks[r.kind];
    console.log(
      `    ${r.kind.padEnd(14)} ${mark ? `synced through ${mark.slice(0, 19).replace("T", " ")}` : dim("never synced")}`,
    );
  }

  const file = findConfigFile();
  console.log(`  config file ${file ? file.path : dim("no agentlens.yml found")}`);

  // Workspace-side numbers live on the server, so this is a network call — a
  // failure here should degrade the output, not fail the command.
  try {
    const r = await remoteStatus(config.url, config.token);
    console.log("");
    console.log(`  projects    ${r.projects} mapped across ${r.teams} team${r.teams === 1 ? "" : "s"}`);
    console.log(`  sessions    ${r.sessionsMtd} this month`);
    const budget = r.budgetUsd > 0 ? ` / ${usd(r.budgetUsd)}` : "";
    console.log(`  spend MTD   ${usd(r.spendMtd)}${budget}`);
    if (r.budgetUsd > 0 && r.spendMtd >= r.budgetUsd * 0.8) {
      const pct = Math.round((r.spendMtd / r.budgetUsd) * 100);
      warn(`  budget      ${pct}% of the monthly cap used`);
    }
  } catch (err) {
    console.log("");
    warn(
      err instanceof ApiError && err.status === 401
        ? "token rejected — it may have been revoked"
        : `could not reach ${config.url}`,
    );
  }

  return 0;
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
