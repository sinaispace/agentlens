# @sinaispace/agentlens

The AgentLens collector. Reads the session logs your AI coding agents already
write on this machine and streams usage, cost and performance metrics to
[AgentLens](https://agentlens.sinaispace.com).

**Read-only.** No proxy sits in front of your model calls, no provider API keys
are read, stored or transmitted, and nothing about your inference path changes.
If AgentLens is unreachable your agents keep working and the collector
backfills on the next run.

## Usage

```bash
npx @sinaispace/agentlens connect --token al_...
```

Create a token in AgentLens → Settings → Collector tokens.

```bash
npx @sinaispace/agentlens sync      # upload anything new since last sync
npx @sinaispace/agentlens status    # what is connected, how far it has synced
```

## Commands

| Command | What it does |
|---|---|
| `connect --token <token>` | Detect local agents, verify the token, save config, backfill. `--url` for self-hosted, `--redact` for metrics only, `--no-sync` to skip the first backfill. |
| `sync` | Upload sessions written since the last successful sync. `--dry-run` to preview, `--full` to re-read everything, `--max-sessions <n>` to cap a first backfill. |
| `status` | Server, token prefix, redaction state and per-agent sync watermarks. |

Re-syncing is always safe: the server deduplicates on session and event
identity, so `--full` re-reads without creating duplicates.

## Project mapping

Put an `agentlens.yml` at your repo root and the collector applies it on every
sync, before uploading — so newly declared projects attribute the very sessions
that run is about to send, and sessions collected earlier are attributed too.

```yaml
team: platform-eng
budget_usd: 2000

projects:
  payments-api:
    repos: [org/payments-api]
    budget_usd: 900
  web-app:
    repos: [org/web, org/design-system]
```

`repos` entries match the trailing path segments of a session's working
directory, so absolute paths differ safely between machines: a bare name
(`payments-api`) matches the last segment, and `org/payments-api`
disambiguates two repos that share a name.

The file is found by walking up from wherever the command runs, stopping at the
repo root. Reconciliation is additive — it never deletes a project or rule, so
a colleague on a stale checkout cannot remove projects you just added.

## Supported agents

Agents that write session logs locally are detected automatically:

| Agent | Location |
|---|---|
| Claude Code | `~/.claude/projects` |
| Codex CLI | `~/.codex/sessions` |

More connectors are landing — Gemini CLI and OpenCode next.

Agents that only report at organisation level (GitHub Copilot, Cursor,
Windsurf, Amp) cannot be detected from a developer machine. Those are connected
once by an admin in AgentLens, not with this CLI.

Anything else can push to the ingest REST API directly.

## Privacy

Prompt, response and diff bodies are uploaded so the history is searchable. To
keep metrics only and leave all text on this machine:

```bash
npx @sinaispace/agentlens connect --token al_... --redact
```

Configuration and the collector token live in `~/.agentlens/config.json`,
created with mode `600`.

## Environment

| Variable | Purpose |
|---|---|
| `AGENTLENS_TOKEN` | Collector token, overrides the config file |
| `AGENTLENS_URL` | Server URL (self-hosted installs) |
| `AGENTLENS_CONFIG` | Config path, default `~/.agentlens/config.json` |
| `CLAUDE_CONFIG_DIR` | Claude Code data directory, default `~/.claude` |

Requires Node 20.9 or newer. No runtime dependencies.

## License

MIT
