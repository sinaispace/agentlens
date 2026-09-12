import { claudeCodeReader } from "./claude-code.js";
import type { Reader } from "./types.js";

/**
 * Registry of local-log connectors. Agents that only expose org-level usage
 * APIs (Copilot, Cursor, Windsurf, Amp) are deliberately absent — they are
 * connected once by an admin in the web app, not detected per machine.
 */
export const readers: Reader[] = [claudeCodeReader];

export function detected(): Reader[] {
  return readers.filter((r) => {
    try {
      return r.detect();
    } catch {
      return false;
    }
  });
}
