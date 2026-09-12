import { configPath, loadConfig } from "../config.js";
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

  return 0;
}
