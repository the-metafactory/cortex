---
id: "F-4"
feature: "cortex creds CLI (issue/revoke/rotate/list)"
status: "draft"
created: "2026-05-12"
---

# Specification: cortex creds CLI

## Overview

Ship `cortex creds` CLI subcommand with four sub-actions: `issue`, `revoke`, `rotate`, `list`. Manages per-agent NATS credentials.

Per the locked design (cortex#58 D8 + interview F-4 answers):

- **Single operator account, per-agent NATS users** (one keypair per agent)
- **Both NATS-IPC + UNIX socket transport** to the cortex daemon (NATS preferred, socket fallback)
- **Daemon-mediated signing** — CLI is thin; operator signing key lives in cortex daemon memory only
- **Fail-on-offline-revoke** — revoke aborts when NATS server unreachable

**v1 scope:** ship the CLI structure complete + `list --local` fully functional (filesystem scan). `issue`/`revoke`/`rotate` ship as structured "deferred" subcommands that emit a clear error pointing at the daemon-IPC follow-up. This matches the F-2/F-3 pattern where the foundational APIs ship before the cortex.ts integration that wires them into a running daemon.

## User Scenarios

### Scenario 1: Operator inventories per-agent creds

```bash
cortex creds list --local
# echo                 ~/.config/nats/creds/echo.creds      issued 2026-05-12T01:00
# holly                ~/.config/nats/creds/holly.creds     issued 2026-05-12T01:00
# codex-rev            ~/.config/nats/creds/codex-rev.creds issued 2026-05-12T01:00
```

**Acceptance Criteria:**
- [ ] `cortex creds list --local` scans `~/.config/nats/creds/` (configurable via `--creds-dir`)
- [ ] Output includes agent id (filename stem), full path, file mtime
- [ ] `--json` mode emits structured array
- [ ] Empty dir → exit 0, "0 creds files" message
- [ ] Sorted alphabetically by id

### Scenario 2: arc lifecycle calls `cortex creds issue <id>` during install

```bash
cortex creds issue foo
# (v1) → exit 2 with: "creds issue requires the cortex daemon (not yet wired); see <follow-up-issue>"
# (future) → mints user JWT via daemon-IPC, writes ~/.config/nats/creds/foo.creds
```

**Acceptance Criteria (v1):**
- [ ] `cortex creds issue <id>` returns exit 2 with a clear "not yet implemented — pending daemon IPC" message
- [ ] Error message names the cortex repo follow-up issue (`cortex#TBD — cortex creds daemon-IPC integration`)
- [ ] Help text documents the deferral

**Acceptance Criteria (future, not in F-4 v1):**
- [ ] Mints NATS user JWT via daemon RPC (NATS req/rep, UNIX socket fallback)
- [ ] Writes creds file with `chmod 600`
- [ ] Capability scope read from the agent's fragment in `agents.d/`

### Scenario 3: Operator runs `cortex creds revoke <id>`

```bash
cortex creds revoke foo
# (v1) → exit 2 with deferral message
# (future) → server-side revoke FIRST (NATS account JWT update), then rm local creds file
```

**Acceptance Criteria:** as scenario 2 — v1 ships the stub, future implementation per cortex#58 D7.

### Scenario 4: Operator runs `cortex creds rotate <id>`

Same shape: v1 stubs, future = revoke + issue atomic.

## Functional Requirements

### FR-1: `cortex creds list [--local] [--creds-dir <path>] [--json]`

- `--local` flag (default) scans the local creds directory (`~/.config/nats/creds/` by default).
- `--creds-dir <path>` overrides the default location.
- `--json` mode emits `{ status, creds: [{id, path, issuedAt}], error? }`.
- File matched: any non-dotfile in the directory.
- `id` derived from filename stem (strip extension).
- `issuedAt` derived from filesystem `mtime` in ISO 8601.
- Sorted alphabetically by id.

### FR-2: `cortex creds issue <id> [--config <path>]` (v1: deferred)

- Returns exit 2 with the deferred message.
- Help text explains the daemon-IPC dependency.
- `<id>` positional argument validated against agent-id regex (`/^[a-z0-9-]+$/`) at CLI level before any daemon talk.

### FR-3: `cortex creds revoke <id> [--config <path>]` (v1: deferred)

- Same shape as issue. Validates id regex.

### FR-4: `cortex creds rotate <id> [--config <path>]` (v1: deferred)

- Same shape.

### FR-5: Top-level `cortex creds --help`

- Documents all four subcommands
- Names which are deferred and points at the follow-up

### FR-6: JSON envelope

Matches F-3's contract shape:

```ts
interface CredsJsonEnvelope {
  status: "ok" | "error";
  creds: { id: string; path: string; issuedAt: string }[];
  error?: { reason: string; subcommand: string };
}
```

`creds: []` is always present (empty on error).

## Non-Functional Requirements

- **Performance:** list under 50ms for ≤100 files.
- **Security:**
  - CLI never reads operator signing key from disk. v1 stubs make this trivially true.
  - List output does NOT include creds file content — only file metadata.
- **Failure behavior:**
  - Missing `--creds-dir` (or default `~/.config/nats/creds/`) → exit 0 with "0 creds files" (not an error; operator hasn't issued any yet).
  - Invalid agent id syntax → exit 2 with regex hint.
  - Deferred subcommand → exit 2 with named follow-up issue.

## Key Entities

| Entity | Description |
|--------|-------------|
| `parseCredsArgs(argv)` | Hand-rolled parser, throws `CredsArgsError` on bad flags. |
| `runCredsList(args)` | List local creds files. |
| `runCredsIssue/Revoke/Rotate(args)` | Stubs returning exit 2 with deferral message. |
| `dispatchCreds(argv)` | Top-level subcommand router. |
| `CredsJsonEnvelope` | JSON contract type, exported. |

## Success Criteria

- [ ] `cortex creds list --local` lists files in a tmp creds dir
- [ ] Empty dir handled gracefully
- [ ] All three deferred subcommands return exit 2 with the documented message
- [ ] `--json` mode works on all four (deferred ones emit error envelope)
- [ ] 25+ tests pass; tsc clean
- [ ] Echo review approves with 0 blockers / 0 majors

## Out of Scope

- **Daemon-IPC implementation** — the actual NATS req/rep and UNIX socket dispatch lands when cortex.ts gains the daemon-side RPC handler.
- **Server-side creds revocation** — requires the daemon to talk to NATS account-server APIs.
- **JWT inspection** — `list` shows mtime, not JWT claims. JWT-parsing for `expiresAt` could be added later if operators ask.
- **Creds file write permissions** — daemon-side concern (when implemented, it'll write with `chmod 600`).
