# user-auth

User, agent, and role auth surface for the Mission Control worker. Absorbed
from the standalone `grove-auth` repo
([the-metafactory/grove-auth](https://github.com/the-metafactory/grove-auth))
in cortex#198 as part of the grove → cortex consolidation.

This module is now first-class cortex source. There is no upstream sync
relationship — edit it like any other worker code.

## What lives here

- **`types.ts`** — Role hierarchy (`viewer < operator < admin`), scope hierarchy
  (`read < write < admin`), user/agent/grant records, the `AuthBindings`
  env shape consumed by the worker.
- **`authorize.ts`** — Pure decision functions: `checkRole`, `checkAgentAccess`.
  No I/O; testable in isolation.
- **`middleware/`** — Hono middleware composed by the worker entrypoint:
  - `require-auth.ts` — CF Access JWT → D1 user lookup → context binding.
  - `require-role.ts` — Role-gate factory (`requireRole("admin")` etc.).
  - `require-agent-access.ts` — Agent grant-scope gate.
  - `cf-access.ts` — CF Access JWT validation primitives.
  - `audit.ts` — Audit-log emitter (fire-and-forget, writes to D1).
- **`routes/auth.ts`** — `authRoutes` Hono router mounted by the worker
  at `/auth/*` (whoami, enrol, etc.).
- **`index.ts`** — Public re-exports. Consumers import from `./user-auth`
  (or `../user-auth` from the routes/ subdir).

## What was intentionally not absorbed

- `src/middleware/require-role.test.ts` and `src/routes/auth.test.ts` from
  upstream — the worker doesn't run tests today, so the test surface stays
  in the original repo until cortex's worker grows a test runner.
- `src/schema/*.sql` — schema lives in the worker's own
  `migrations/` directory (`0001_auth_tables.sql`, `0002_seed_data.sql`).
  Those files were forked from grove-auth at a similar time; if the schema
  drifts, sync direction is cortex → upstream, since cortex is the live
  consumer.

## Relationship to the worker's existing `auth.ts`

`src/auth.ts` in the worker is a different surface — operator API-key auth
(`requireApiKey`, `requireAdmin`, `PrincipalKey`) for bot operators posting
to `/api/ingest`. It does not overlap with anything here. The two coexist:
operator-key auth gates the ingest path; user-auth gates the dashboard
read path.

## Provenance

Absorbed from `the-metafactory/grove-auth` at SHA
`5a0785766b52172d8a4e9091f9189a6096112d52` ("chore: bump to v0.4.1",
2026-04-03 baseline + small follow-ups). See cortex#198 for the absorption
rationale and the CI failure mode (`bun install --frozen-lockfile` blew up
on the `file:../grove-auth` sibling-path dep, which only resolved on
Andreas's local filesystem).
