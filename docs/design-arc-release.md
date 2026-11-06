# cortex community-preview release — arc publish, README, host validation

**Status:** Draft for review
**Created:** 2026-07-21
**Evidence:** Community tester validation of v6.10.3 (native Debian + L4 container, both green, 2026-07-21); `arc publish --dry-run` passes for `@the-metafactory/cortex v6.10.3` (content-addressed, Sigstore-signed on official source); principal decision "plan C" (2026-07-21): preview to a small named cohort now, arc package-analysis (arc#332) lands before any wider announce.
**Related:** cortex#2264/#2265/#2268/#2269/#2275 (the 6.10.x hardening arc) · cortex#2273 (test-bench spec, draft) · arc#332 (package analysis design) · arc `design/linux-host-support.md` (L1–L4 host taxonomy) · Soma README (the model: Meta Factory's *first* arc-distributed package; cortex is the second)

---

> **One line.** Ship cortex as an arc-installable **community preview** to a named cohort, on the three hosts we actually run — **macOS native, Debian native, L4 container** — with a Soma-class README, a signed registry publish, and every install path rehearsed end-to-end before anyone is pointed at it.

## 1. Decisions already made (principal, 2026-07-21)

- **D1 — Plan C.** Preview now to a named cohort (the two active community testers); arc package-analysis (arc#332) is a parallel arc-side track that gates the *wider announce*, not the preview. Not re-litigated here.
- **D2 — macOS is a first-class release host.** The principal runs cortex on macOS daily. Scope = macOS native + Debian native + container. (Consequence: the known macOS gate-inertness bug moves from "deferred" to "release-blocking" — §4.)
- **D3 — Federation is excluded.** `cortex network …` has never been exercised on a real bench; it ships as *experimental, unreleased* in all copy. The 2-VM federation bench (cortex#2273 §5.3) is its gate, separately.
- **D4 — README modeled on Soma's.** Same shape: hero + thesis + badges + why + the-shape (with explicit non-goals) + "see it work" + honest status. Second arc-distributed package; the two READMEs should rhyme.
- **D5 — Soft-launch ordering.** Publish to the registry *unannounced* first, rehearse the real install paths against the published artifact, fix what breaks, *then* announce to the cohort. Nothing references the listing until rehearsals pass.

## 2. Current state (verified)

| Piece | State | Evidence |
|---|---|---|
| Publish mechanics | ✅ Ready | `arc publish --dry-run --scope the-metafactory` → clean: tarball, SHA-256, source=metafactory. Sigstore signing default on official sources; namespace ownership enforced at the API |
| Manifest | ⚠️ One gap + one review | No `namespace:` field (dry-run required `--scope`); capability declarations need one deliberate honesty pass before public listing |
| Debian native | ✅ Validated | Tester green on v6.10.3 — but via **git-clone + quickstart**, NOT `arc install` from the registry |
| Container (L4) | ✅ Validated | Tester green on v6.10.3 from-scratch; volume perms + honest gate + `/connz` daemon-on-bus healthcheck all landed |
| macOS native | ⚠️ Runs daily, gate inert | The healthy-boot gate reads `~/.local/state/metafactory/cortex/…` logs, but the macOS launchd plists write logs elsewhere (`~/.config/cortex/logs/` era paths) → gate can never pass on macOS (pre-existing; exact paths to be re-verified at implementation) |
| Registry install path | ❌ Never run | `arc install cortex` from the metafactory registry has never been executed end-to-end on ANY host — Debian used git-clone, container bakes arc inside the image |
| Recovery re-run | ⚠️ Known trap | After a failed boot, "fix config and re-run" is a silent no-op: the service-enable step doesn't restart an already-running daemon. Never filed as an issue |
| Regression bench | ❌ Missing | cortex#2273 spec'd (draft), unbuilt; all release verification is manual |
| README | ⚠️ Serviceable, not launch-grade | 172-line internal-flavored README; no hero, no badges, no arc install path, no per-host walkthrough, no honest preview-status section |
| Releases | ✅ Fixed | Tag lag resolved; v6.10.3 tagged at merge commit; container pins auto-bump |

## 3. Deliverable — Definition of Done (demonstrable walkthrough)

A newcomer on any of the three hosts can, with no help from us:

1. Land on the cortex README → understand what it is, what it is NOT (no federation claims), and that it is a **community preview**.
2. Install arc (per arc's own quickstart / meta-factory.ai download), which already defaults to the metafactory source.
3. `arc install cortex` → see the capability display → confirm → the `depends_on` cascade installs the discord bundle + adapter → postinstall completes.
4. Follow the README's per-host "see it work" section → `cortex quickstart` → **healthy boot verified by the gate on THEIR host** (macOS gate fixed; Linux gate already works; container defers to the `/connz` healthcheck).
5. If their first boot fails and they fix the config, **re-running actually restarts the daemon** and picks up the fix.
6. `docker compose ps` / gate output / an @mention reply all tell the truth about health.
7. Meanwhile: every release we cut has passed the scripted container regression bench, and the registry listing on meta-factory.ai renders the package with its preview label.

## 4. Work items

### Phase A — release-blocking fixes (cortex)
- **A1 — macOS healthy-boot gate fix.** Unify the gate's log path with where macOS launchd services actually write (or teach the gate the per-host log location via the existing host-adapter seam). Acceptance: fresh `cortex quickstart` on macOS reaches a *passing* gate (all 5 patterns) — currently structurally impossible. Include the `.error.log` fast-fail behavior (cortex#2264) on macOS paths.
- **A2 — recovery re-run restarts the daemon.** File + fix: when quickstart's service step finds the daemon already running (after a previous failed/degraded boot), re-run must restart it so config fixes take effect (`--force-restart` semantics or restart-on-config-change; exact mechanism per host adapter). Acceptance: fail a boot (bad config) → fix config → re-run quickstart → daemon restarts and the gate passes.

### Phase B — regression bench, minimum slice (cortex, standalone — does NOT wait for #2273 sign-off)
- **B1 — `container-compose` bench scenario.** Scripted `deploy/test/` scenario: from-scratch compose up on Linux docker (placeholder env), assert: no EACCES (#2269 guard), volumes uid-1000, steps 1–7 ✓ + step 8 deferred with no `status:error` (#2275 guard), `/connz` healthcheck flips healthy↔unhealthy, image assembles incl. `arc install` step (#2243/#2156 guard). Idempotent up/down, exit-coded. This is the pre-release gate for every future cut.
- **B2 — install-rehearsal scripts.** Scripted (where scriptable) rehearsal of the *registry* path: fresh multipass Debian VM → install arc → `arc install cortex` → quickstart → gate green. macOS rehearsal is a documented manual runbook executed on a real Mac (fresh user account acceptable). These become bench scenarios later; runbook-grade now.

### Phase C — manifest + README (cortex)
- **C1 — manifest release-readiness.** Add `namespace: "the-metafactory"`; full capability-honesty review (every capability used is declared — undeclared = security bug per house rule); verify `depends_on.packages` matches the real adapter set; preview labeling in description/status per what the registry schema supports (verify `status:` vocabulary — `shipped` exists; add/confirm `preview`).
- **C2 — README overhaul (Soma-class).** Structure: centered hero illustration (cortex motif — generate via art pipeline, editorial style consistent with ecosystem art) · one-line thesis · badges (version / license / runs-on macOS·Debian·container) · "Meta Factory's second Arc-distributed package" + Discord invite · **Why this project?** · **The shape** (ASCII: principal ↔ surfaces ↔ bus ↔ agents; explicit *deliberately does not own* list) · **See it work (~10 min)** per host (macOS / Debian / container), arc-install-first · **Install** (arc primary, git fallback) · **Status** (honest preview scope: single principal · Discord surface · federation experimental/unreleased · wire protocol evolving) · docs map (exists, keep) · provenance/license. The existing 172-line content is largely reusable as section bodies.

### Phase D — publish + rehearse (soft launch, per D5)
- **D1 — publish unannounced.** `arc publish` at the release tag (Sigstore-signed, official source, `the-metafactory` namespace). Verify the meta-factory.ai listing renders a `component`-type entry sanely with the preview label (small site fix in the meta-factory repo if it doesn't — cross-repo item).
- **D2 — three rehearsals against the published artifact.** (1) Debian VM registry-install rehearsal (B2 script); (2) macOS rehearsal (B2 runbook) on a real Mac; (3) container from-scratch (B1 bench). Every failure loops back as a fix before announce. Acceptance: all three green on the *published* package, not the git tree.

### Phase E — announce (after D green)
- **E1 — release comms.** Release notes for the preview cut; cohort announce in the community thread (named cohort per plan C); README badges/links live. Explicitly restate: preview scope, federation experimental, wire-protocol-may-change caveat.

### Explicitly out of scope
- Federation release (gated on the 2-VM bench, cortex#2273 §5.3).
- arc package-analysis (arc#332) — parallel arc track; gates the wider announce only.
- Windows; surfaces beyond Discord (web adapter exists but is not in the preview scope claim).
- Full #2273 bench harness (only the B1 slice is pulled forward).

## 5. Sequencing & dependencies

```
A1 (macOS gate)  ─┐
A2 (recovery)    ─┤→ D1 (publish) → D2 (rehearsals ×3) → E1 (announce)
B1 (bench)       ─┤        ↑ B2 scripts/runbook used by D2
C1 (manifest)    ─┤
C2 (README)      ─┘
```
A/B/C are parallel lanes (no file overlap except A1/A2 both touch quickstart service/gate code — same lane, serialized). D strictly after A+B+C. E strictly after D.

## 6. Open questions (recommendations inline — none block Phase A/B/C start)
1. **Registry `status:` vocabulary** — does the API/site support a `preview` status/badge? Recommendation: verify during C1; if absent, smallest site change in meta-factory repo (cross-repo sub-issue).
2. **macOS rehearsal environment** — principal's Mac (fresh user account) vs. a second Mac. Recommendation: fresh user account on the existing Mac; it exercises the same launchd + paths.
3. **README hero art** — reuse the ecosystem editorial style (amt-infographic lineage). Recommendation: generate 2–3 candidates during C2; principal picks.
