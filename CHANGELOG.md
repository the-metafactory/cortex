# Cortex — Changelog

## 3.0.0 — 2026-05-21 — Vocabulary migration BREAKING

Cortex v3.0.0 completes the metafactory vocabulary migration 2026-05
(cortex#388, manifest at `docs/migrations/0001-vocabulary-grilled-2026-05.md`).
The v2.x transition-release back-compat shims are removed. Wire-level
envelope changes were already in place on v2.x via Luna's myelin
PR-1..PR-13 (myelin#165..#176) — what changes at v3 is the
deployment-config + env-var + TS-type surface.

### BREAKING

- **`cortex.yaml` top-level key renamed `operator:` → `principal:`** —
  per R3 of the vocabulary migration. Operators upgrading from v2.x MUST
  run `cortex migrate-config <your-config.yaml>` to rewrite their config
  before installing v3. The transition-release dual-block reader
  (`DualBlockConflictError`) that accepted both keys on v2.x is removed
  — a config carrying the legacy `operator:` key is treated as
  bot.yaml-shape and falls through to the legacy reader, which steers
  the operator at `cortex migrate-config`.
- **`CORTEX_OPERATOR*` env-var fallback removed** — the v2.x compat shim
  that resolved `CORTEX_OPERATOR*` with a deprecation warning is gone.
  Operators running those vars rename them to `CORTEX_PRINCIPAL*` before
  installing v3. `GROVE_OPERATOR*` (the pre-cortex tier) is still
  accepted — its removal is owned by the separate `GROVE_*` → `CORTEX_*`
  namespace migration that retires at MIG-8.
- **`OperatorSchema` / `Operator` deprecated TypeScript aliases removed**
  from `src/common/types/cortex-config.ts`. External importers update to
  `PrincipalConfigSchema` / `PrincipalConfig`.
- **`DeriveStackIdInput.operator?` renamed to `.principal?`** —
  the input shape `deriveStackId(…)` consumes. Cortex's internal
  call-sites (`src/cortex.ts:325`) updated in lockstep. External
  importers (rare — this is a boot-time resolver) update to the new
  field name.

### Non-breaking (v3 cleanup)

- `arc-manifest.yaml` bumped `2.0.10` → `3.0.0`.
- Internal documentation in the affected files reframed from
  "transition release" to "v3.0.0 BREAKING — removed at manifest PR-11"
  so the migration provenance stays self-documenting.

### Migration path for v2.x operators

```bash
# 1. Convert your cortex.yaml from the legacy `operator:` shape to
#    `principal:`. The CLI is idempotent — running it twice produces
#    the same output.
cortex migrate-config ~/.config/cortex/cortex.yaml \
  --out ~/.config/cortex/cortex.yaml.new

# 2. Review the diff and swap the file in.
diff ~/.config/cortex/cortex.yaml ~/.config/cortex/cortex.yaml.new
mv ~/.config/cortex/cortex.yaml.new ~/.config/cortex/cortex.yaml

# 3. Rename env vars (in your shell rc, systemd unit, launchd plist,
#    etc.) — every `CORTEX_OPERATOR*` → `CORTEX_PRINCIPAL*`.
#    For example:
#      CORTEX_OPERATOR_ID=andreas    →    CORTEX_PRINCIPAL_ID=andreas

# 4. Upgrade.
arc upgrade Cortex
```

### What is NOT changed

- The wire bytes — `signed_by[].identity`, `originator.identity`,
  `target_assistant`, `distribution_mode: "offer"`, `source` grammar
  `{principal}.{stack}.{assistant}` — were already shipped in v2.x via
  Luna's myelin PR-6..PR-13 + cortex#396..#398 consumer cascades. v3
  doesn't move bytes; it removes the back-compat shims around the
  already-renamed wire.
- The migrate-config CLI continues to READ legacy `operator:`-shaped
  bot.yaml + cortex.yaml input (historical record per the manifest's
  completion-signal allow-list). It just emits `principal:`-shaped
  output now.
- JetStream-replayed envelopes from any retention window continue to
  verify and route through cortex unchanged — the wire-bytes
  dual-schema reader contract from myelin PR-6 #169 is unaffected.

### Cross-references

- Migration manifest: `docs/migrations/0001-vocabulary-grilled-2026-05.md`
- Vocab alignment plan: `~/.claude/PAI/MEMORY/WORK/vocab-alignment/PLAN-CONTINUATION.md`
- Companion releases: myelin v0.3.0 (post-PR-13), pilot v0.3.0 (post-PR-1)
- Tracking issue: cortex#388
