**Status: Draft — for principal review**

**Refs:** cortex#2264/#2265 (quickstart-hang diagnosis — ad-hoc multipass Linux bench) · cortex#2269 (container volume-perms EACCES — ad-hoc OrbStack docker repro) · arc `design/linux-host-support.md` (arc#309 — the L1–L4 host-class taxonomy this mirrors) · `deploy/compose/` (Dockerfile.cortex + docker-compose.yaml, the L4 target) · `src/cli/cortex/commands/quickstart.ts` (the native-host target) · `docs/adr/0003-network-join-control-plane.md` (federation provision/join/make-live) · compass `sops/design-process.md`.

> **Provenance.** This session ran two throwaway benches — a multipass Ubuntu VM to reproduce a tester's `cortex quickstart` 60s hang (→ 6.10.2 fixes), and an OrbStack docker repro to reproduce + validate a container-boot EACCES (→ #2269). Two substrates, chosen per-problem, nothing checked in — the next session (or the tester) can't reproduce either. Principal directive (2026-07-20): **standardize this**. This spec is the standard.

---

## 1. The problem — cortex testing is ad-hoc and unreproducible

cortex's hardest bugs are **host-environment** bugs: they don't reproduce on the developer's macOS native tree, only on a real Linux host (systemd user services, XDG paths), inside a container (non-root user + named-volume ownership), or across peered stacks (federation creds/leaf nodes). The unit/command/e2e suites (`bun test`) run in-process and by design never exercise these. So every host bug this session was diagnosed on a **hand-built, throwaway bench**:

- The quickstart hang → a manually-launched multipass Ubuntu VM, hand-scripted `/private/tmp/cortex-natsrepro/*.sh`.
- The container EACCES → a hand-written minimal Dockerfile run through OrbStack docker.

Both worked, both are gone. The cost: (1) each host bug pays full bench-setup latency again; (2) results aren't reproducible by the principal or a community tester; (3) there's no regression guard — a re-introduced volume-perms or gate bug wouldn't be caught until a tester hits it. The fix is a **standard, checked-in, scriptable bench** with a documented SOP.

## 2. Design decision — tiered substrate (DD-TB1)

**DD-TB1 (principal decision, 2026-07-20): the standard test substrate is tiered.**
- **multipass Ubuntu VMs are canonical** for native-host, federation, and high-fidelity container runs. arm64-native, scriptable (`multipass launch/exec/transfer`), agent-drivable, and closest to a tester's real Linux host.
- **OrbStack local docker is the fast path** for container-mechanism checks (image build + volume/entrypoint behavior) where a full VM is overkill. Same Linux named-volume ownership semantics (VM-backed), seconds not minutes.

Rule of escalation: **default to the fast path; escalate to a VM when fidelity matters** (anything touching systemd, the real bus over the network, or two hosts). The bench records which tier a scenario ran on so a result is never ambiguous about its fidelity.

## 3. Test classes → substrate map

| Class | What only reproduces here | Substrate (DD-TB1) | Example bug |
|---|---|---|---|
| **Native Linux host** | systemd user units, XDG state paths, the healthy-boot gate on real logs | 1 multipass VM | quickstart 60s hang (6.10.2) |
| **L4 container / compose** | non-root user + named-volume ownership, entrypoint, Dockerfile assembly | OrbStack (fast) or docker-in-VM (fidelity) | volume-perms EACCES (#2269) |
| **Federation** | 2+ peered stacks, NATS leaf nodes, cross-stack creds (`.creds` vs `.nk`) | 2 multipass VMs | (untested today — the gap this closes) |

## 4. Harness design

A checked-in `deploy/test/` tree in cortex:

```
deploy/test/
  bench.sh                 # single entrypoint: up / down / status / logs
  scenarios/
    native-quickstart.sh   # 1 VM: cortex quickstart → assert healthy-boot gate
    container-compose.sh    # docker: compose up --build → assert boots past runNatsConf + gate
    federation-2stack.sh    # 2 VMs: provision → join → make-live → assert cross-stack dispatch
  lib/
    multipass.sh           # launch/exec/transfer/teardown helpers (idempotent, named)
    docker.sh              # build/up/down helpers; tier detection (OrbStack vs docker-in-VM)
    assert.sh              # tiny assertion helpers (grep-a-log, expect-owner, expect-exit)
  fixtures/
    .env.example           # placeholders only — <REPLACE_ME> for every secret/token
  README.md                # quickstart for the bench itself
```

**`bench.sh` interface (the whole contract):**

```
bench.sh up   <scenario> [--tier fast|vm] [--keep]   # provision + run; --keep leaves it up for poking
bench.sh down <scenario>                             # tear down VMs/volumes/images for that scenario
bench.sh status                                      # what's up right now (VMs, containers, volumes)
bench.sh logs <scenario>                             # tail the run's captured logs
```

**Principles:**
- **DD-TB2 — idempotent + named.** Every VM/volume/image is named per-scenario (`cortex-bench-<scenario>`), so `up` is re-runnable and `down` is exact. No orphan sprawl (the thing this session accumulated).
- **DD-TB3 — no secrets in the tree.** `fixtures/.env.example` carries `<REPLACE_ME>` placeholders only; the runner reads real values from the operator's `~/.config/` (never committed), matching the repo's data-classification rule. A scenario that needs a real token asserts only up to the point the token is required, unless the operator supplies one.
- **DD-TB4 — assert, don't eyeball.** Each scenario ends in machine-checked assertions (gate line present, volume `_data` owned by uid 1000, no `EACCES`), exit-coded, so scenarios double as regression guards and can later run in the Linux CI lane (arc#309 L-CI).
- **DD-TB5 — self-documenting fidelity.** Output states the tier used and what that does/doesn't prove (e.g. "OrbStack fast tier: proves volume-ownership mechanism; does NOT exercise systemd").

## 5. Scenarios

### 5.1 `native-quickstart` (1 multipass VM)
Stand up an Ubuntu VM, install bun + nats-server, clone cortex at a ref, run `cortex quickstart` for a fresh single stack. **Assert:** the 5 healthy-boot gate lines appear in `.log`, `healthz` OK, no 60s silent timeout, `.error.log` empty of bus-connect failure. Guards the 6.10.2 class (credsPath/gate).

### 5.2 `container-compose` (OrbStack fast / docker-in-VM fidelity)
From `deploy/compose/` with a fixtures `.env`, `docker compose down -v && docker compose up -d --build` at a pinned ref. **Assert:** boots past `runNatsConf` (no `EACCES`), the three named volumes' `_data` are owned by uid 1000, gate reached, `connected to nats` present. Guards #2269 + the Dockerfile assembly (arc install adapters, #2156/#2243 class).

### 5.3 `federation-2stack` (2 multipass VMs)
Two VMs, each a cortex stack; peer them via `cortex network provision` → `join` → `make-live` (ADR-0003). **Assert:** the leaf link establishes, `<slug>.creds` is minted + loaded (the path we've only ever reasoned about), a dispatch on stack A is observable on stack B. This is the **federation bench** the principal asked for — first real exercise of the federation creds/leaf path.

## 6. SOP

A companion `compass/sops/cortex-test-bench.md`: when to reach for the bench, the tier-escalation rule (DD-TB1), the `bench.sh` commands, how to supply secrets from `~/.config/`, and how to read a result's fidelity. Makes the bench the canonical path — not re-derived per session. (compass PR, separate from the cortex harness PR.)

## 7. Out of scope / non-goals
- **Not** a replacement for `bun test` — the bench is for host-environment behavior the in-process suites can't reach.
- **No** cloud substrate in v1 (AWS was considered; local tiered substrate chosen). The `lib/` seam leaves room to add an `aws.sh` backend later without touching scenarios.
- **No** always-on infrastructure — benches are ephemeral, `up`/`down` on demand.
- **Windows/macOS-container** hosts out of scope (Linux is the deployment target; DD-L4).

## 8. Open questions (for principal review)
1. **Home for the harness:** `deploy/test/` (proposed, sits with the compose target) vs `test/bench/` (sits with the suites). Recommendation: `deploy/test/` — it's host/deploy testing, not unit testing.
2. **CI wiring:** should `container-compose` (and later `native-quickstart`) run in the arc#309 Linux CI lane as a merge gate, or stay operator-run-only for v1? Recommendation: land operator-run first, wire the container scenario into CI as a fast follow (it's the cheapest and highest-value guard).
3. **Federation depth for v1:** minimal 2-stack link + one cross-stack dispatch assertion (proposed), or the fuller admission/identity-binding path too? Recommendation: minimal link + dispatch for v1; deepen once it's real.

## 9. Delivery
Per compass `design-process.md` lineage: this spec → one cortex feature issue (prefix `C-`) with sub-slices — (a) `bench.sh` + `lib/` scaffolding, (b) `container-compose` scenario (validates against #2269, highest immediate value), (c) `native-quickstart` scenario, (d) `federation-2stack` scenario, (e) compass SOP. Build begins after principal sign-off on this doc.
