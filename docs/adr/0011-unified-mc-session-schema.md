# Unified Mission Control session schema across local + cloud

Status: accepted (2026-06-11, grill-with-docs session — MC session-tree modelling)

## Context

The Mission Control backend is **dual-substrate**: a local **bun:sqlite** database
(`src/surface/mc/db/schema.ts`) serves the in-process daemon at `:8767`, and a **Cloudflare
D1** database (`src/surface/mc/worker/`) serves the hosted pane at
`grove.meta-factory.ai/api/*`. They exist for complementary reasons:

- **Local** — serve Mission Control for one stack **without internet access**; it is also
  the only place the **session interior** lives (`events`/traces, `local`-scope per
  ADR-0005).
- **Cloud** — the complementary **network-wide** view: visibility across many principals'
  stacks, **lifecycle-metadata only** (no interiors).

These were built independently and **diverged into incompatible shapes** for the same
concept, with **no shared schema source**:

- **Local — normalized.** A "session" is `sessions → agent_task_assignment → agents +
  tasks` (a 4-table join); `agent_name` lives in `agents`, `status` in
  `agent_task_assignment.state`, `principal_id` in `tasks`. The orphan ingestor mints **one
  `agents` row per `cc_session_id`** (the source of the 1,044-tile flood, 2026-06-11).
- **Cloud — denormalized.** One flat `sessions` row carries `agent_id`, `agent_name`,
  `principal_id`, `status`, metrics, and the sovereignty columns
  (`classification`/`data_residency`/`home_principal`). No per-session agent row.

Neither carries the session-tree fields (`parent_session_id`, `substrate`). Extending two
diverged schemas separately is the exact drift bug class this session already hit
(mc/cockpit/grove schema divergence, #877/#879). With only two users today, the cost of
aligning is at its lowest.

## Decision

1. **One identical canonical session schema across both substrates.** The local and cloud
   `sessions` rows have the **same columns with the same meaning** — derived from a single
   shared schema source, not hand-maintained twice. The canonical shape is the **flat
   (denormalized) session-view**: `session_id`, `agent_id`, `agent_name`, `principal_id`,
   `parent_session_id`, `substrate`, `status`, `started_at`/`ended_at`, metrics, sovereignty
   (`classification`/`data_residency`/`home_principal`). The session-tree fields
   (`parent_session_id`, `substrate`) are part of the canonical schema **from the start**.

2. **Local denormalizes its session row to match** (rather than the cloud normalizing to
   the local model). Local keeps `tasks`/`agent_task_assignment` underneath **for the
   dispatch control plane**, but the `sessions` row carries the canonical columns directly,
   kept in sync on write. *(Rejected: a canonical SQL VIEW over the normalized tables — a
   join-per-read that yields the same shape but not a literally-identical stored row; we
   want byte-for-byte schema parity, so we denormalize.)*

3. **No domain-mapping / anti-corruption layer between local and cloud — deferred.** The two
   are kept as **one aligned data model**, not two domains with a translation seam. A
   mapping layer is premature at two users; revisit only if/when local and cloud needs
   genuinely diverge. *(Rejected for now: two-domains-plus-mapping — adds an interface and a
   translation surface to maintain for zero present benefit.)*

4. **Substrates differ in *reach* and *depth*, never *shape*.** Local = single-stack,
   offline, **holds the interior** (`events`). Cloud = network-wide, online,
   **metadata-only**. The `events`/interior table stays **local-only** — ADR-0005, interiors
   never leave the stack. This is the **one principled local-only table**, and it is a
   *depth* difference (what data), not a *shape* divergence (what a session row means).
   Convergence is on the session metadata; interiors are out of scope and stay put.

5. **A single shared schema source + a parity test prevent re-drift.** One canonical
   definition generates the bun:sqlite DDL, the D1 DDL + migration, and the TS types; a CI
   **parity test** fails if the two physical schemas drift. The **bus envelope is the
   contract** both ingest paths read (local relay → ingestor; cloud `cloud-publisher` →
   `/api/ingest`) — the session fields are added to the envelope once and both backends
   inherit them.

## Consequences

- **The session-tree refactor (`docs/refactor-mc-session-tree.md`) lands on the canonical
  schema once.** Its Phase 0 becomes **schema convergence** (define the canonical session
  model + shared source + parity test), not "extend two diverged schemas."
- **Local migration:** denormalize the `sessions` row to the canonical columns; **remove the
  per-session orphan `agents` minting** (sessions are not agents — CONTEXT.md §Sessions);
  observed sessions attach to the real owning agent with `agent_name` as a session column,
  matching cloud.
- **Cloud migration:** add `parent_session_id` + `substrate` to D1 (`schema.sql` +
  `0005_session_tree.sql`); the cloud was already close (flat, `agent_name` a column).
- **Drift is now caught in CI**, not in production on one surface — the recurring divergence
  bug class is closed structurally.
- **Future option preserved, not taken:** if a later need forces local and cloud apart, the
  deferred mapping layer (decision 3) is where that seam would be introduced — recorded so
  the next person knows it was a conscious "not yet," not an oversight.
- **ADR-0005 intact:** interiors remain local; convergence is metadata-shape only.

## References

- `CONTEXT.md` §Sessions + Flagged ambiguities (2026-06-11) — session / session tree /
  substrate-projection terminology.
- `compass/ecosystem/CONTEXT-MAP.md` — `session` / `substrate` boundary terms.
- `docs/refactor-mc-session-tree.md` — the deterministic change map (this ADR sets its
  Phase 0).
- ADR-0005 (session-interior locality), #877/#879 (the prior schema-divergence cluster).
