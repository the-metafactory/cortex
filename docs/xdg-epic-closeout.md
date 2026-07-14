# XDG Epic (cortex#1867) — Implementation-vs-Findings Close-Out Report

**Date:** 2026-07-15 · **Span:** 5 days (2026-07-10 → 2026-07-15) · **Origin:** Vincent's Linux bring-up feedback (2026-07-10)
**Scope:** metafactory suite adopts the XDG Base Directory convention — bin, config, data, state, cache — behind a shared resolver + migration-on-touch, design-first.

---

## 1. Terminal proof (the deterministic gate)

```
bun scripts/xdg-audit.ts --repos          # cortex + arc + metafactory-discord, fresh origin/main
GATED (counts toward exit): 0
advisory · test files: 214 · code comments: 213      (visible, cannot affect runtime)
allowed  · inline: 20 · allowlist: 193 (80 entries) · raw-exception: 20 (~/.claude/events/raw, standard §6)
GATE: PASS ✓ (exit 0)
```

Baseline at kickoff (2026-07-12): **632 repo + 100 machine legacy sites.** Every one of the ~670 remaining raw references is now explicitly accounted for — advisory (tests/comments), allowed with a reason + owner, or the permanent raw-exception — and **zero are unaddressed**. The gate is self-tested in CI (planted-regression tests) and survived a 6-attack adversarial pass (regressions planted in new files, allowlisted files, allowlisted docs, comment-disguise, marker abuse — all caught, fail-closed).

## 2. What shipped (~40 PRs across 10 repos, every trust-lane change gauntleted)

| Wave / area | Delivered | Evidence (merged) |
|---|---|---|
| **W0–2 foundations** | shared `xdg-paths` resolver + seams, full-path pidfile identity (#1900), service-manager migration gate w/ 3-leg proof-of-death (#1929), atomic NetworkCache store, `xdg-audit` referee (#1913), 5-invariant E2E guard (#1933) | ~10 PRs, cortex+arc |
| **W3 bin** | `~/bin` → `~/.local/bin`, forward-symlinks, occupied-dest preflight, arc-version guard, `CORTEX_UPGRADE_SKIP_RESTART` prod-sparing | arc#295, cortex#1871, #1962 |
| **W4 config** | `~/.config/{cortex,grove}` → `~/.config/metafactory/cortex`; union merge (grove-only carried, shadowed kept), transactional rollback-on-throw, faithful symlink carry, journalled | cortex#1966 (2-round gauntlet) |
| **W5 data** | MC 3-layout reconcile + sibling mixed-fleet discovery, migrate-on-touch + `integrity_check` torn-copy hardening, published-events buffer lockstep (writer+reader+in-flight carry) | cortex#1971 (2-round gauntlet) |
| **W5 state** | pidfiles/logs/network-cache → `~/.local/state/metafactory/cortex`, **completion-marker-gated** resolver (bare-existence wedge closed), directory-occupancy precondition, signed roster survives | cortex#1979 |
| **arc adoption** | arc's own dirs → XDG (repos/db→data, cache→cache, config→config honoring `$XDG_CONFIG_HOME`); 3-part relink lockstep (dir + packages.db rows + symlinks), atomic temp-rename, completion marker | arc#297; releases v0.38→**v0.40.0** |
| **G-18 host resolver** | arc provisions into whatever config tree the live cortex reads (existence-gated mirror) + `{cortex-config}`/`{bin}`… provides tokens | arc#299 |
| **Linux systemd (#1909)** | unit re-render + **daemon-reload-before-restart (fail-closed)**, `$XDG_CONFIG_HOME`-aware unit dir, `.service` guard invariant, G-39 grandfathered names | cortex#2004 |
| **Downstream** | pilot resolves cortex config identically (drift-oracle) · agent-packs sage/alpha/gorse/cedar → `{cortex-config}` · metafactory-discord vendored resolver de-forked + pinned drift test | pilot#186, 4 pack PRs, discord#6 |
| **Docs** | 4-PR sweep (arc#301/#305, cortex#1995/#1997/#1998) — runtime-verified, `agents/`(state) vs `agents.d/`(config) distinction enforced | merged |
| **Standards** | internal standard (compass#114/#115) + **public portable standard** on compass-core | compass-core#5 |
| **Close-out fixes** | 7 runtime misses found by the fresh-checkout gate: `brainPackBaseDir` (#1988) + agent-state scripts ×4 + confidentiality-scan engine + segmented `loader.ts` site (#2007) — all routed via `resolveArcPackReposDir` | cortex#1992, #2011 |
| **The gate itself** | precision semantics + allow mechanisms + self-test; unused-allow pruning proven live | cortex#2021, #2023 |

## 3. Findings reconciliation

The 56 gap-review findings (G-01…G-60) were encoded into the wave gates and the audit's pattern registry; each wave's exit was gated on its audit slice + the E2E guard. Deltas discovered **after** waves closed — the honest list:
- **7 runtime misses** (the #1988/#2007 class): pkg-repos consumers outside arc#287's blast radius. Caught only by re-running the audit on **fresh** checkouts. All fixed + gate now regression-proofs the class.
- **Doc-sweep gaps:** pkg-repos mapping omitted from the first sweep brief; `agents/` instance-state mis-swept once (caught in review, rule enforced thereafter).
- **Findings that survived adversarial re-attack as by-design:** fresh-install→legacy state resolution (prevents an import-baked identity flip — post-hoc review overrode the "obvious" fix, which would have re-introduced the wedge).

## 4. Parked follow-ups (tracked, non-blocking)
- cortex#1970 — journal-gate the *config* resolver (SIGKILL partial-canonical wedge; state already completion-gated)
- cortex#1974 — publishedEventsDir custom-pin divergence (pre-existing) · standalone-db claim wording · outbound-log transition window
- cortex#1983 — state-move nits incl. **stack logDir divergence** (generated stacks still write legacy logDir vs canonical zod default — decide if stack logs move)
- Gate nits: tighten `match: ~/bin/` allowlist entries; `signal-cortex-reload.sh:37` pidfile-convention check
- `.specify` draft specs sweep together with their CLI code defaults
- Future wave (unscheduled): agent-instance `~/.config/cortex/agents/<id>` state move (cortex + arc + forge all deliberately aligned on legacy)

## 5. Held for the principal (production boundary — untouched throughout)
1. **Linux fresh-install verification (Vincent)** — the DoD's proof leg; now unblocked by #1909. **← next**
2. **macOS on-box cutover** — deploy runbook ready (`arc self-update` → `CORTEX_UPGRADE_SKIP_RESTART=<stack> arc upgrade cortex` to spare a live stack); deliberately **after** the Linux sign-off.
3. **T11 strict soak** (`CORTEX_XDG_STRICT=1`, one release, zero fallback lines) → **T12 wave-6 prune** (#1904).
4. Two repo-hygiene items — consent-gated, tracked privately.

## 6. Retro — what the 5 days taught
1. **A deterministic gate beats every review.** Reviews (mine included) declared "done" twice; the gate found 7 real misses. "Done is an exit code."
2. **The gate is only as good as its inputs** — a stale checkout produced a confidently-wrong "1 miss" verdict. Fresh-fetch is now part of the gate contract.
3. **Adversarial gauntlets caught prod-fatal defects pre-merge repeatedly**: skip-restart key asymmetry (W3), partial-canonical resolver flip + symlink EISDIR (W4), dead migrators + reader-gating event-drop wedge (W5-data), pidfile module-const identity break (W5-state), macOS-green/Linux-red twice.
4. **Adversarial review also protects against the fixer**: my "obvious" fresh→canonical fix would have re-introduced the pidfile wedge in reverse; the post-hoc review caught it.
5. **Process rules banked as memory**: halt-on-moved-head before any `--admin` merge; isolated worktrees per builder; stagger same-repo suites; verify the actual CI run, never the done-report; classification traps (`agents/` vs `agents.d/`, config vs state vs data) deserve explicit leave-lists in every sweep brief.

**Definition of Done status:** repo-side ✅ complete (gate 0, docs match, guard green, standards published). Remaining DoD legs — Linux fresh-install (Vincent), live macOS box unbroken, strict soak, prune — are the deploy phase, held for the principal.
