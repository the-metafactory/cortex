# Cortex — Release History

> Archived 2026-07-02, preserved before a git-history hygiene pass (commit SHAs + tags change in that rewrite; this file is the durable, in-repo record of the release timeline and notes, independent of the git tags). 87 releases, v3.0.0 → v6.0.0.

## Timeline

| Tag | Date | Title |
|---|---|---|
| v6.0.0 | 2026-07-01 | Cortex v6.0.0 — arc package renamed to lowercase 'cortex' + onboarding polish |
| v5.30.2 | 2026-06-28 | Cortex v5.30.2 — zero-flag make-live creds + onboarding ladder |
| v5.30.1 | 2026-06-28 | Cortex v5.30.1 — onboarding: close the provision→make-live loop (no raw nsc) |
| v5.30.0 | 2026-06-28 | Cortex v5.30.0 — Mission Control Model-B catch-up + constellation skin |
| v5.29.0 | 2026-06-27 | Cortex v5.29.0 — onboarding hardening |
| v5.28.0 | 2026-06-27 | Cortex v5.28.0 — make-live daemon-switch (sovereign account migration) |
| v5.27.1 | 2026-06-27 | Cortex v5.27.1 — provision↔arc wire-contract fixes (PR7 unblock) |
| v5.27.0 | 2026-06-27 | Cortex v5.27.0 — Sovereign federation + end-to-end confidentiality |
| v5.26.8 | 2026-06-26 | Cortex v5.26.8 -- dev-loop worker robustness (branch handling + commit session work) |
| v5.26.7 | 2026-06-26 | Cortex v5.26.7 -- surface-router self-deny flood fix |
| v5.26.6 | 2026-06-26 | Cortex v5.26.6 -- fail-soft surface-token resolution (no whole-stack brick) |
| v5.26.5 | 2026-06-26 | Cortex v5.26.5 -- federation self-deny flood fix + dev-loop thread consolidation |
| v5.26.4 | 2026-06-26 | Cortex v5.26.4 -- env-placeholder resolver for surface tokens |
| v5.26.3 | 2026-06-26 | Cortex v5.26.3 -- operator-driven dev-loop S1 (vega orchestrator command) |
| v5.26.2 | 2026-06-26 | Cortex v5.26.2 -- dev.implement durable provisioning (loop activation) |
| v5.26.1 | 2026-06-26 | Cortex v5.26.1 -- review-subject overlap fix (CODE_REVIEW provisioning) |
| v5.26.0 | 2026-06-26 | Cortex v5.26.0 -- F-6 reflex activation bridge + dev-loop JetStream stream-sizing fix |
| v5.25.0 | 2026-06-19 | Cortex v5.25.0 -- Pier public-domain onboarding concierge + presence-adapter-flip |
| v5.24.0 | 2026-06-17 | Cortex v5.24.0 -- roster-driven federation auto-wiring |
| v5.23.0 | 2026-06-17 | Cortex v5.23.0 -- cortex creds CLI + accumulated work |
| v5.21.0 | 2026-06-16 | Cortex v5.21.0 -- Network view shows idle local stacks |
| v5.19.1 | 2026-06-16 | Cortex v5.19.1 -- network graph hub-select highlight fix |
| v5.19.0 | 2026-06-16 | Cortex v5.19.0 -- network graph per-stack colour-coding + highlight |
| v5.18.0 | 2026-06-16 | Cortex v5.18.0 -- network graph rendering + existing-db migration fix |
| v5.17.0 | 2026-06-16 | Cortex v5.17.0 -- headless MC mode (pane-of-glass producers) |
| v5.16.0 | 2026-06-16 | Cortex v5.16.0 -- headless MC mode + brain + federated observability |
| v5.15.3 | 2026-06-13 | Cortex v5.15.3 -- brain per-task timeout 2min→5min (frontier compose headroom) |
| v5.15.2 | 2026-06-13 | Cortex v5.15.2 -- brain posts render to chat (bot packs can finally speak) |
| v5.15.1 | 2026-06-13 | Cortex v5.15.1 -- brain posts reach the surface (adapter_instance routing) |
| v5.15.0 | 2026-06-13 | Cortex v5.15.0 -- exec-brain triggering: @-mention a bot pack, it composes |
| v5.14.0 | 2026-06-13 | Cortex v5.14.0 -- principal gate reply-bridge: ask_principal goes live on chat surfaces |
| v5.12.2 | 2026-06-11 | Cortex v5.12.2 -- secure-by-default signing: seed + unset posture boots permissive |
| v5.12.1 | 2026-06-11 | Cortex v5.12.1 -- review-path fixes: egress key-name false positives + sovereignty demand-first |
| v5.12.0 | 2026-06-11 | Cortex v5.12.0 -- pane-of-glass: all local stacks via direct MC-DB aggregation |
| v5.11.1 | 2026-06-11 | Cortex v5.11.1 -- presence decoupled from mc.enabled (multi-stack pane) |
| v5.11.0 | 2026-06-11 | Cortex v5.11.0 -- P-14 drill-down + sideband proxy + multi-bus stack aggregation |
| v5.10.0 | 2026-06-11 | Cortex v5.10.0 -- Governance tab (G-1115) + engine value rename |
| v5.9.0 | 2026-06-11 | Cortex v5.9.0 -- Capability Offering (public marketplace + injection hardening) |
| v5.8.0 | 2026-06-11 | Cortex v5.8.0 -- MC session-tree + capability offerings |
| v5.7.0 | 2026-06-10 | Cortex v5.7.0 -- Agent Network Topology + consumer-side sovereignty gate |
| v5.6.0 | 2026-06-10 | Cortex v5.6.0 — the dev-loop component set |
| v5.5.0 | 2026-06-10 | Cortex v5.5.0 -- Mission Control runs in-process (pane-of-glass iteration 1, wave 1) |
| v5.4.3 | 2026-06-09 | Cortex v5.4.3 -- review consumer unblocks local same-principal dispatch on federated stacks (#836) |
| v5.4.2 | 2026-06-09 | Cortex v5.4.2 -- ping config-split aware + join health inconclusive on absent monitor (#830, #831) |
| v5.4.1 | 2026-06-09 | Cortex v5.4.1 -- join never renders a nats-crashing leaf config (#821) |
| v5.4.0 | 2026-06-09 | Cortex v5.4.0 -- registry roster fixes (cap-preserve #819, networks-union #820) + network ping + DD-5 peers |
| v5.3.11 | 2026-06-09 | Cortex v5.3.11 -- network status is config-split aware (#814) |
| v5.3.10 | 2026-06-09 | Cortex v5.3.10 -- network join writes policy where the daemon reads (#805, #807) |
| v5.3.9 | 2026-06-09 | Cortex v5.3.9 -- cortex stack create (born-aligned, unique stack scaffold) |
| v5.3.8 | 2026-06-09 | Cortex v5.3.8 -- stack.id is the canonical slug authority + arc-upgrade drift detection |
| v5.3.7 | 2026-06-09 | Cortex v5.3.7 -- config example → config-split format |
| v5.3.6 | 2026-06-08 | Cortex v5.3.6 -- daemon restart resolves by --config, not plist-label shape (#800) |
| v5.3.5 | 2026-06-08 | Cortex v5.3.5 -- peer-side network join fixes (no-account $G leaf, restart label, leave base -c) |
| v5.3.4 | 2026-06-08 | Cortex v5.3.4 -- network status reflects authoritative leafz leaf-state (#797) |
| v5.3.3 | 2026-06-08 | Cortex v5.3.3 -- network join fail-fast + network management docs |
| v5.3.2 | 2026-06-08 | Cortex v5.3.2 -- network join multi-stack (--principal-seed) |
| v5.3.1 | 2026-06-08 | Cortex v5.3.1 -- bash-guard grove→cortex env fix (bots can run gh/aws/git again) |
| v5.3.0 | 2026-06-08 | Cortex v5.3.0 -- per-stack pubkeys (multi-stack federation) |
| v5.2.0 | 2026-06-08 | Cortex v5.2.0 -- signed-admin network creation (cortex network create) |
| v5.1.4 | 2026-06-08 | Cortex v5.1.4 -- C-127: bashAllowlist plumbed through bus dispatch (guild stacks unblocked) |
| v5.1.3 | 2026-06-07 | Cortex v5.1.3 -- bash-guard auto-approves allowlisted commands in async dispatch |
| v5.1.2 | 2026-06-07 | Cortex v5.1.2 -- grove-naming retirement (non-breaking) + deterministic CI gate |
| v5.1.1 | 2026-06-07 | Cortex v5.1.1 -- SECURITY: bash-guard ACE-bypass fix + read-only aws allowlist |
| v5.1.0 | 2026-06-06 | Cortex v5.1.0 -- federation round-trip functional + Linux support |
| v5.0.3 | 2026-06-06 | Cortex v5.0.3 -- one-liner network join (dispatcher + config-derived inputs) |
| v5.0.2 | 2026-06-06 | Cortex v5.0.2 -- network join integration fixes (config-split policy path + nats-server restart) |
| v5.0.1 | 2026-06-06 | Cortex v5.0.1 -- Fix dormant-leaf gap in network join |
| v5.0.0 | 2026-06-06 | Cortex v5.0.0 -- Network Join Control Plane (IoAW: one-command join) |
| v4.8.0 | 2026-06-06 | Cortex v4.8.0 -- Trust-aware content filter, session isolation, per-skill grants, network roster |
| v4.7.2 | 2026-06-06 | Cortex v4.7.2 -- Clear the 'working…' placeholder on terminal dispatch events |
| v4.7.1 | 2026-06-05 | Cortex v4.7.1 -- Content filter: trust-scope the principal's channel @mentions |
| v4.7.0 | 2026-06-05 | Cortex v4.7.0 -- Federated review loop complete (Offer + Direct) |
| v4.6.0 | 2026-06-05 | Cortex v4.6.0 -- Federated review consumer + operator trust-scope |
| v4.5.2 | 2026-06-05 | Cortex v4.5.2 -- Per-dispatch Discord progress |
| v4.5.1 | 2026-06-05 | Cortex v4.5.1 -- Config-split-aware upgrade lifecycle |
| v4.5.0 | 2026-06-04 | Cortex v4.5.0 -- Per-skill grants + Discord multi-stack hardening |
| v4.4.1 | 2026-06-04 | Cortex v4.4.1 -- Mission Control dashboard dist-path fix |
| v4.4.0 | 2026-06-04 | Cortex v4.4.0 -- Session settings isolation (C-701 Part A) |
| v4.3.0 | 2026-06-04 | Cortex v4.3.0 -- Cross-stack guild isolation, stack-aware upgrades, nonce-before-verify |
| v4.2.0 | 2026-06-04 | Cortex v4.2.0 -- Trust track, network registry & Discord multi-server |
| v4.1.0 | 2026-06-03 | Cortex v4.1.0 — Unified surface gateway (inbound demux + outbound reply round-trip) |
| v4.0.0 | 2026-06-01 | Cortex v4.0.0 — operator→principal vocabulary migration (BREAKING) |
| v3.1.0 | 2026-05-29 | Cortex v3.1.0 — Bot-to-bot review reply loop + Discord stability |
| v3.0.3 | 2026-05-26 | Cortex v3.0.3 -- Review-consumer ack_wait fix (no duplicate posts) |
| v3.0.2 | 2026-05-26 | Cortex v3.0.2 -- Sage verdict exit-code mapping + --post propagation |
| v3.0.1 | 2026-05-26 | Cortex v3.0.1 -- Sage review bus fix (pr_url + myelin 9fc8476) |
| v3.0.0 | 2026-05-21 | Cortex v3.0.0 -- Vocabulary migration BREAKING |

---

## Release notes

### v6.0.0 — v6.0.0 — arc package renamed to lowercase 'cortex' + onboarding polish  ·  2026-07-01

## Breaking — one-time migration

**The arc package renamed `Cortex` → `cortex`** (#1337) to match the binary/CLI and sibling packages. arc is case-sensitive (correct on Linux), so this is a real rename.

**Existing installs — run once:**
```
arc uninstall Cortex && arc install cortex
```
Your configs under `~/.config/cortex/` are untouched; this swaps the arc-registered package + symlinks/hooks and restarts the daemon. New installs just use `arc install cortex`.

## Also in this release
- **#1338** — `cortex stack create` default agent is now the neutral `assistant`, not a personal persona name.
- Onboarding polish: from-source `bun link` yields a working `cortex` (#1330), local-vs-federated clarified (#1331), Core-concepts primer for App/principal/slug (#1336).
- F-6 reflex bridge (generic config-driven `process` code handler).

Reported by @vpzed.

---

### v5.30.2 — v5.30.2 — zero-flag make-live creds + onboarding ladder  ·  2026-06-28

## Onboarding hardening (C-1265c, #1305) — from-scratch is now fully zero-flag

Rob's from-scratch retest of v5.30.1 (on Linux) confirmed the make-live config-path loop works end-to-end, and surfaced the last friction: make-live still needed a `--creds` flag because `stack create` never seeded `nats.credsPath`.

- **make-live defaults `nats.credsPath`** when unset → `~/.config/nats/<slug>-bot.creds` (the daemon's **bus** creds, agents account) — **deliberately distinct** from the **federation** leaf creds `<slug>.creds` (a pre-review diagnosis caught + fixed a collision where both defaulted to the same file). It also **writes the path back to config** so the daemon picks up the creds it just minted (no Authorization Violation on unseeded stacks), and **fail-fasts** rather than restarting into broken auth.
- **`stack create` seeds** `nats.credsPath` + its next-steps now teach the full **provision → make-live** ladder, not just join.
- **Prereqs block** added to `sop-onboard-peer-principal.md`.

Trust-path (NATS account separation) — adversarially reviewed (0 blockers; the collision + the write-back gap were both caught in review). From-scratch onboarding now completes with **zero flags**.

---

### v5.30.1 — v5.30.1 — onboarding: close the provision→make-live loop (no raw nsc)  ·  2026-06-28

## Onboarding hardening (C-1265b, #1302)

Walker retest of the v5.29.0 from-scratch onboarding found **fix #3 (C-1265) was partial** — provision minted the JWTs but `make-live` couldn't finish, so onboarding still needed a manual `nsc generate config`. This closes the loop.

- **provision writes `stack.nats_infra.config_path`** (preserve-or-convention `~/.config/nats/<slug>.conf`) — the per-stack path `make-live` reads. The render logic existed; it was starved of this path.
- **`make-live` bootstraps the operator-mode config from scratch** when the file is absent — synthesises a hard-isolated base from the stack's own `nats.url`, then renders operator + `resolver: MEMORY` + `resolver_preload` onto it. **Zero raw `nsc`.**
- **Sample `docs/config-layout/nats-server.conf.example`** — a tester asked for a template; placeholder-only, with a drift test + secret-scan keeping it honest.
- **Hardened:** the synthesised `listen` is validated to loopback (rejects non-loopback / `0.0.0.0` / userinfo / path) — declines synthesis rather than binding something over-exposed.
- **SOPs updated** (sop-stack-onboarding §B0.1, sop-network-join, config-layout README).

Adversarially reviewed (0 blockers; the loopback hardening came out of review). From-scratch onboarding now completes with no manual `nsc`.

---

### v5.30.0 — v5.30.0 — Mission Control Model-B catch-up + constellation skin  ·  2026-06-28

MC now reflects the Model-B federation reality and wears the constellation skin.

**Data / trust wave:** networks as first-class trust groups + admitted-roster⋈presence membership verdict (A1), per-network confidentiality posture badge (A3), Pier queue of pending admission requests (B1), registry member-accessible ADMITTED roster read (Q3).

**Constellation skin:** OKLCH design-token + motion layer (D1), command bar + altitude rail + admin/member posture chrome (D2), glowing star-map network canvas — radial-glow orbs, you-are-here anchor, dashed federated-peer edges (D3).

**Privacy:** session/envelope granularity is local-only; federated peers show aggregate metadata only (extends ADR-0005).

D4/D5 (posture/trust indicators + live bus-traffic) follow.

---

### v5.29.0 — v5.29.0 — onboarding hardening  ·  2026-06-27

## What's Changed
* fix(registry): C-1263 — admission-request upsert failure is visible, not silent by @mellanon in https://github.com/the-metafactory/cortex/pull/1268
* fix(surface): C-1264 — content-filter rejection is descriptive + actionable, rendered deterministically by @mellanon in https://github.com/the-metafactory/cortex/pull/1267
* feat(network): C-1265 — wrap nsc server-config generation (provision JWT export + make-live bootstrap) by @mellanon in https://github.com/the-metafactory/cortex/pull/1266
* fix(carveout): allowlist #1265 NSC server-config files (restore main green) by @mellanon in https://github.com/the-metafactory/cortex/pull/1271
* chore: bump to v5.29.0 — onboarding hardening (#1263/#1264/#1265) by @mellanon in https://github.com/the-metafactory/cortex/pull/1272


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.28.0...v5.29.0

---

### v5.28.0 — v5.28.0 — make-live daemon-switch (sovereign account migration)  ·  2026-06-27

## What's Changed
* test(network): C-1225 — provision→arc end-to-end integration guard (sovereign-provisioning hardening) by @mellanon in https://github.com/the-metafactory/cortex/pull/1255
* feat(network): C-1257 — make-live daemon-switch (land a stack on its own account) by @mellanon in https://github.com/the-metafactory/cortex/pull/1258
* chore: bump to v5.28.0 — make-live daemon-switch (#1257) by @mellanon in https://github.com/the-metafactory/cortex/pull/1259


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.27.1...v5.28.0

---

### v5.27.1 — v5.27.1 — provision↔arc wire-contract fixes (PR7 unblock)  ·  2026-06-27

## What's Changed
* docs: onboarding + go-private SOP for sovereign federation by @mellanon in https://github.com/the-metafactory/cortex/pull/1252
* fix(network): C-1225 — provision accepts arc.nats.federation.v1 from add-federation-export (PR7 unblock) by @mellanon in https://github.com/the-metafactory/cortex/pull/1253
* chore: bump to v5.27.1 — provision↔arc wire-contract fixes (#1253) by @mellanon in https://github.com/the-metafactory/cortex/pull/1254


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.27.0...v5.27.1

---

### v5.27.0 — v5.27.0 — Sovereign federation + end-to-end confidentiality  ·  2026-06-27

## What's Changed
* docs(network): C-1142 R2 — retire Model-A leaf-cred-issuance runbook + lock --from-package retirement (ADR-0015) by @mellanon in https://github.com/the-metafactory/cortex/pull/1235
* feat(cli): C-1139 — cortex network provision (one-command sovereign-operator setup) + agents_account (G1d) by @mellanon in https://github.com/the-metafactory/cortex/pull/1236
* feat(cli): C-1224 — Model-B `network join` secret-authenticated leaf (own-account bind) by @mellanon in https://github.com/the-metafactory/cortex/pull/1237
* design(confidentiality): firm up M3 envelope encryption + ADR-0018 (admission/leaf-secret) + ADR-0019 (payload encryption) by @mellanon in https://github.com/the-metafactory/cortex/pull/1242
* docs(confidentiality): amend ADR-0019 + design → per-network key (network-readable, option 1) by @mellanon in https://github.com/the-metafactory/cortex/pull/1245
* feat(crypto): C-1238 — shared seal-to-principal sealed-box core by @mellanon in https://github.com/the-metafactory/cortex/pull/1243
* feat(registry): C-1239 — admission-gate wiring (network_id + ADMITTED roster + member PoP read) [ADR-0018 PR5a] by @mellanon in https://github.com/the-metafactory/cortex/pull/1244
* feat(network): C-1240 — leaf-secret tooling + sealed delivery (PR5b, ADR-0018) by @mellanon in https://github.com/the-metafactory/cortex/pull/1247
* feat(bus): C-1241 — M3 federated payload encryption, per-network key (TC-3.1/3.3) by @mellanon in https://github.com/the-metafactory/cortex/pull/1246
* feat(pier): C-1142 P1/P2 — reconcile Pier package with merged admission airgap + lock-down test (ADR-0015/0017) by @mellanon in https://github.com/the-metafactory/cortex/pull/1250
* chore: bump to v5.27.0 — sovereign federation + end-to-end confidentiality by @mellanon in https://github.com/the-metafactory/cortex/pull/1251


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.26.8...v5.27.0

---

### v5.26.8 — v5.26.8 -- dev-loop worker robustness (branch handling + commit session work)  ·  2026-06-26

## What's Changed
* docs(federation): Phase 0 — Model-B sovereign federation (one root + admission gate): SOP §B0.1 + CONTEXT.md + join diagram by @mellanon in https://github.com/the-metafactory/cortex/pull/1229
* feat(cli): C-1228 — default registry trust anchor (PR3.5) by @mellanon in https://github.com/the-metafactory/cortex/pull/1232
* fix(dev-loop): handle existing branch + commit the session's work (#1230) by @mellanon in https://github.com/the-metafactory/cortex/pull/1231
* chore: bump to v5.26.8 by @mellanon in https://github.com/the-metafactory/cortex/pull/1234


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.26.7...v5.26.8

---

### v5.26.7 — v5.26.7 -- surface-router self-deny flood fix  ·  2026-06-26

## What's Changed
* fix(federation): self-short-circuit + dedupe the surface-router dispatch-deny path (#1222) by @mellanon in https://github.com/the-metafactory/cortex/pull/1226
* chore: bump to v5.26.7 by @mellanon in https://github.com/the-metafactory/cortex/pull/1227


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.26.6...v5.26.7

---

### v5.26.6 — v5.26.6 -- fail-soft surface-token resolution (no whole-stack brick)  ·  2026-06-26

## What's Changed
* fix(config): fail-soft surface-token resolution — disable the surface, not the stack (#1217) by @mellanon in https://github.com/the-metafactory/cortex/pull/1218
* chore: bump to v5.26.6 by @mellanon in https://github.com/the-metafactory/cortex/pull/1219


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.26.5...v5.26.6

---

### v5.26.5 — v5.26.5 -- federation self-deny flood fix + dev-loop thread consolidation  ·  2026-06-26

## What's Changed
* fix(federation): self-short-circuit own presence + dedupe access.denied audit + bubble up (#1213) by @mellanon in https://github.com/the-metafactory/cortex/pull/1214
* feat(surface): consolidate dev-loop run into one Discord thread (#1206 S2) by @mellanon in https://github.com/the-metafactory/cortex/pull/1212
* chore: bump to v5.26.5 by @mellanon in https://github.com/the-metafactory/cortex/pull/1216


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.26.4...v5.26.5

---

### v5.26.4 — v5.26.4 -- env-placeholder resolver for surface tokens  ·  2026-06-26

## What's Changed
* feat(config): resolve __ENV__ placeholders in surface tokens at config-load (#1209) by @mellanon in https://github.com/the-metafactory/cortex/pull/1210
* chore: bump to v5.26.4 by @mellanon in https://github.com/the-metafactory/cortex/pull/1211


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.26.3...v5.26.4

---

### v5.26.3 — v5.26.3 -- operator-driven dev-loop S1 (vega orchestrator command)  ·  2026-06-26

## What's Changed
* feat(runner): operator-driven dev-loop S1 — principal-gated command → dev.implement dispatch (#1206) by @mellanon in https://github.com/the-metafactory/cortex/pull/1207
* chore: bump to v5.26.3 by @mellanon in https://github.com/the-metafactory/cortex/pull/1208


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.26.2...v5.26.3

---

### v5.26.2 — v5.26.2 -- dev.implement durable provisioning (loop activation)  ·  2026-06-26

## What's Changed
* fix(runner): provision DEV_IMPLEMENT durable up-front so dev.implement binds (#1203) by @mellanon in https://github.com/the-metafactory/cortex/pull/1204
* chore: bump to v5.26.2 by @mellanon in https://github.com/the-metafactory/cortex/pull/1205


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.26.1...v5.26.2

---

### v5.26.1 — v5.26.1 -- review-subject overlap fix (CODE_REVIEW provisioning)  ·  2026-06-26

## What's Changed
* fix(bus): review-subject Offer family single-token so CODE_REVIEW provisions (#1199) by @mellanon in https://github.com/the-metafactory/cortex/pull/1200
* fix(test): green main — review-consumer-boot assertions to single-token Offer pattern (#1199) by @mellanon in https://github.com/the-metafactory/cortex/pull/1201
* chore: bump to v5.26.1 by @mellanon in https://github.com/the-metafactory/cortex/pull/1202


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.26.0...v5.26.1

---

### v5.26.0 — v5.26.0 -- F-6 reflex activation bridge + dev-loop JetStream stream-sizing fix  ·  2026-06-26

## What's Changed
* docs(adr): ADR-0017 — surface tooling as arc bundles + Discord decoupling plan (S0) by @mellanon in https://github.com/the-metafactory/cortex/pull/1170
* feat(cortex): S2 — consume metafactory-discord bundle; remove in-repo Discord CLI (#1173) by @mellanon in https://github.com/the-metafactory/cortex/pull/1176
* feat(bus): F-6 reflex activation bridge — fired events → tasks.* dispatch by @jcfischer in https://github.com/the-metafactory/cortex/pull/1178
* chore: bump to v5.26.0 — F-6 reflex activation bridge by @jcfischer in https://github.com/the-metafactory/cortex/pull/1179
* feat(bus): notify.discord code capability — F-6 reflex bridge → Discord by @jcfischer in https://github.com/the-metafactory/cortex/pull/1180
* feat(bus): notify.discord `*` catch-all — all repos → one webhook by @jcfischer in https://github.com/the-metafactory/cortex/pull/1181
* fix(bus): notify.discord — accept reflex's flat repository full_name (e2e fix) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1182
* feat(bus): F-6 reflex bridge — configurable author trust gate (skip_authors) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1184
* feat(bus): F-6 reflex bridge — review-consumer dispatch (review: true) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1185
* fix(review): per-scope filter_subject on review durables — no fan-out double-post (cortex#1186) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1187
* feat(bus): generic config-driven `process` reflex handler (add processes without re-releasing cortex) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1188
* fix(bus): JetStream DEFAULT_MAX_BYTES 512MiB→64MiB so the dev-loop's streams fit (#1197) by @mellanon in https://github.com/the-metafactory/cortex/pull/1198


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.25.0...v5.26.0

---

### v5.25.0 — v5.25.0 -- Pier public-domain onboarding concierge + presence-adapter-flip  ·  2026-06-19

## Pier is a public-domain onboarding concierge — and installed agents now come online *and respond*

### Presence-adapter-flip (epic #1158)
Installing an agent as an `agents.d/` fragment now wires it end-to-end:
- **#1162 (S1)** — fragment agents get Discord/Mattermost/Slack adapters (presence).
- **#1163 (S2)** — per-agent builtin chat **dispatch listeners**, so a non-primary agent actually responds. Single-agent stacks are byte-identical; multi-agent scoped to `tasks.@{did}.>`.

### Pier — the community onboarding concierge
- **#1167** — open-onboarding **gate**: a public-domain agent answers *anyone* via a single minimal-privilege `public` principal whose only capability is "chat with a public-facing agent." Denied operator/tools/dispatch-to-other-agents/admit/bus. `[Read]`-only, public-channel-only, `did:mf:public` originator proven unabusable (3 adversarial-review rounds).
- **#1164** — persona is **surface-don't-execute**: Pier guides + surfaces; both admissions (Tier-1 `community-fleet` role, Tier-2 `cortex network admit`) stay **human gates**. Zero authority → no blast radius.

### Security posture
Pier is exposed to the untrusted public domain, so it holds nothing: no role-grant, no admit, no shell, no bus. The public principal is exact-match confined; the persona never executes a privileged act.

Backend: `arc upgrade Cortex`. Follow-ups: #137 (surface admission to admin channel), #138 (#general announce), #1168 (reserve `public` name).

---

### v5.24.0 — v5.24.0 -- roster-driven federation auto-wiring  ·  2026-06-17

## Roster-driven federation auto-wiring — receive side (#1084)
A peer joining a network you're on now auto-reconciles onto your accept-list + presence subscription (per-network opt-in, default OFF). P1 #1086 (runtime roster read) · P2 #1087 (accept-list derivation) · P3 #1088 (continuous reconciler) · P4 #1089 (signal-optional transport verdict) · #1105 (peer accept presence-only, least-privilege). Registry-authoritative, chain-verify intact, signal-optional (cortex stands alone). Backend — `arc upgrade Cortex`.

---

### v5.23.0 — v5.23.0 -- cortex creds CLI + accumulated work  ·  2026-06-17

## v5.23.0 — `cortex creds` is a real command + the unreleased 5.22 work

Catches up the release tag to the manifest (which sat at 5.22.0 with no v5.22.0 tag) and ships:

- **`cortex creds` CLI registration ([#1098](https://github.com/the-metafactory/cortex/pull/1098))** — O-2.5 (#1061) landed the credential-issuance module but never wired it into the dispatcher. `cortex creds issue/list/revoke/rotate` now work (thin delegator to `arc nats add-bot`). **Unblocks the operator-onboarding tender + the dev-loop/tender stack bus creds.**
- Plus the accumulated work since v5.21.0 (network/observability/onboarding).

---

## What's Changed
* fix(brain): host→brain socket write backpressure (truncated large tasks) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1085
* feat(config): GV-1 — migrate ~/.config/grove → ~/.config/cortex config paths (grove-fallback) by @mellanon in https://github.com/the-metafactory/cortex/pull/1078
* feat(events): GV-2 — grove→cortex pipeline vocab + grove_channel→cortex_channel dual-write shim by @mellanon in https://github.com/the-metafactory/cortex/pull/1079
* feat(network): O-3 — cortex network join auto-converts an anonymous bus to operator-mode by @mellanon in https://github.com/the-metafactory/cortex/pull/1058
* feat(creds): O-2.5 — cortex creds issue --pub/--sub passthrough + safe default scope by @mellanon in https://github.com/the-metafactory/cortex/pull/1061
* feat(network): O-4b — network join consumes a leaf package (--from-package) by @mellanon in https://github.com/the-metafactory/cortex/pull/1090
* docs(onboarding): O-5 — community-fleet admission SOP by @mellanon in https://github.com/the-metafactory/cortex/pull/1091
* fix(docs): O-5 SOP vocab — operator→principal (unbreak carve-out gate) by @mellanon in https://github.com/the-metafactory/cortex/pull/1095
* docs(federation): leaf-cred issuance runbook + ADR-0012 (per-operator account isolation) by @mellanon in https://github.com/the-metafactory/cortex/pull/1012
* docs(federation): spec — automated bot-driven operator onboarding by @mellanon in https://github.com/the-metafactory/cortex/pull/1049
* feat(network): C-1086 — lift registry-roster read into a runtime-callable lib (P1) by @mellanon in https://github.com/the-metafactory/cortex/pull/1093
* feat(cortex): C-1089.P4 — signal-optional transport verdict on federated hubs by @mellanon in https://github.com/the-metafactory/cortex/pull/1092
* feat(network): C-1087 — derive accept_subjects own ∪ peer subtrees (P2) by @mellanon in https://github.com/the-metafactory/cortex/pull/1096
* feat(cli): register 'cortex creds' subcommand (O-2.5 #1061 follow-up) by @mellanon in https://github.com/the-metafactory/cortex/pull/1098
* chore: bump to v5.23.0 — cortex creds CLI + accumulated 5.22 work by @mellanon in https://github.com/the-metafactory/cortex/pull/1100


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.21.0...v5.23.0

---

### v5.21.0 — v5.21.0 -- Network view shows idle local stacks  ·  2026-06-16

## Mission Control — idle local stacks now show in the Network view (#1082)

The localhost MC Network view was dropping to only the serving stack: a principal's **idle** local stacks (work, halden, community) vanished as hubs. Root cause was a wrong reconciliation between the #1008 DB-read and #989 bus sibling-presence aggregators — they were made mutually exclusive, with the bus path gated off by default. But agent **presence** (the liveness a hub renders — *"up, idle or not"*) lives only in the in-memory registry (bus-fed) and is **never persisted to a sibling's db**, so DB-read could only show a sibling that *"owns a live session."* Idle stacks therefore disappeared.

**Fix — presence via bus, sessions via db (they compose):** the bus sibling-presence aggregator now runs whenever local-stack aggregation is enabled (folding idle-or-active `agent.*` into the registry), while DB-read keeps the working-grid session trees plus a **state-aware, deduped** live-session fallback into `/api/agents` — an active sibling on both paths is one tile, and a live db session revives an offline-by-TTL registry tile (degraded-bus resilience). Adversarially reviewed (a state-aware-dedup blocker was caught + fixed pre-merge) with regression tests.

## Mattermost + brain (#1080, #1081)
- Long Mattermost posts are chunked; task timeout pauses during human gates (#1080).
- Inline file content so the brain can read uploads (#1081).

Frontend (dashboard-v2) redeploys via `build:dashboard`; backend via `arc upgrade Cortex`. The Network-view fix is backend (runtime aggregation) — needs `arc upgrade Cortex` + a daemon restart.

---

### v5.19.1 — v5.19.1 -- network graph hub-select highlight fix  ·  2026-06-16

## Fixes

**Mission Control network graph — hub-select highlight now works (#1074, follow-up to #1070)**
The v5.19.0 highlight-subtree-on-hub-click shipped inert — clicking a stack hub did nothing. Root cause was a double-toggle: the hub card's own a11y `onClick` AND React Flow's bubbling `onNodeClick` both toggled the selection in one event tick, cancelling out (EMPTY→selected→EMPTY). `onNodeClick` no longer toggles for a hub (the card's role=button handler is the sole, a11y-correct toggler). Verified live in-browser: select / toggle-off / switch-hub / empty-canvas-clear all work; non-selected stacks dim to 0.28 opacity. Regression test pins the double-toggle-is-a-no-op invariant.

**Mattermost gate-reply thread-collapse fix (#1073).**

Frontend (dashboard-v2) redeploys via `build:dashboard`; backend via `arc upgrade Cortex`.

---

### v5.19.0 — v5.19.0 -- network graph per-stack colour-coding + highlight  ·  2026-06-16

## Mission Control — network graph per-stack colour-coding + highlight-subtree (#1070)

Each stack in the MC network graph now renders in its own **distinct, deterministic hue** (hub + its agents + its edges). Your **local stack** keeps a reserved signature blue; peer stacks hash into a 10-hue palette that never collides with the local slot.

**Click any stack hub** to spotlight its entire subtree (hub + agents + edges) and dim everything else — making it easy to isolate one stack's activity on the pane-of-glass.

Colour is **a11y-safe**: dimming uses opacity + outline + box-shadow, never hue-only; the legend rows carry text labels; hub buttons are keyboard-activatable (`aria-pressed`).

Frontend-only (dashboard-v2) — backend binary unchanged.

Builds on v5.18.0 (#1060 graph rendering + #1056 migration fix) and #1067 (stack-namespaced React keys).

---

### v5.18.0 — v5.18.0 -- network graph rendering + existing-db migration fix  ·  2026-06-16

## What's Changed
* fix(mc): #1048 — move idx_observability_origin out of SCHEMA_SQL (existing-DB boot crash, #961 class) by @mellanon in https://github.com/the-metafactory/cortex/pull/1056
* feat(mc): network graph — local-sibling hubs + Strata-style orthogonal edge routing by @mellanon in https://github.com/the-metafactory/cortex/pull/1060
* chore: bump to v5.18.0 — network graph rendering (#1060) + existing-db migration fix (#1056) by @mellanon in https://github.com/the-metafactory/cortex/pull/1062


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.17.0...v5.18.0

---

### v5.17.0 — v5.17.0 -- headless MC mode (pane-of-glass producers)  ·  2026-06-16

## What's Changed
* docs(dev-loop): refresh wave-5 plan to verified state (W5.0/W5.4 done; W5.1/W5.5 blocked on #1009/#995) by @mellanon in https://github.com/the-metafactory/cortex/pull/1045
* feat(mc): #1044 — headless MC mode (db+ingestor, no API server) for pane-of-glass producers by @mellanon in https://github.com/the-metafactory/cortex/pull/1046
* chore: bump to v5.17.0 — headless MC mode (#1044) by @mellanon in https://github.com/the-metafactory/cortex/pull/1047


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.16.0...v5.17.0

---

### v5.16.0 — v5.16.0 -- headless MC mode + brain + federated observability  ·  2026-06-16

## What's Changed
* fix(gate): accept natural-language affirmatives (per-word, negation-aware) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1042
* feat(brain): carry inbound attachment refs through the brain task by @jcfischer in https://github.com/the-metafactory/cortex/pull/1043


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.15.3...v5.16.0

---

### v5.15.3 — v5.15.3 -- brain per-task timeout 2min→5min (frontier compose headroom)  ·  2026-06-13

## What's Changed
* fix(brain): raise per-task timeout 2min→5min for frontier compose (Yarrow silent-after-disclosure) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1041


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.15.2...v5.15.3

---

### v5.15.2 — v5.15.2 -- brain posts render to chat (bot packs can finally speak)  ·  2026-06-13

## What's Changed
* fix(render): deliver brain post content — render dispatch.task.post (Yarrow silent fix) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1040


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.15.1...v5.15.2

---

### v5.15.1 — v5.15.1 -- brain posts reach the surface (adapter_instance routing)  ·  2026-06-13

## What's Changed
* fix(dispatch): deliver brain posts — adapter_instance in the post wire routing (#1038 follow-up) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1039


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.15.0...v5.15.1

---

### v5.15.0 — v5.15.0 -- exec-brain triggering: @-mention a bot pack, it composes  ·  2026-06-13

## What's Changed
* feat(dispatch): route exec-brain @-mentions to the brain (cortex#1021 B-3 triggering) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1038


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.14.0...v5.15.0

---

### v5.14.0 — v5.14.0 -- principal gate reply-bridge: ask_principal goes live on chat surfaces  ·  2026-06-13

## What's Changed
* docs: design — Bot Packs: hot-loadable agent brains (extends cortex#60) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1019
* feat(discord): post --file — multipart file attachments by @jcfischer in https://github.com/the-metafactory/cortex/pull/1031
* feat(brain): cortex-brain/v1 protocol + per-task exec runner (B-1, #1021) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1024
* feat(cortex): B-0 — hot agents.d reload + derived provided_by (#1021) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1027
* feat(brain): B-1 wiring — brain: schema + BrainConsumer + hot-reload integration (#1021) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1033
* test: stub review consumer boot registry lookup by @jcfischer in https://github.com/the-metafactory/cortex/pull/1032
* fix(discord): scope channel cache by guild by @jcfischer in https://github.com/the-metafactory/cortex/pull/1034
* feat(brain): B-2 — daemon lifecycle, supervision, surface principal gate (#1021) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1035
* docs: plan — bot-packs completion (bridge → gate → Yarrow) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1036
* feat(bus): adapter inbound reply-bridge + boot the surface principal gate (W-1/W-2) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1037


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.12.2...v5.14.0

---

### v5.12.2 — v5.12.2 -- secure-by-default signing: seed + unset posture boots permissive  ·  2026-06-11

## What's Changed
* fix(security): seed-aware signing default — seed + unset signing boots permissive (#1000) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1020


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.12.1...v5.12.2

---

### v5.12.1 — v5.12.1 -- review-path fixes: egress key-name false positives + sovereignty demand-first  ·  2026-06-11

## What's Changed
* feat(mc): U3.3 — federated observability fold (Option-D trust path for system.{transport,federation}) (#937) by @mellanon in https://github.com/the-metafactory/cortex/pull/1018
* fix(security): sovereignty gate — demand-first; missing agent class denies only when task demands local (#1023) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1025
* fix(security): CO-7 egress config-path detectors — value/path-shaped, not bare key-name tokens (#1022) by @jcfischer in https://github.com/the-metafactory/cortex/pull/1026


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.12.0...v5.12.1

---

### v5.12.0 — v5.12.0 -- pane-of-glass: all local stacks via direct MC-DB aggregation  ·  2026-06-11

## What's Changed
* feat(mc): U2.1 — Observability tab v1, four system.* family renderer (#934) by @mellanon in https://github.com/the-metafactory/cortex/pull/998
* fix(cortex): nkey_pub survives agent resolution so non-MC stacks announce presence (#1006, unblocks #989) by @mellanon in https://github.com/the-metafactory/cortex/pull/1007
* feat(bus): U0.2 — structured system.access.* denial telemetry (gate refuse + consumer drops) (#932) by @mellanon in https://github.com/the-metafactory/cortex/pull/999
* feat(mc): U4.2 — aggregate metrics panels + >14d history (#938) by @mellanon in https://github.com/the-metafactory/cortex/pull/1011
* fix(mc): drop deprecated "operator" from a comment — unblock whole-tree vocab gate by @mellanon in https://github.com/the-metafactory/cortex/pull/1015
* feat(mc): U2.3 — Network-view transport overlay (leaf liveness/RTT/verdicts) (#935) by @mellanon in https://github.com/the-metafactory/cortex/pull/1013
* feat(mc): U3.1 — governance pane (denials/refusals/verdicts, 30d) (#936) by @mellanon in https://github.com/the-metafactory/cortex/pull/1014
* feat(mc): #1008 — pane-of-glass via direct sibling MC-DB read aggregation (local stacks) by @mellanon in https://github.com/the-metafactory/cortex/pull/1016
* chore: bump to v5.12.0 — pane-of-glass sibling MC-DB aggregation (#1008) + presence fixes by @mellanon in https://github.com/the-metafactory/cortex/pull/1017


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.11.1...v5.12.0

---

### v5.11.1 — v5.11.1 -- presence decoupled from mc.enabled (multi-stack pane)  ·  2026-06-11

## What's Changed
* fix(cortex): announce agent presence independent of mc.enabled (#1003, unblocks #989) by @mellanon in https://github.com/the-metafactory/cortex/pull/1004
* chore: bump to v5.11.1 — presence decoupled from mc.enabled (#1003) by @mellanon in https://github.com/the-metafactory/cortex/pull/1005


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.11.0...v5.11.1

---

### v5.11.0 — v5.11.0 -- P-14 drill-down + sideband proxy + multi-bus stack aggregation  ·  2026-06-11

## What's Changed
* fix(mc): red main — widen mc.projection WS frame union (governance.verdict) by @mellanon in https://github.com/the-metafactory/cortex/pull/991
* feat(mc): U0.1 — sideband client + server proxy + loopback-enforced mc.sideband (P-14) by @mellanon in https://github.com/the-metafactory/cortex/pull/983
* fix(config-merge): write timestamped backup atomically at mode 0o600 (#883) by @mellanon in https://github.com/the-metafactory/cortex/pull/992
* fix(adapters,runner): context-poisoning defences + dispatch-sink render idempotency (#987) by @jcfischer in https://github.com/the-metafactory/cortex/pull/988
* feat(runner): W5.0 — signed-commit enforcement for the dev-loop (cortex#924 cortex half) by @mellanon in https://github.com/the-metafactory/cortex/pull/994
* feat(mc): U1.1 — transcript drill-down, best-available source per session (P-14) by @mellanon in https://github.com/the-metafactory/cortex/pull/996
* feat(mc): #989 part-1 — Network view aggregates all local stacks (multi-bus presence) by @mellanon in https://github.com/the-metafactory/cortex/pull/1001
* chore: bump to v5.11.0 — P-14 lane (sideband proxy, transcript drill-down, multi-bus aggregation) by @mellanon in https://github.com/the-metafactory/cortex/pull/1002


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.10.0...v5.11.0

---

### v5.10.0 — v5.10.0 -- Governance tab (G-1115) + engine value rename  ·  2026-06-11

## v5.10.0 — Governance tab + config vocabulary

- **G-1115 ([#986](https://github.com/the-metafactory/cortex/pull/986))** — Mission Control **Governance tab** reads governed-action verdicts off the bus (governance Stage 5).
- **config rename ([#985](https://github.com/the-metafactory/cortex/pull/985))** — the engine value `persona` → `assistant` (closes #921).

Builds on **v5.9.0** (Capability Offering epic — public marketplace + injection hardening). Aligns the GitHub release tag with the `arc-manifest.yaml` version already on `main`.

---

## What's Changed
* refactor(config): rename engine value persona → assistant — closes #921 by @jcfischer in https://github.com/the-metafactory/cortex/pull/985
* feat(mc): G-1115 — Governance tab reads governed-action verdicts off the bus by @jcfischer in https://github.com/the-metafactory/cortex/pull/986


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.9.0...v5.10.0

---

### v5.9.0 — v5.9.0 -- Capability Offering (public marketplace + injection hardening)  ·  2026-06-11

## Capability Offering epic complete — the third control-plane leg (`stack → network → offer`)

This release completes the Capability Offering epic ([#939](https://github.com/the-metafactory/cortex/issues/939)). A capability is no longer a flat tag — it is an **offering** `(capability, offer-scope, accept-policy)`, default-deny local.

### What's in v5.9.0
- **CO-7 ([#980](https://github.com/the-metafactory/cortex/pull/980))** — untrusted-content & prompt-injection hardening (M1–M6): untrusted-content boundary, least-privilege review session, deterministic egress leak-check, persona hardening + red-team gate, and fail-closed gates for the public sandbox backend (M3) and budget cap (M6).
- **CO-5 ([#982](https://github.com/the-metafactory/cortex/pull/982))** — the public PR-review marketplace: the gh-webhook tap translates a validated public-repo PR-opened event into a public `code-review` Offer; admission is metadata-only, pre-LLM, at the tap (ADR-0010). **Ships dark** — inert by default-deny + the M3 backend gate.

(CO-1..4 + CO-6 shipped in v5.8.0.)

### Live public activation is gated (by design)
The public marketplace is built, adversarially reviewed, and test-pinned — but **inert on every live stack** until: **#978** (F-5b non-local sandbox backend), **#977** (accumulating BudgetCheck), **#971** (compliance_block hardening). CO-7's M3 gate fail-closes a public offering on a local backend.

### Decisions
ADR-0008 (offer-scope) · ADR-0009 (per-stack, no shared layer) · ADR-0010 (two-stage public gate, metadata-only admission).

---

## What's Changed
* feat(cortex): CO-7 — untrusted-content & prompt-injection hardening (M1–M6, gates CO-5) by @mellanon in https://github.com/the-metafactory/cortex/pull/980
* feat(cortex): CO-5 — public PR-review marketplace (ships dark, activation gated on #978/#971) by @mellanon in https://github.com/the-metafactory/cortex/pull/982
* chore: bump to v5.9.0 — Capability Offering (public marketplace + injection hardening) by @mellanon in https://github.com/the-metafactory/cortex/pull/984


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.8.0...v5.9.0

---

### v5.8.0 — v5.8.0 -- MC session-tree + capability offerings  ·  2026-06-11

## What's Changed
* docs(dev-loop): iteration plan → v5.6.0 released + wave-5 breakdown by @mellanon in https://github.com/the-metafactory/cortex/pull/930
* design(capability-offering): the third control-plane leg (stack → network → offer) by @mellanon in https://github.com/the-metafactory/cortex/pull/946
* design(capability-offering): §6 threat model — untrusted content & prompt injection by @mellanon in https://github.com/the-metafactory/cortex/pull/948
* design(capability-offering): grill-with-docs hardening → Accepted (ADR-0009/0010 + glossary) by @mellanon in https://github.com/the-metafactory/cortex/pull/949
* docs(capability-offering): iteration plan — repo-side mirror of epic #939 by @mellanon in https://github.com/the-metafactory/cortex/pull/950
* docs(mc): session-tree domain model — terminology + ADR-0008 + refactor map by @mellanon in https://github.com/the-metafactory/cortex/pull/951
* docs(adr): renumber MC session-schema ADR 0008 → 0011 (resolve number collision) by @mellanon in https://github.com/the-metafactory/cortex/pull/956
* refactor: ST-P6 — sub-agent → child/spawned session in display code (CONTEXT.md §Sessions) by @mellanon in https://github.com/the-metafactory/cortex/pull/958
* fix(mc): ST-P3 — reap stuck-running orphan sessions by TTL (zombie tiles) by @mellanon in https://github.com/the-metafactory/cortex/pull/959
* feat(config): CO-1 — capability offering policy model + policy.offerings[] by @mellanon in https://github.com/the-metafactory/cortex/pull/962
* feat(mc): ST-P0 — canonical session schema convergence, local+D1 (ADR-0008) by @mellanon in https://github.com/the-metafactory/cortex/pull/961
* feat(bus): CO-4 — gate posture per offer-scope (DD-CO-3 floor) by @mellanon in https://github.com/the-metafactory/cortex/pull/968
* feat(runner,taps): ST-P1 — parent-session linkage capture end-to-end (CORTEX_PARENT_SESSION_ID) by @mellanon in https://github.com/the-metafactory/cortex/pull/970
* feat(cli): CO-3 — cortex offer CLI (set/list/revoke) + offering→federation-config generation by @mellanon in https://github.com/the-metafactory/cortex/pull/967
* feat(mc): ST-P2 — ingestor registers sessions, not agents (local + D1) by @mellanon in https://github.com/the-metafactory/cortex/pull/972
* feat(bus): CO-2 — consumer wiring binds on offer-scope (byte-identical when local-only) by @mellanon in https://github.com/the-metafactory/cortex/pull/969
* feat(mc): ST-P4 — API projects the session tree (local + cloud, additive DTO) by @mellanon in https://github.com/the-metafactory/cortex/pull/974
* feat(cortex): CO-6 — dev-loop = local offerings (re-point W5.1) by @mellanon in https://github.com/the-metafactory/cortex/pull/976
* feat(mc): ST-P5 — working grid renders the session tree (final phase of #952) by @mellanon in https://github.com/the-metafactory/cortex/pull/979
* chore: bump to v5.8.0 — MC session-tree + capability offerings by @mellanon in https://github.com/the-metafactory/cortex/pull/981


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.7.0...v5.8.0

---

### v5.7.0 — v5.7.0 -- Agent Network Topology + consumer-side sovereignty gate  ·  2026-06-10

## What's Changed
* fix(config): drop the dead api: embedded-dashboard block (last schema divergence) by @mellanon in https://github.com/the-metafactory/cortex/pull/891
* feat(mc): G-1114.A — agent-presence grounding (inert agent.* types + Network preview tab) by @mellanon in https://github.com/the-metafactory/cortex/pull/893
* feat(mc): G-1114.B.1 — agent-presence envelope builders + signing path by @mellanon in https://github.com/the-metafactory/cortex/pull/895
* feat(mc): G-1114.B.2+B.3 — live agent-presence producer + runtime registry (stack-local) by @mellanon in https://github.com/the-metafactory/cortex/pull/896
* feat(mc): G-1114.B.5 — dual-emit + deprecate agents.capabilities.registered (superseded by agent.online) by @mellanon in https://github.com/the-metafactory/cortex/pull/898
* feat(mc): G-1114.B.4 — live agents panel (registry → MC API → dashboard) by @mellanon in https://github.com/the-metafactory/cortex/pull/899
* feat(mc): G-1114.C.1 — agent.capabilities-changed producer by @mellanon in https://github.com/the-metafactory/cortex/pull/901
* feat(mc): G-1114.C.3 — agent-presence liveness FSM (5-min TTL reaper) by @mellanon in https://github.com/the-metafactory/cortex/pull/902
* feat(mc): G-1114.C.4 — agents panel capability badges + offline-state rendering by @mellanon in https://github.com/the-metafactory/cortex/pull/903
* test(mc): G-1114.C.5 — agent-presence lifecycle fixture-replay integration test by @mellanon in https://github.com/the-metafactory/cortex/pull/904
* docs: rewrite README for humans + add README-AGENTS install guide by @jcfischer in https://github.com/the-metafactory/cortex/pull/894
* feat(mc): G-1114.D.1-3 — Network graph view (React Flow + ELK topology) by @mellanon in https://github.com/the-metafactory/cortex/pull/905
* feat(mc): G-1114.D.4 — Network node detail panel (presence + capabilities) by @mellanon in https://github.com/the-metafactory/cortex/pull/907
* feat(bus): consumer-side sovereignty gate (governance Stage 1b) by @jcfischer in https://github.com/the-metafactory/cortex/pull/906
* feat(runner): pi-dev parses sage's structured verdict block — closes #888 by @jcfischer in https://github.com/the-metafactory/cortex/pull/900
* feat(mc): G-1114.D.5 — Network filters + Cmd+K spotlight search by @mellanon in https://github.com/the-metafactory/cortex/pull/913
* fix(mc): wrangler CORS_ORIGIN tracks the 8767 local daemon port by @jcfischer in https://github.com/the-metafactory/cortex/pull/910
* feat(mc): G-1114.E.1+E.2+E.5 — federated agent-presence (opt-in) + trust-verified subscriber by @mellanon in https://github.com/the-metafactory/cortex/pull/914
* feat(mc): G-1114.E.3+E.4 — federated agents in the Network view (multi-hub grouping + scope filter + foreign visuals) by @mellanon in https://github.com/the-metafactory/cortex/pull/916
* feat(mc): G-1114.F — capability-routing UX (match index + hover highlight + dispatch-direct) by @mellanon in https://github.com/the-metafactory/cortex/pull/918
* feat(review): split review engine from LLM backend (engine: sage|persona) by @jcfischer in https://github.com/the-metafactory/cortex/pull/920
* feat(review): prompt carries verdict-block contract + post intent — closes #911 by @jcfischer in https://github.com/the-metafactory/cortex/pull/917
* refactor(runner): move sage-runner out of substrate/ — closes #922 by @jcfischer in https://github.com/the-metafactory/cortex/pull/923


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.6.0...v5.7.0

---

### v5.6.0 — v5.6.0 — the dev-loop component set  ·  2026-06-10

The agentic dev pipeline (epic #835) lands. cortex now ships the components that let the metafactory dev loop run on its own bus:

**Capability consumers**
- `dev.implement` — the dev agent: claims an implement task, cuts a worktree, runs a CC session against the brief, runs gates, opens a PR (dormant-by-default; warm sessions per correlation chain)
- `release.cut` — the release agent, principal-gated (ALWAYS-HUMAN: refuses without an explicit grant marker)

**Durable bus streams**
- `REVIEW_LIFECYCLE` + `DEV_IMPLEMENT` JetStream streams — durable-consumer enablers for the verdict/dispatch + dev-task lifecycles

**Packaging primitives (toward `arc install dev-loop`)**
- `cortex config merge` — merge package-declared capabilities/policy into config-split layers

Every component was adversarially reviewed by the loop itself — the reviews caught (and the authors fixed) an author-spoofable release gate, a permanent-swallow nak, a dry-run that wrote the real file, provisioning failures invisible under --yes, and a secret exposed in argv.

Companion work this cycle: arc gained the install-time primitives (identity + secret provisioning, library ordering, type:process manifest schema); pilot the merge.approve approver + watch reactor; pulse the dev-loop process definition.

Next: wave-5 — assemble the installable `dev-loop` blueprint and the first live end-to-end dogfood run (#887).

---

### v5.5.0 — v5.5.0 -- Mission Control runs in-process (pane-of-glass iteration 1, wave 1)  ·  2026-06-10

## Mission Control pane-of-glass — Iteration 1, wave 1 (umbrella #843)

- **ADR-0005 + ADR-0006** (#842): MC integration architecture (in-process, bus-projected, no legacy lift) + registry-anchored network-view feed; CONTEXT.md gains the **session interior** sovereignty rule (interiors never leave the stack).
- **MC runs in-process** (#854): new `mc:` config block; `startMissionControl` embed owns mission-control.db; the never-resolvable `setupDashboard` import (#712) retired; cockpit refresh loop finally reaches a live DB handle; awaitable shutdown, teardown-safe partial boot.
- **cc_session_id on the dispatch lifecycle** (#852): payload-only widening; terminal envelope carries the authoritative id (resume divergence documented + pinned by test).
- **Orphan session auto-registration** (#856): instrumented sessions (e.g. cldyo-live) auto-register as observed orphans instead of being dropped; retention follow-up #857.

Next wave: S2 (enable on meta-factory + live verify), S4 (dispatch lifecycle → MC session projection).

---

### v5.4.3 — v5.4.3 -- review consumer unblocks local same-principal dispatch on federated stacks (#836)  ·  2026-06-09

## What's Changed
* fix(bus): C-836 — review consumer gates requester check on subject scope, not the federated mode flag (unblocks local dispatch on federated stacks) by @mellanon in https://github.com/the-metafactory/cortex/pull/837


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.4.2...v5.4.3

---

### v5.4.2 — v5.4.2 -- ping config-split aware + join health inconclusive on absent monitor (#830, #831)  ·  2026-06-09

## What's Changed
* fix(network): C-830 ping config-split aware + C-831 join health inconclusive on absent monitor by @jcfischer in https://github.com/the-metafactory/cortex/pull/833
* docs(design): the agentic dev pipeline — pilot loop on the IoAW bus by @mellanon in https://github.com/the-metafactory/cortex/pull/834


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.4.1...v5.4.2

---

### v5.4.1 — v5.4.1 -- join never renders a nats-crashing leaf config (#821)  ·  2026-06-09

## What's Changed
* fix(network): join never renders a nats-crashing leaf config — operator-mode account-required + pre-flight + restart-rollback (closes #821) by @mellanon in https://github.com/the-metafactory/cortex/pull/828


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.4.0...v5.4.1

---

### v5.4.0 — v5.4.0 -- registry roster fixes (cap-preserve #819, networks-union #820) + network ping + DD-5 peers  ·  2026-06-09

## What's Changed
* docs(design): cortex network ping + signal P-11 synthetic probe (DECIDED) by @mellanon in https://github.com/the-metafactory/cortex/pull/816
* docs(design): public scope — capability-announce + inbound allowlist (open-square / IoAW) by @mellanon in https://github.com/the-metafactory/cortex/pull/817
* fix(network-registry): C-819 — merge-preserve capabilities on re-register (stop silent roster eviction) by @mellanon in https://github.com/the-metafactory/cortex/pull/823
* feat(federation): resolve federated peers[] from the registry roster at boot (DD-5 wiring) by @mellanon in https://github.com/the-metafactory/cortex/pull/818
* feat(network): cortex network ping + federated echo responder (signal#113 P-11) by @mellanon in https://github.com/the-metafactory/cortex/pull/822
* fix(network): C-820 — union capability networks[] on join (multi-network cap-roster membership) by @mellanon in https://github.com/the-metafactory/cortex/pull/826
* fix(network-registry): #825 — optimistic-concurrency CAS for concurrent register/join by @mellanon in https://github.com/the-metafactory/cortex/pull/829


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.3.11...v5.4.0

---

### v5.3.11 — v5.3.11 -- network status is config-split aware (#814)  ·  2026-06-09

## `cortex network status` now sees config-split stacks

`cortex network status` reported "no networks joined" for a config-split stack whose leaf was actually live — it took no `--config` and read the default monolith `~/.config/cortex/cortex.yaml` instead of the named stack's file.

**Fixed (#814):**
- `status` accepts `--config` (explicit override), and otherwise resolves the named stack's config **layout-aware** (mirrors `resolve_stack_config_path`) so it reads the file the daemon actually composes from.
- The no-`--stack` default now maps to the canonical `meta-factory` bare-name default (was resolving a nonexistent `cortex.default.yaml`).
- Read-only — the threaded `--config` only redirects the read.
- Adds the **cortex↔signal observability boundary** to `CONTEXT.md`: cortex owns a stack's own control-plane federation state (`cortex network status`); signal owns network-wide observability (the-metafactory/signal#113).

So `cortex network status --principal <you> --stack <you>/<stack>` now correctly shows a config-split stack's joined networks + leaf state.

Reviewed code-review (1 MAJOR default-stack + 1 nit, fixed). 27 network-cli + 4988 full tests green.

closes #814

---

### v5.3.10 — v5.3.10 -- network join writes policy where the daemon reads (#805, #807)  ·  2026-06-09

## The network-join split-brain is fixed

`cortex network join` wrote `policy.federated.networks` to a file the daemon never read — `stackConfigPath` derived its target from `stack.id` + a hardcoded `~/.config/cortex`, ignoring the daemon's real `--config`. Status said "joined", the leaf never linked. (JC's repro: single-file `cortex.yaml`, stack.id `jc/default` → join wrote `stacks/default.yaml`, daemon read `cortex.yaml`.)

**Fixed (#805, #807):**
- The join now resolves the write target from the daemon's actual `--config`, layout-aware — **monolith → into that file**; **config-split → `<dir>/stacks/<basename>.yaml`** keyed off `--config`, not `stack.id` (that's #807's directory-layout corner).
- **Comment-preserving writes** — in-place edits to a hand-maintained `cortex.yaml` now go through the YAML Document API, so your comments + key order survive a join/leave.
- **Fail-closed guard** — the join refuses to write unless a running cortex daemon actually loads the resolved `--config` (no orphan policy block; clear, actionable error telling you which `--config` to pass).
- **ADR-0004 reconciled** (DA-5): the write path is locator-resolved and `stack.id`-convergent under the alignment invariant — it follows the daemon's real config on a drifted stack so the write stays effective, while `warn_stack_identity_drift` (v5.3.8) flags the drift for reconciliation.

Reviewed by code-review + an independent adversarial pass (4 MAJORs found and fixed: comment destruction, residual split-brain, the ADR contradiction, a parity-comment overclaim). network suite 150 / full 4983 tests + tsc/lint/vocab all green.

closes #805 · closes #807

---

### v5.3.9 — v5.3.9 -- cortex stack create (born-aligned, unique stack scaffold)  ·  2026-06-09

## `cortex stack create` — a stack born aligned, so drift can't form

The prevent-side complement to v5.3.8's drift **detector** (ADR-0004). `cortex stack create <slug>` scaffolds a config-split stack **born aligned** — dir basename == slug == trailing segment of `stack.id` — and **unique within the principal** (refuses a dir collision OR a duplicate `stack.id`). The slug↔`stack.id` drift that bit JC can't form for a stack created this way.

```
cortex stack create research --principal andreas         # dry-run: prints the file set
cortex stack create research --principal andreas --apply # writes the config-split skeleton
cortex stack list                                         # discovered stacks + aligned/DRIFT flag
```

- **Dry-run by default**; `--apply` to write. **Never overwrites**; **rolls back** a partial scaffold on a mid-write failure.
- Scaffolds the full config-split skeleton from the `docs/config-layout/` template, filled with your real slug/principal — born-loadable through the real config loader.
- Does **not** mint signing keys — `arc upgrade Cortex` auto-provisions on first install.

Reviewed code-review + adversarial (two MAJORs found+fixed: `--display-name` YAML-injection guard + partial-write rollback). 38 stack tests + full suite green.

**Docs:** CLAUDE.md `## Network Management` → **Platform Management** (+ `cortex stack create`); config-layout README "Even easier" quick-start; stack-onboarding SOP Part 1 leads with the command.

closes #808

---

### v5.3.8 — v5.3.8 -- stack.id is the canonical slug authority + arc-upgrade drift detection  ·  2026-06-09

## stack.id is the slug authority; drift is now detected at upgrade time

A cortex stack is named by a **slug** in four places — the federation identity (`stack.id`), the `cortex network join` write path, the config file/dir name (the lifecycle-script *locator*), and the launchd/systemd label. Nothing reconciled the `stack.id`-driven pair against the filename-driven pair, so a stack could **drift**: federate as one identity while labelled another (JC's stack: dir/plist `meta-factory`, `stack.id` `jc/default`). It passed every test and review because no artifact stated the names must agree.

**This release makes `stack.id` the single slug authority and detects drift.**

- `extract_stack_id_slug` + `warn_stack_identity_drift` (`scripts/lib/plist-render.sh`): `arc upgrade`/install now **warns** (stderr, host-independent — Linux/systemd too) when a stack's locator slug ≠ its `stack.id` slug, naming both names and the one-line remediation.
- **Warn, never fail** (ADR-0004 DA-3): a hard error would brick `arc upgrade` for a drifted stack. Reconciliation is a principal rename of the dir/file onto `stack.id`, not an auto-rewrite.
- `CONTEXT.md` §"Stack slug" + `docs/adr/0004-stack-slug-authority.md` establish the invariant (and arm the code-review ArchitectureDocs lens to catch re-introduction).
- Detection-only, additive: **aligned stacks stay silent — zero behaviour change.**

Reviewed by code-review + an independent adversarial pass (converged; one CRLF false-positive found and fixed). CI green; 72 lifecycle tests + 4939 unit tests pass.

refs #810 (the deeper re-derivation + `cortex stack` create/uniqueness tooling remain tracked there / in #808).

---

### v5.3.7 — v5.3.7 -- config example → config-split format  ·  2026-06-09

#809: the shipped config example is now the **config-split (multi-file) layout** — self-documenting `docs/config-layout/` template (system/stacks/network + pointer), `cortex.yaml.example` marked LEGACY, a 'Configuration files' section in CLAUDE.md, and the sop-stack-onboarding pointer. New installs (and migrating peers) land on the standard format. Scaffold to auto-place it: #808.

---

### v5.3.6 — v5.3.6 -- daemon restart resolves by --config, not plist-label shape (#800)  ·  2026-06-08

## What's Changed
* fix(cortex): C-800 — resolve daemon restart by --config, not stack slug by @jcfischer in https://github.com/the-metafactory/cortex/pull/806


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.3.5...v5.3.6

---

### v5.3.5 — v5.3.5 -- peer-side network join fixes (no-account $G leaf, restart label, leave base -c)  ·  2026-06-08

C-799/800/801 (#803): a peer principal on a default-global-account ($G) bus can now join a network — `cortex network join` renders a no-account leaf remote (creds JWT binds), derives the restart label from the configured plist, and `leave` preserves the base `-c` config. Unblocks jc/default → metafactory-community without operator-mode conversion.

---

### v5.3.4 — v5.3.4 -- network status reflects authoritative leafz leaf-state (#797)  ·  2026-06-08

## What's Changed
* fix(network): C-797 — cortex network status reflects authoritative leafz leaf-state (no more link:unknown) by @mellanon in https://github.com/the-metafactory/cortex/pull/802


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.3.3...v5.3.4

---

### v5.3.3 — v5.3.3 -- network join fail-fast + network management docs  ·  2026-06-08

C-794 (#795): `cortex network join` fails fast — refuses (touches nothing) when the stack's nats bus can't bind the leaf account (anonymous/isolated), instead of crashing nats. #796: network SOPs (create/join/multi-stack/operator-mode) + durable docs/agents-md/network-management.md CLAUDE.md section.

---

### v5.3.2 — v5.3.2 -- network join multi-stack (--principal-seed)  ·  2026-06-08

C-791 (#793): `cortex network join --principal-seed <root>` lets a principal's 2nd+ stack join a network (root-signed add-stack, reusing #787). Announce-aware idempotency (join-after-register still populates the roster), capability fetch+merge (preserves prior-network membership), and a fail-closed signature-verified merge-read (the destructive read now trusts only signed registry records — dev=prod parity). Adversarial-reviewed; FIX-FIRST findings closed.

---

### v5.3.1 — v5.3.1 -- bash-guard grove→cortex env fix (bots can run gh/aws/git again)  ·  2026-06-08

## What's Changed
* fix(bash-guard): read CORTEX_* env names so bot sessions reach grant() (grove→cortex straggler) by @mellanon in https://github.com/the-metafactory/cortex/pull/792


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v5.3.0...v5.3.1

---

### v5.3.0 — v5.3.0 -- per-stack pubkeys (multi-stack federation)  ·  2026-06-08

C-787 (#790): a principal can federate MULTIPLE stacks, each with its own signing key. Registry stores per-stack pubkeys (root key authorizes add-stack; migration 0003 backfills existing rows); client verify resolves (principal,stack)→stack_pubkey; `provision-stack register --principal-seed <root>` performs the authorized add-stack (fetch+merges existing stacks — no data loss). Adversarial security review: SAFE (every impersonation path blocked). Deploy: `wrangler deploy` + `d1 migrations apply` for the registry.

---

### v5.2.0 — v5.2.0 -- signed-admin network creation (cortex network create)  ·  2026-06-08

C-747 (#785): `cortex network create <id> --hub <url> --leaf-port <port> --admin-seed <path> --apply` replaces raw-SQL/D1 network seeding. Registry gains a fail-closed signed-admin `POST /networks/:id` (Ed25519-over-claim, allowlist via REGISTRY_ADMIN_PUBKEYS, no anonymous hub_url write). Also v5.1.4: C-127 bashAllowlist plumbed through bus dispatch. 22 new tests, CI green.

Deploy: registry needs `REGISTRY_ADMIN_PUBKEYS` set + redeploy; CLI ships via arc upgrade.

---

### v5.1.4 — v5.1.4 -- C-127: bashAllowlist plumbed through bus dispatch (guild stacks unblocked)  ·  2026-06-08

C-127 (#783): the executing stack now applies its own claude.bashAllowlist to every bus dispatch (receiving-stack-authoritative; default-deny preserved). Unblocks gh/bash auto-approve on guild-only stacks (community, halden). Tests green; deployed via arc.

---

### v5.1.3 — v5.1.3 -- bash-guard auto-approves allowlisted commands in async dispatch  ·  2026-06-07

Fix (#777/#778): the bash-guard now emits Claude Code's auto-approve decision (permissionDecision:allow) for allowlisted commands, instead of a pass-through that left the restricted async --print session stalling on 'requires approval'. So allowlisted+safe commands (gh pr/issue/repo/api/run, read-only aws #769, git read-only, ...) actually RUN in dispatched bot sessions. Dangerous/full bash stays operator-DM-only. Adversarial-reviewed: grant() is the single success terminal, reachable only after rejectsChaining (#770), all-parts-match, and the gh repo-restriction; deny-worthy commands never reach it.

---

### v5.1.2 — v5.1.2 -- grove-naming retirement (non-breaking) + deterministic CI gate  ·  2026-06-07

Non-breaking grove cleanup: `GROVE_BASH_GUARD`→`CORTEX_BASH_GUARD` (#768, internal); EventLogger instrumentation env path now CORTEX_*-native (CORTEX_CHANNEL/NETWORK/AGENT_NAME/AGENT_ID/PROJECT/ENTITY/PRINCIPAL) with GROVE_* read-fallback RETAINED (#774) — dashboard pipeline verified both ways. Plus #771: de-flaked the full-suite CI Test gate (settle-on-terminal-envelope instead of fixed sleeps) + fixed pre-existing Linux-CI platform-default failures. Breaking GROVE_* fallback removal deferred (G-2b/G-3b) until MIG-8 confirmed closed.

---

### v5.1.1 — v5.1.1 -- SECURITY: bash-guard ACE-bypass fix + read-only aws allowlist  ·  2026-06-07

**SECURITY (SEV):** the bash-guard (which constrains what dispatched bot sessions can execute) had an arbitrary-code-execution bypass — it only split on `&& || ;` and ignored `|`, `$()`, backticks, redirects, newlines, and the env-prefix `$()` smuggle (`AWS_PROFILE="$(touch x)" aws sts …` ran arbitrary code while the guard returned ALLOW). Affected every allowlist rule on all stacks. Fixed (#769/#770): reject shell metacharacters on the RAW command before allow-matching (14/14 smuggle vectors denied). Caught by adversarial review (two distinct holes, both proven end-to-end). Plus a read-only aws allowlist pattern (profile/region/env-tolerant; denies send-command/start-session/write verbs). Deploy fleet-wide.

---

### v5.1.0 — v5.1.0 -- federation round-trip functional + Linux support  ·  2026-06-06

**The federation round-trip now actually works, on macOS and Linux.**
- #762: `cortex network join` announces your capabilities INTO the network (capability.networks[]) so you appear in the discovered roster — registry-resolved peers now resolve (was empty roster → 0 peers). Preserves hand-pins on an empty roster (no clobber).
- #763: Linux/systemd support — launchd/systemd `NatsServiceManager` abstraction; `--unit` flag; systemd ExecStart `-c` ensure + systemctl restart. macOS unchanged. Unblocks clawbox + Linux peers.
Combined with v5.0.3's one-liner: `cortex network join <network> --apply` works cross-platform.

---

### v5.0.3 — v5.0.3 -- one-liner network join (dispatcher + config-derived inputs)  ·  2026-06-06

`cortex network join <network> [--apply]` now works with no flag wall: registered as a commander subcommand (#752, drops the bun src/... prefix) and derives principal/stack/seed/registry/account/nats-infra from the stack config (#753, flags become optional overrides). New `stack.nats_infra` config block. Follow-ups: #762 (announce caps into network → populate roster), #763 (Linux/systemd support).

---

### v5.0.2 — v5.0.2 -- network join integration fixes (config-split policy path + nats-server restart)  ·  2026-06-06

Patch: `cortex network join` now (1) writes policy.federated.networks[] to the config-split path `<stack>/stacks/<stack>.yaml` the daemon actually loads (#756), and (2) restarts nats-server after mutating local.conf so the leaf takes effect (#757). With v5.0.1's include fix (#754), the one-command join is now fully integration-correct — unblocks JC onboarding.

---

### v5.0.1 — v5.0.1 -- Fix dormant-leaf gap in network join  ·  2026-06-06

Patch: `cortex network join --apply` now wires `local.conf` to `include` the rendered leaf file (#754) — v5.0.0 wrote the leaf file + ensured the plist loads local.conf but never made local.conf reference the leaf, leaving the leaf dormant. Idempotent ensure/remove-include on join/leave. Unblocks the v5 federation migration + JC onboarding.

---

### v5.0.0 — v5.0.0 -- Network Join Control Plane (IoAW: one-command join)  ·  2026-06-06

## Network Join Control Plane — the Internet of Agentic Work, one command

Joining a network goes from ~10 manual steps across four Myelin layers + an out-of-band key swap to **`cortex network join <network>`** — designed to **feel like TCP/IP**: autoconfiguring, invisible layers, registry as source of truth.

**Highlights:**
- **One-command join** (`cortex network join/leave/status`) — dry-run by default, `--apply` to act. Registers, pulls the signed network descriptor, renders the nats-server leaf, writes on-contract federation config, restarts.
- **Registry-resolved peers** — declare a peer by `principal_id`; the pubkey is resolved from the registry-signed roster. No more hand-pinning (kills the identity-drift class).
- **local / federated / public scopes** — the three onboarding tiers; **public scope is deny-by-default** (allowlist-gated, no anonymous claim — closes a pre-existing ungated-`public.*` hole).
- **Security spine:** pin+verify the registry (DD-9), cache-after-verify resilience (DD-10), fail-closed on pin↔resolved mismatch (DD-11), registry-served hub descriptor (DD-12), compiler-enforced verified-descriptor trust boundary.

ADR-0003 + `docs/sop-network-join.md`. Epic #733 (S1–S6 + S2.5). Adversarial review caught & fixed 4 security issues pre-merge (registry-write MITM, HOCON injection, never-throws half-mutate, ungated public scope).

Follow-ups: #747 (signed-admin network-creation API), typed public-denied envelope, config-derived join inputs.

---

### v4.8.0 — v4.8.0 -- Trust-aware content filter, session isolation, per-skill grants, network roster  ·  2026-06-06

## What's Changed
* docs: design spec — Network Join Control Plane (epic #733) by @mellanon in https://github.com/the-metafactory/cortex/pull/734
* fix(bus): C-741 — trust-aware content filter (exempt operator/home principal from hard block) by @mellanon in https://github.com/the-metafactory/cortex/pull/742
* feat(registry): S1 — network descriptor + roster client (pin+verify, cache) by @mellanon in https://github.com/the-metafactory/cortex/pull/743


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v4.7.2...v4.8.0

---

### v4.7.2 — v4.7.2 -- Clear the 'working…' placeholder on terminal dispatch events  ·  2026-06-06

## What's Changed
* fix(sinks): C-731 — clear the "working…" placeholder on terminal lifecycle events by @mellanon in https://github.com/the-metafactory/cortex/pull/732


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v4.7.1...v4.7.2

---

### v4.7.1 — v4.7.1 -- Content filter: trust-scope the principal's channel @mentions  ·  2026-06-05

## What's Changed
* docs: federation peering runbook (cross-principal review test) by @mellanon in https://github.com/the-metafactory/cortex/pull/728
* fix(dispatch): C-729 — trust-scope the prompt filter for the operator's channel @mentions, not just DMs by @mellanon in https://github.com/the-metafactory/cortex/pull/730


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v4.7.0...v4.7.1

---

### v4.7.0 — v4.7.0 -- Federated review loop complete (Offer + Direct)  ·  2026-06-05

## ✨ Federated review loop COMPLETE
- **Direct-mode federated review (#725/#727)** — the federated review consumer now handles **Direct** (`@reviewer`) requests in addition to Offer. Subscribes `federated.{me}.{stack}.tasks.*.code-review.>` (the `@{did}` reviewer segment), with a verdict-back path **byte-identical to Offer** (requester decoded from `originator.identity`, peers[]-gated, fail-closed). With #686 (Offer, v4.6.0) + pilot#149, the cross-principal review loop is now contract-complete for **both** dispatch modes. Additive/dormant until a peer is configured + pilot is deployed.

## 🛡️ Anti-drift system (lands in CLAUDE.md)
- **Federation Wire Protocol SOP** (compass) now propagates into CLAUDE.md (#726; arc#203 regen fix) + the `/code-review` **FederationGrammar lens** + `/wire-check` — the gate for this grammar at design + review time. Proven: **5/5 PASS** on #715 and #727.

## 📐 Contract
ADR-0001 (subject grammar) + ADR-0002 (dispatch addressing + verdict-back: source addresses target, requester in `originator` as `did:mf:{principal}-{stack}`, network off-wire).

Builds on v4.6.0 (federated consumer + operator trust-scope) and the v4.5.x hardening line.

---

### v4.6.0 — v4.6.0 -- Federated review consumer + operator trust-scope  ·  2026-06-05

## ✨ Federated review loop (Offer) closed
- **Federated review consumer (#686/#715)** — cortex now consumes cross-principal review-requests on the ADR-0002 grammar (`federated.{me}.{stack}.tasks.code-review.>`), gates the requester via `peers[]`, and emits the verdict back to `federated.{requester}.{stack}.review.verdict.*` (requester decoded from `originator.identity` = `did:mf:{principal}-{stack}`). Lands in lockstep with **pilot#149** (requester side). Direct-mode consumption is a follow-up (#725); Offer (`--principal`) is the working path. Dormant until a peer is configured + pilot is deployed.

## 🐛 Fixes
- **Prompt-filter trust-scope (#723/#724)** — the prompt-injection filter no longer hard-blocks the **home principal's own DMs** (the PI-002 `act as` false positive). The principal commands their own assistant; the filter still blocks untrusted senders. Match is logged. (content-filter#20 filed to tune the pattern itself.)

## 📐 Contract
- **ADR-0002** (federated dispatch addressing + verdict-back) + the **Federation Wire Protocol SOP** (compass) + the `/code-review` FederationGrammar lens + `/wire-check` — the anti-drift gate for this grammar.

---

### v4.5.2 — v4.5.2 -- Per-dispatch Discord progress  ·  2026-06-05

Patch on v4.5.1.

## 🐛 Fix
- **Per-dispatch progress on the bus path (#721/#722).** The "Luna is working…" placeholder was reused across interactions in the same channel/thread (sequential dispatches collapsed onto one message) because the bus dispatch-sink + review-sink built the progress target without a session key. #708/#713 only covered the in-process path. Now keyed on `envelope.correlation_id` — each dispatch gets its own progress message.

## 📄 Docs
- ADR-0002 (federated dispatch addressing + verdict-back contract) (#720); stock-take v3→v4.5.1 (#719).

## ⚠️ Deploy
`arc upgrade Cortex` on the config-split layout (preserved by #717). The progress fix is in the bot code, so it takes effect on this deploy.

---

### v4.5.1 — v4.5.1 -- Config-split-aware upgrade lifecycle  ·  2026-06-05

Patch on v4.5.0 — unblocks deploying onto the config-split layout.

## 🐛 Fix
- **Config-split-aware upgrade lifecycle (#717).** `arc upgrade Cortex` previously globbed the retained root monoliths (`cortex*.yaml`) and re-pointed every stack's plist `--config` back at them — **reverting the config-split** on every upgrade. Now the lifecycle discovers **per-stack dirs** (`<stack>/system/system.yaml` marker), renders `--config` at the per-stack sentinel (`<stack>/<stack>.yaml`, preserving the unique `cortex-<slug>.pid` naming), and **dedupe-ignores the retained monoliths** (dir wins). Templates use a single `__CONFIG_PATH__` placeholder. Back-compat with the legacy single-file layout retained. 61 shell-test assertions including a fixture mirroring the live state.

## ⚠️ Deploy
This is the release that makes `arc upgrade Cortex` safe on the config-split layout. On upgrade it runs the stack-aware lifecycle (#700) against the split dirs and **preserves** the per-stack layout. First real run = the held #700 live smoke-test (halden + work + meta-factory).

---

### v4.5.0 — v4.5.0 -- Per-skill grants + Discord multi-stack hardening  ·  2026-06-04

Builds on the v4.2.0–v4.4.1 multi-stack-hardening + ADR-0001-grammar line. New since v4.4.1:

## ✨ Features
- **Per-skill capability grants (#710).** Bot sessions are **default-deny** on skills; a granted agent gets **exactly** its named skills, enforced by a per-session PreToolUse hook (`skill-guard`) — the correct mechanism (Claude Code's `Skill` tool has no `Skill(<name>)` rule syntax, so the #706 Part-B tool-rule approach was impossible). The hook is symlink-only / per-session, so it never gates the operator's own sessions. **Live-confirmed**: a granted skill launches, an un-granted skill is denied and never runs.

## 🐛 Fixes
- **Discord per-session progress (#708).** Concurrent sessions in the same channel/DM each own their "working…" message instead of collapsing onto one.
- **DM stack-ownership (#709).** A DM to a shared-token bot is answered **once**, not ×N across stacks — config-driven (`dmOwner`, default true), complementing the v4.4.x guild filter (#704).

## 🗂️ Ops / docs
- **Config-split executed (migration 0003, #714).** All stacks (meta-factory / work / halden) migrated to the multi-file layout (`system/` + `stacks/` per dir). Includes the live-cutover **PID-collision lesson** (per-stack sentinel filenames are mandatory).

## ⚠️ Post-deploy
On `arc upgrade Cortex` this is the **first real run of the stack-aware upgrade lifecycle (#700)** against the config-split layout. Live re-verifies to run after deploy: guild/DM single-answer (#704/#709), per-session progress (#708). Per-skill grants (#710) take effect only for agents with `allowed_skills` configured.

## Not included
Federated review consumer (#686 — held, lockstep with pilot#149); payload encryption (TC-3, deferred). Security posture remains OFF (IoAW-first).

---

### v4.4.1 — v4.4.1 -- Mission Control dashboard dist-path fix  ·  2026-06-04

## What's Changed
* fix(mc): dashboard dist path — resolve to repo root after src/surface/mc lift by @jcfischer in https://github.com/the-metafactory/cortex/pull/711


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v4.4.0...v4.4.1

---

### v4.4.0 — v4.4.0 -- Session settings isolation (C-701 Part A)  ·  2026-06-04

## What's Changed
* fix(test): C-699 — de-flake full-suite crypto/subprocess tests (ephemeral ports + teardown) by @mellanon in https://github.com/the-metafactory/cortex/pull/707
* feat(runner,gateway): C-701 Part A — session settings isolation + gateway fail-closed Skill deny by @mellanon in https://github.com/the-metafactory/cortex/pull/706


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v4.3.0...v4.4.0

---

### v4.3.0 — v4.3.0 -- Cross-stack guild isolation, stack-aware upgrades, nonce-before-verify  ·  2026-06-04

## What's Changed
* fix(network-registry): verify signature before recording nonce (#695) by @mellanon in https://github.com/the-metafactory/cortex/pull/697
* docs: SOP — cross-operator federation onboarding (+ JC message) by @mellanon in https://github.com/the-metafactory/cortex/pull/698
* fix(scripts): C-700 — stack-aware upgrade lifecycle (enumerate stacks, don't hardcode) by @mellanon in https://github.com/the-metafactory/cortex/pull/702
* feat(myelin): C-691 — federated subject grammar → ADR 0001 ({principal}.{stack}, network off-wire) by @mellanon in https://github.com/the-metafactory/cortex/pull/703
* fix(adapters/discord): C-704 — filter messageCreate by configured guildId (cross-stack leak) by @mellanon in https://github.com/the-metafactory/cortex/pull/705


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v4.2.0...v4.3.0

---

### v4.2.0 — v4.2.0 -- Trust track, network registry & Discord multi-server  ·  2026-06-04

## What's Changed
* feat(dashboard): rebrand UI Grove → Cortex by @mellanon in https://github.com/the-metafactory/cortex/pull/642
* fix(bus): TC-1a — thread stackIdentity into review-consumer verifier (closes #535) by @mellanon in https://github.com/the-metafactory/cortex/pull/643
* feat(config): TC-4a — enforce chmod-600 on cortex.yaml (closes #636) by @mellanon in https://github.com/the-metafactory/cortex/pull/644
* docs: design + iteration plan — Trust & Confidentiality (signed/encrypted/federated) by @mellanon in https://github.com/the-metafactory/cortex/pull/641
* docs: vocab carve-out fix — operator→principal in trust design by @mellanon in https://github.com/the-metafactory/cortex/pull/650
* feat(config): TC-0 — security posture toggles + signing-mode wiring (closes #628) by @mellanon in https://github.com/the-metafactory/cortex/pull/646
* feat(taps): TC-4b — tighten event published/ dir to 0700 + mode audit (closes #637) by @mellanon in https://github.com/the-metafactory/cortex/pull/647
* feat(gateway): F-1 — relax single-principal guard + multi-principal subjects (closes #629) by @mellanon in https://github.com/the-metafactory/cortex/pull/648
* feat(gateway): F-1b — inbound cross-principal publish on binding principal (closes #651) by @mellanon in https://github.com/the-metafactory/cortex/pull/652
* test(gateway): F-2 — cross-principal collaboration end-to-end validation + example (closes #630) by @mellanon in https://github.com/the-metafactory/cortex/pull/653
* feat(mc-worker): DO-backed dashboard WebSocket (/ws) for cloud-mode live push by @mellanon in https://github.com/the-metafactory/cortex/pull/654
* feat(bus): TC-1c — Shape B re-sign gateway-injected envelopes on ingest (closes #552) by @mellanon in https://github.com/the-metafactory/cortex/pull/655
* docs(bus): F-3 design + iteration plan — multi-link / multi-network runtime (refs #631 #348) by @mellanon in https://github.com/the-metafactory/cortex/pull/656
* feat(config): F-3a — inline nats: per federated network + leaf_node consistency validator (closes #657) by @mellanon in https://github.com/the-metafactory/cortex/pull/658
* feat(bus): F-3b — LinkPool core: per-network leaf links + subject-routed publish (closes #659) by @mellanon in https://github.com/the-metafactory/cortex/pull/660
* test(bus): TC-1d — validate signing: enforce rejects unsigned end-to-end (closes #210) by @mellanon in https://github.com/the-metafactory/cortex/pull/664
* docs: fix vocab gate + record at-rest encryption not implemented by @mellanon in https://github.com/the-metafactory/cortex/pull/665
* feat(bus): F-3c — LinkPool degrade-don't-crash lifecycle + background reconnect (closes #662) by @mellanon in https://github.com/the-metafactory/cortex/pull/663
* feat(bus): F-3d — inbound sourceLink attribution (hook for cross-leaf verify) (closes #666) by @mellanon in https://github.com/the-metafactory/cortex/pull/667
* fix(bus): #661 — deriveNatsSubject emits federated.{network_id} (aligns emit↔route↔subscribe) by @mellanon in https://github.com/the-metafactory/cortex/pull/668
* fix(runner): de-flake bash-guard ingest test — ephemeral port (closes #670) by @mellanon in https://github.com/the-metafactory/cortex/pull/671
* feat(bus): TC-2a — registry client resolves peer pubkeys via GET /principals/{id} (#633) by @mellanon in https://github.com/the-metafactory/cortex/pull/672
* feat(bus): TC-2b — multi-principal peer-stamped IdentityRegistry (#634) by @mellanon in https://github.com/the-metafactory/cortex/pull/673
* feat(bus): TC-2d — federated.* crypto-verify against registry-resolved peer pubkeys (#635) by @mellanon in https://github.com/the-metafactory/cortex/pull/674
* feat(bus): TC-1b — stack-identity provisioning + boot verifier-self-check (#632) by @mellanon in https://github.com/the-metafactory/cortex/pull/675
* docs: SOP — network-registry provisioning + deploy runbook by @mellanon in https://github.com/the-metafactory/cortex/pull/676
* feat(network-registry): registry-keypair generation command + PKCS#8 format fix (closes #677) by @mellanon in https://github.com/the-metafactory/cortex/pull/678
* feat(mc-worker): grove→cortex DEV cutover (Phase 1) by @mellanon in https://github.com/the-metafactory/cortex/pull/684
* feat(bus): TC-4d/4e — transport mTLS (NATS + cloud-publisher) + non-TLS federated-leaf warning by @mellanon in https://github.com/the-metafactory/cortex/pull/683
* feat(network-registry): app-layer rate limiting + enumeration policy — dev=prod identical (closes #680, #681) by @mellanon in https://github.com/the-metafactory/cortex/pull/687
* docs(adr): ADR 0001 — federated subjects carry {principal}.{stack}, not the network by @mellanon in https://github.com/the-metafactory/cortex/pull/690
* feat(mc-worker): grove→cortex PROD cutover (Phase 2) — additive stack by @mellanon in https://github.com/the-metafactory/cortex/pull/689
* feat(network-registry): D1-backed durable storage + durable nonce cache (closes #682) by @mellanon in https://github.com/the-metafactory/cortex/pull/694
* feat(cli/discord): multi-server support — --guild flag + named server profiles by @mellanon in https://github.com/the-metafactory/cortex/pull/696


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v4.1.0...v4.2.0

---

### v4.1.0 — v4.1.0 — Unified surface gateway (inbound demux + outbound reply round-trip)  ·  2026-06-03

## What's Changed
* docs(security): IAW E.7 — envelope encryption design (#369) by @mellanon in https://github.com/the-metafactory/cortex/pull/526
* feat(config): CFG.a — multi-file config composer + single-file fallback (#523) by @mellanon in https://github.com/the-metafactory/cortex/pull/525
* docs(agents): IAW E.3 — delegation-primitives design (#350) by @mellanon in https://github.com/the-metafactory/cortex/pull/527
* docs(iaw): GW shared-gateway (#524) + Phase-E multi-network bridge (#117) designs by @mellanon in https://github.com/the-metafactory/cortex/pull/528
* feat(config): CFG.b — system.yaml layer + loud nats.subjects validation (#523) by @mellanon in https://github.com/the-metafactory/cortex/pull/529
* feat(config): CFG.c — surfaces.yaml binding layer (closes #523, EPIC CFG complete) by @mellanon in https://github.com/the-metafactory/cortex/pull/532
* docs(context): ground the IoAW decisions + OSI layer-discipline principle in CONTEXT.md by @mellanon in https://github.com/the-metafactory/cortex/pull/533
* fix(lint): clear 3 eslint errors in surfaces.ts (unblock the Lint gate on main) by @mellanon in https://github.com/the-metafactory/cortex/pull/534
* feat(gateway): GW.a.1 — pure demux binding resolver + tests (#524) by @mellanon in https://github.com/the-metafactory/cortex/pull/536
* feat(mc): G-1113.A.1 — grounding: build-path fix + cockpit docs + glossary + banners by @mellanon in https://github.com/the-metafactory/cortex/pull/530
* feat(mc): G-1113.B.1 — Provider enum + SourceRef shape (types only) by @mellanon in https://github.com/the-metafactory/cortex/pull/544
* feat(mc): G-1113.B.2 — normalized SourceRef on task DTO via github shim by @mellanon in https://github.com/the-metafactory/cortex/pull/545
* feat(gateway): GW.a.2 — SurfaceGateway inbound orchestrator (shadow) (#524) by @mellanon in https://github.com/the-metafactory/cortex/pull/546
* feat(mc): G-1113.B.3 — GitHub adapter boundary + SourceRef emitter by @mellanon in https://github.com/the-metafactory/cortex/pull/547
* feat(gateway): GW.a.3a — BusInboundSink (live-path sink, publisher-injected) (#524) by @mellanon in https://github.com/the-metafactory/cortex/pull/548
* feat(mc): G-1113.B.4 — provider badge on task rows + Sources view by @mellanon in https://github.com/the-metafactory/cortex/pull/549
* feat(mc): G-1113.B.5 — isSourceRef validator + adapter parity fixtures by @mellanon in https://github.com/the-metafactory/cortex/pull/550
* docs(gateway): GW.a.3b live-wiring plan (for review) (#524) by @mellanon in https://github.com/the-metafactory/cortex/pull/551
* feat(mc): G-1113.C.1 — GitRepository + GitBranch types + storage by @mellanon in https://github.com/the-metafactory/cortex/pull/561
* feat(mc): G-1113.C.2 — GitCommit + GitTag types + storage by @mellanon in https://github.com/the-metafactory/cortex/pull/565
* fix(provision): refuse to wire signing identity without stack.id (closes #563) by @mellanon in https://github.com/the-metafactory/cortex/pull/566
* feat(mc): G-1113.C.3 — PullRequest + Review types + storage by @mellanon in https://github.com/the-metafactory/cortex/pull/567
* feat(cli): cortex normalize-config — one-time v3→v4 vocab key rename (closes #564) by @mellanon in https://github.com/the-metafactory/cortex/pull/568
* feat(mc): G-1113.C.4 — Check/Build + Deployment + Artifact + Release + storage by @mellanon in https://github.com/the-metafactory/cortex/pull/569
* feat(gateway): GW.a.3b.1 — flag-gated bootstrap factory (#524) by @mellanon in https://github.com/the-metafactory/cortex/pull/570
* feat(config): expose validated Surfaces on LoadedConfig (#524, GW.a.3b.2a) by @mellanon in https://github.com/the-metafactory/cortex/pull/573
* feat(mc): G-1113.C.5 — GitHub adapter ingestion (repo + PR + branches + commit) by @mellanon in https://github.com/the-metafactory/cortex/pull/572
* feat(mc): G-1113.C.6 — PR + branch chips on task rows by @mellanon in https://github.com/the-metafactory/cortex/pull/574
* feat(gateway): GW.a.3b.2b — dormant flag-gated cortex.ts boot wiring (#524) by @mellanon in https://github.com/the-metafactory/cortex/pull/575
* feat(mc): G-1113.C.7 — per-repository panel (software mode) by @mellanon in https://github.com/the-metafactory/cortex/pull/576
* feat(mc): G-1113.D.1 — Plan + PlanPhase types + storage by @mellanon in https://github.com/the-metafactory/cortex/pull/584
* feat(mc): G-1113.D.2 — plan ingestion from repo-local plan docs by @mellanon in https://github.com/the-metafactory/cortex/pull/585
* feat(mc): G-1113.D.3 — Plan overview surface (design §7.1) by @mellanon in https://github.com/the-metafactory/cortex/pull/586
* feat(gateway): GW.a.3b.2c — suppress per-stack adapter for gateway-owned surfaces (#524) by @mellanon in https://github.com/the-metafactory/cortex/pull/589
* feat(mc): G-1113.D.4 — WorkItem model + phase-detail surface (design §6/§7.2) by @mellanon in https://github.com/the-metafactory/cortex/pull/588
* docs(plan): G-1113 §5.4 — add D.5b + D.7, provider-neutral ingestion + legacy migration by @mellanon in https://github.com/the-metafactory/cortex/pull/591
* feat(mc): G-1113.D.5b — provider-neutral WorkItem ingestion (GitHub first adapter) by @mellanon in https://github.com/the-metafactory/cortex/pull/592
* feat(mc): G-1113.D.5 — work-item detail surface (design §7.3) by @mellanon in https://github.com/the-metafactory/cortex/pull/593
* feat(gateway): GW.a.3b.2d — attachInboundDispatch wiring + inbound observability (#524) by @mellanon in https://github.com/the-metafactory/cortex/pull/594
* feat(mc): G-1113.D.6 — legacy iteration kanban behind a tab toggle by @mellanon in https://github.com/the-metafactory/cortex/pull/595
* feat(gateway): GW BusInboundSink flip — live publish behind a 2nd opt-in flag (#524) by @mellanon in https://github.com/the-metafactory/cortex/pull/597
* feat(mc): G-1113.D.7a — iterations read-boundary onto provider-neutral SourceRef by @mellanon in https://github.com/the-metafactory/cortex/pull/601
* feat(mc): G-1113.D.7b — iteration-import GitHub parsers behind the adapter boundary by @mellanon in https://github.com/the-metafactory/cortex/pull/602
* feat(mc): G-1113.D.7c — relax tasks.source_system CHECK to provider-neutral storage by @mellanon in https://github.com/the-metafactory/cortex/pull/603
* feat(mc): G-1113.E.1 — AttentionItem type + storage + lifecycle (design §6/§7.4) by @mellanon in https://github.com/the-metafactory/cortex/pull/609
* feat(mc): G-1113.E.2 — attention producers (reconciler over DB state) by @mellanon in https://github.com/the-metafactory/cortex/pull/610
* feat(mc): G-1113.E.3 — attention queue UI surface (design §7.4) by @mellanon in https://github.com/the-metafactory/cortex/pull/611
* feat(mc): G-1113.E.4 — attention notification routing (system.attention.* envelopes) by @mellanon in https://github.com/the-metafactory/cortex/pull/612
* feat(mc): ML.1 — plan→umbrella linkage (parse umbrellaWorkItemId from plan docs) by @mellanon in https://github.com/the-metafactory/cortex/pull/619
* feat(mc): ML.2 — cockpit refresh orchestrator (ingestion + reconcile trigger) by @mellanon in https://github.com/the-metafactory/cortex/pull/620
* feat(mc): ML.3 — publish attention notifications (system.attention.* onto the bus) by @mellanon in https://github.com/the-metafactory/cortex/pull/621
* feat(mc): ML.4 — Discord render branch for system.attention.* by @mellanon in https://github.com/the-metafactory/cortex/pull/623
* feat(cortex): ML.5 — bot-side cockpit refresh loop (closes #622) by @mellanon in https://github.com/the-metafactory/cortex/pull/624
* feat(gateway): GW.a.3d — outbound reply round-trip (reuse createDispatchSink over gateway adapters) by @mellanon in https://github.com/the-metafactory/cortex/pull/613
* chore: bump to v4.1.0 by @mellanon in https://github.com/the-metafactory/cortex/pull/626


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v4.0.0...v4.1.0

---

### v4.0.0 — v4.0.0 — operator→principal vocabulary migration (BREAKING)  ·  2026-06-01

## BREAKING — operator→principal vocabulary migration complete

The cortex#436 vocabulary migration lands as v4.0.0. **Legacy `operator:` / cloud `operatorId` / federated-peer `operator_id`/`operator_pubkey` config keys are no longer accepted** — run `cortex migrate-config <your-config.yaml>` to convert. `home_operator`→`home_principal` (#515).

**Wire (lockstep with pilot + myelin f5ec865):** dropped `target_principal` (→`target_assistant`) + signed_by stamp `.principal` (→`.identity`). `originator.principal` + `broadcast` still tolerated (later cut).

**Gate:** the vocab carve-out gate now has camelCase recall + runs whole-tree — `operatorId` is fully ratcheted.

---
_Auto-generated changelog below._
## What's Changed
* ci(c-436): vocab carve-out gate — the missing migration ratchet (diff-mode) by @mellanon in https://github.com/the-metafactory/cortex/pull/512
* docs(context): add NSC operator glossary term — disambiguate from principal by @mellanon in https://github.com/the-metafactory/cortex/pull/511
* docs(ioaw): refresh design+plan to CONTEXT.md vocab + add config-split & shared-gateway epics by @mellanon in https://github.com/the-metafactory/cortex/pull/510
* docs(design): event-driven review loop — reactor below the surface, no blocking wait by @mellanon in https://github.com/the-metafactory/cortex/pull/509
* docs(context): define Mission Control authorization role — disambiguate from principal by @mellanon in https://github.com/the-metafactory/cortex/pull/513
* fix(vocab): C-436 — semantically-audited operator→principal sweep (prose + symbols) by @mellanon in https://github.com/the-metafactory/cortex/pull/514
* feat(cortex): PR-R2.J (policy-half) — home_operator → home_principal — rebased supersede of #464 by @mellanon in https://github.com/the-metafactory/cortex/pull/515
* feat(vocab): R2.D — operator_requeue→principal_requeue + session operatorId→principalId (+ prose) by @mellanon in https://github.com/the-metafactory/cortex/pull/516
* feat(vocab): R2.I — cloud-network operatorId→principalId (accept-both transition) by @mellanon in https://github.com/the-metafactory/cortex/pull/518
* feat(vocab): R2.G — registry client + federated-peer config operator→principal by @mellanon in https://github.com/the-metafactory/cortex/pull/519
* feat!: v4.0.0 — vocab migration breaking cut + fully-ratcheted gate (closes R2 #436) by @mellanon in https://github.com/the-metafactory/cortex/pull/520
* ci(gate): flip vocab gate diff-mode → whole-tree (R2 complete) by @mellanon in https://github.com/the-metafactory/cortex/pull/521
* feat(bus)!: re-pin myelin f5ec865 — drop R10/R11 wire shims (LOCKSTEP w/ pilot) by @mellanon in https://github.com/the-metafactory/cortex/pull/522


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v3.1.0...v4.0.0

---

### v3.1.0 — v3.1.0 — Bot-to-bot review reply loop + Discord stability  ·  2026-05-29

First release of the **platform-neutral bot-to-bot review reply loop** plus Discord-connection hardening.

### Features
- **Review reply loop** (#498, #503, #504, #505): a review request carries a *logical* `response_routing` (`{surface, channel, thread}`); Echo's verdict + lifecycle render back to the originating thread, **authored by the reviewer**, with a **deterministic `presentation`** (zero-LLM formatting) — never raw JSON on a surface.
- **Echo posts full reviews to GitHub** via dispatch-**intent** (not method) (#507) — cortex pings the intent; the reviewer owns the how.
- **dispatch-stage tracing** `CORTEX_TRACE_DISPATCH` (#495).

### Fixes
- **Discord WS flapping** → force the `ws` package on Bun (#500).
- **Double-delivery**: `nats.subjects:[]` + runtime idempotent-subscribe (#493, #504).
- **No hard-fail** on a missing verdict block → prose-fallback; pilot resolves `commented` (#504).
- Bogus resume-session for chat dispatch (#497).
- `operator → principal` example sweep (#499); per-agent `nkey_pub` example for NKey-verified bot↔bot dispatch (#506).

### Known follow-up
- The structured bus **verdict block** (cortex#237) for fully-autonomous approve/changes-requested merge-gating isn't yet emitted by Echo's dispatched session — human-review-on-GitHub works; hands-off auto-merge is the next step.

Install/upgrade: `arc upgrade Cortex`.

---

### v3.0.3 — v3.0.3 -- Review-consumer ack_wait fix (no duplicate posts)  ·  2026-05-26

## What's Changed
* feat(dispatch): default chat to canonical task envelopes by @mellanon in https://github.com/the-metafactory/cortex/pull/421
* fix(bus): set review-consumer ack_wait above review wall-time (closes #422) by @jcfischer in https://github.com/the-metafactory/cortex/pull/424


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v3.0.2...v3.0.3

---

### v3.0.2 — v3.0.2 -- Sage verdict exit-code mapping + --post propagation  ·  2026-05-26

**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v3.0.1...v3.0.2

---

### v3.0.1 — v3.0.1 -- Sage review bus fix (pr_url + myelin 9fc8476)  ·  2026-05-26

## What's Changed
* fix(cortex): wire config.claude into review-consumer sessionOpts by @jcfischer in https://github.com/the-metafactory/cortex/pull/400
* feat(runner): SAGE_SUBSTRATE env override for pi-dev runner by @jcfischer in https://github.com/the-metafactory/cortex/pull/402
* docs(cortex): C-405 OSI corrections + Scenario 4 + Scenario 5 + IoAW linkage by @mellanon in https://github.com/the-metafactory/cortex/pull/414
* docs(cortex): C-405 Direction A implementation plan (re-grounded) by @mellanon in https://github.com/the-metafactory/cortex/pull/418
* feat(runner): add AgentTeamHarness for delegate dispatch by @mellanon in https://github.com/the-metafactory/cortex/pull/419
* feat(dispatch): Direction A Stage 4-A — canonical envelope publish for chat/direct (cortex#409) by @mellanon in https://github.com/the-metafactory/cortex/pull/420


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v3.0.0...v3.0.1

---

### v3.0.0 — v3.0.0 -- Vocabulary migration BREAKING  ·  2026-05-21

## What's Changed
* feat(runner): consume myelin#161 originator field (closes #346) — v2.0.6 by @mellanon in https://github.com/the-metafactory/cortex/pull/358
* feat(bus): chat-path CC failure retry (closes #360) — v2.0.7 by @mellanon in https://github.com/the-metafactory/cortex/pull/362
* feat(bus): agent heartbeat envelopes for in-flight liveness (closes #361) — v2.0.8 by @mellanon in https://github.com/the-metafactory/cortex/pull/363
* fix(security): restore originator signature coverage — stale myelin install (closes #366) — v2.0.9 by @mellanon in https://github.com/the-metafactory/cortex/pull/371
* chore(deps): bump @metafactory/content-filter to layered scanner — v2.0.10 by @mellanon in https://github.com/the-metafactory/cortex/pull/379
* docs: cortex CONTEXT.md glossary + bus-addressing model by @mellanon in https://github.com/the-metafactory/cortex/pull/381
* fix(runner): surface bash-guard blocks via structured deny + telemetry by @mellanon in https://github.com/the-metafactory/cortex/pull/380
* fix(tests): clean up persona dirs leaked into $HOME + clear pre-existing TS errors by @jcfischer in https://github.com/the-metafactory/cortex/pull/382
* fix(ci): add bun test + tsc gates; CI-safe the 7 claude-binary tests by @jcfischer in https://github.com/the-metafactory/cortex/pull/385
* fix(bus): parseReviewRequestPayload accepts Pilot/Sage payload shape by @jcfischer in https://github.com/the-metafactory/cortex/pull/387
* docs(migration): cortex vocabulary migration manifest 0001 — operator→principal + cascade plan by @jcfischer in https://github.com/the-metafactory/cortex/pull/389
* feat(mc): C2 PR-5 — operator→principal in dashboard UI copy (R8) by @mellanon in https://github.com/the-metafactory/cortex/pull/390
* feat(config): C2 PR-1+2 — operator→principal config schema + migrate-config (R1+R3) by @mellanon in https://github.com/the-metafactory/cortex/pull/391
* feat(mc): C2 PR-6 — operatorId→principalId in Mission Control REST + server (R2) by @mellanon in https://github.com/the-metafactory/cortex/pull/392
* feat(cortex): C2 PR-3/4/7 — env-var shim + persona prose + bot→agent service (R9+R6+R7) by @mellanon in https://github.com/the-metafactory/cortex/pull/394
* feat(cortex): C-388 PR-8 — consume new myelin envelope wire fields (R10+R11) by @jcfischer in https://github.com/the-metafactory/cortex/pull/396
* feat(cortex): C-388 PR-9 — Broadcast → Offer cascade (R5) by @jcfischer in https://github.com/the-metafactory/cortex/pull/397
* feat(cortex): C-388 PR-10 — {org} → {principal} subject derivation (R4) by @jcfischer in https://github.com/the-metafactory/cortex/pull/398
* feat(cortex): C-388 PR-11 + PR-12 — v3.0.0 BREAKING release (vocabulary migration cutover) by @jcfischer in https://github.com/the-metafactory/cortex/pull/399


**Full Changelog**: https://github.com/the-metafactory/cortex/compare/v2.0.5...v3.0.0

---

