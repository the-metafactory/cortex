---
id: "F-3"
feature: "cortex agents reload CLI"
status: "draft"
created: "2026-05-12"
depends_on: "F-2 (loadAgentsDirectory)"
---

# Specification: cortex agents reload CLI

## Overview

Ship `cortex agents` CLI subcommand with two sub-actions: `reload` and `list`. Validates `~/.config/cortex/agents.d/` fragments via F-2's `loadAgentsDirectory()` and prints results. Operator-facing diagnostic tool callable from arc lifecycle scripts after dropping a new fragment, or run standalone to inspect current agent registry.

This feature is a **validation-only CLI** in v1 — it does NOT talk to a running cortex daemon. Daemon-IPC (the actual "tell the running cortex to reload now" behavior) waits for cortex.ts startup integration of `AgentsDirectoryWatcher` and the operator-account daemon IPC channel (both follow-up work).

## User Scenarios

### Scenario 1: arc lifecycle script validates fragment after install

```bash
arc install foo-review-bot
# lifecycle postinstall calls:
cortex agents reload --config ~/.config/cortex/cortex.yaml
# Exit 0 → fragment loads cleanly; arc proceeds.
# Exit 1 → fragment invalid; arc rolls back.
```

**Acceptance Criteria:**
- [ ] `cortex agents reload` exits 0 when all fragments load cleanly
- [ ] `cortex agents reload` exits 1 when any fragment fails to load
- [ ] Error output names the failing file + reason
- [ ] Defaults `--config` to `~/.config/cortex/cortex.yaml`

### Scenario 2: Operator inspects current agent registry

```bash
cortex agents list
# echo                 — claude-code / in-process / 1 capability
# holly                — claude-code / in-process / 2 capabilities
# codex-rev            — codex / standalone / 1 capability
```

**Acceptance Criteria:**
- [ ] `cortex agents list` prints each loaded agent on its own line
- [ ] Output includes id, substrate, mode, capability count
- [ ] `--json` flag emits structured output for scripting
- [ ] Sorted alphabetically by id

### Scenario 3: Operator validates a specific fragment file

```bash
cortex agents reload --fragment ~/.config/cortex/agents.d/foo.yaml
# Validates ONLY that fragment, ignores others. Useful for pre-install dry-run.
```

**Acceptance Criteria:**
- [ ] `--fragment <path>` mode validates a single file
- [ ] Exit 0 / 1 as above
- [ ] Conflicts with id existing in the registry are warned but not errors (the file might not be installed yet)

## Functional Requirements

### FR-1: `cortex agents reload [--config <path>] [--fragment <path>] [--json]`

- Validates fragments via `loadAgentsDirectory()` (F-2).
- `--config <path>` (default: `~/.config/cortex/cortex.yaml`) determines where the `agents.d/` directory lives — sibling of the config file.
- `--fragment <path>` mode: parse + validate a single fragment file as `Agent` via `AgentSchema.parse()`. Doesn't run the directory loader.
- `--json` mode: emit structured JSON `{ status: "ok" | "error", agents: [{id, substrate, mode, capabilities}], error?: {file, reason} }`.
- Exit codes:
  - `0` — all fragments parse + validate
  - `1` — at least one fragment fails (named in error output)
  - `2` — usage error (bad flags / missing file)

### FR-2: `cortex agents list [--config <path>] [--json]`

- Lists agents from `loadAgentsDirectory(<configDir>/agents.d/)`.
- Default text format: `<id>  —  <substrate> / <mode> / <N> capabilities`.
- `--json` format: array of `{id, displayName, substrate, mode, capabilities}` objects.
- Sorted alphabetically by id.
- Exit codes:
  - `0` — list rendered (possibly empty)
  - `1` — loader failure
  - `2` — usage error

### FR-3: CLI dispatch shell

A small `src/cli/cortex/commands/agents.ts` entry handles the `agents` subcommand: parses the next positional (`reload` / `list`), dispatches to the right handler, prints help on no-subcommand or `--help`.

## Non-Functional Requirements

- **Performance**: load + report under 100ms for ≤50 fragments.
- **Security**: no shell expansion outside `~` → `$HOME` (via F-2's `expandTilde`).
- **Failure behavior**:
  - Loader throws `FragmentLoadError` → exit 1, name file + reason to stderr.
  - Config path doesn't exist → exit 2, name path to stderr.
  - Unknown subcommand → exit 2, print help.

## Key Entities

| Entity | Description |
|--------|-------------|
| `agentsReloadCommand(argv)` | Pure function — takes argv array, returns `{exitCode, stdout, stderr}` for testability. |
| `agentsListCommand(argv)` | Same shape. |
| `dispatchAgents(argv)` | Top-level dispatcher for the subcommand tree. |

## Success Criteria

- [ ] `bun src/cli/cortex/commands/agents.ts reload --config <tmp-config>` returns 0 against a valid agents.d/
- [ ] Same returns 1 against an agents.d/ with a malformed fragment
- [ ] `... agents list` prints the agent set in stable order
- [ ] `--json` flag emits parseable JSON
- [ ] 15+ tests pass; tsc clean
- [ ] Echo review approves with 0 blockers / 0 majors

## Out of Scope

- **Live daemon-reload IPC** — sending SIGHUP or NATS request/reply to a running cortex daemon. Waits for cortex.ts integration of `AgentsDirectoryWatcher` (separate follow-up).
- **`cortex agents add/remove`** — fragment authoring via CLI. Out of scope; arc + manual file edit are the v1 channels.
- **Trust resolution at the CLI** — the CLI uses `loadAgentsDirectory()` which doesn't run trust resolution. Construction of `AgentRegistry` (which DOES resolve trust) is deferred to the running daemon's startup path.
