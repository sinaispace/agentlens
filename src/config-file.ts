import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Finds `agentlens.yml` by walking up from a starting directory.
 *
 * The file belongs at a repo root, but `agentlens sync` is usually run from
 * wherever the developer happens to be, so searching upward is what makes the
 * documented workflow actually work. The walk stops at a `.git` directory —
 * beyond the repo root, a stray file in a parent folder is not this repo's
 * configuration.
 */

const FILENAMES = ["agentlens.yml", "agentlens.yaml", ".agentlens.yml"];
const MAX_DEPTH = 24;

export type FoundConfig = { path: string; text: string };

export function findConfigFile(startDir = process.cwd()): FoundConfig | null {
  let dir = resolve(startDir);

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    for (const name of FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        try {
          return { path: candidate, text: readFileSync(candidate, "utf8") };
        } catch {
          // Unreadable — keep walking rather than failing the sync.
        }
      }
    }

    // Repo root reached and nothing found: stop rather than escaping into the
    // user's home directory.
    if (existsSync(join(dir, ".git"))) return null;

    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }

  return null;
}
