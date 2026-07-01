# E2E admission lifecycle guard (C-1355)

A scripted **register → admit → seal → join → revoke → leave** walkthrough that
drives the REAL CLI code paths against a **local in-process registry** and
**temp-dir config trees** — no Cloudflare, no D1, no NATS server, no network I/O.

Every mid-funnel breakage in the admission epic (#832, #1262, #1220, #1316,
#1317) was found by a HUMAN walking the SOP, usually an external first-time
principal. Nothing in CI exercised the lifecycle **as a sequence**, so each fix
could regress silently. This suite is that guard, and the epic's **progress
meter**: steps gated on unmerged sub-issues are `test.todo(...)` named with their
issue number; each fix PR flips its todo to live.

## Files

| File | What it is |
|------|------------|
| `lifecycle.test.ts` | The scripted walkthrough (steps 1–9), driven as an ordered, shared-state sequence. |
| `harness.ts` | In-process registry + `globalThis.fetch` router, temp-dir helpers, the recording hub-reload stub, and the `leaveNetwork` ports builder (daemon-restart stub). |
| `README.md` | This file. |

## How to run

```bash
# scoped (dev)
bun test src/cli/cortex/commands/__tests__/e2e-lifecycle/

# the full suite runs it too (CI)
bun test src/
```

Type-check: `bunx tsc --noEmit` (clean).

## What is REAL vs STUBBED

| Concern | Treatment |
|---|---|
| Network registry (`src/services/network-registry`) | **REAL** — the Hono `app` + in-memory store, driven via a `globalThis.fetch` router that forwards `http://127.0.0.1:18771/*` into `app.fetch(req, env)`. Any fetch to a non-registry URL **throws** (the suite must never touch the network). |
| `stack create` / `network create` / `provision-stack register` / `network admit` | **REAL** — the exported dispatch functions (`dispatchStack`/`dispatchNetwork`/`dispatchProvisionStack`), same argv the binary runs. |
| `network secret add-member / revoke-member` | **REAL** `runNetworkSecret` orchestrator + real Ed25519 seeds + real `crypto_box` seal + real registry delivery/admission ports. |
| `network leave` | **REAL** `leaveNetwork` orchestrator over an in-memory `ConfigStorePort`. |
| Boot config validator (`#1220`) | **REAL** — `CortexConfigSchema` (the same full validation the daemon runs at boot) applied to the join derivation's output. |
| **Hub reload** (`network-secret-adapters.ts:87-107`) | **STUBBED** — `makeRecordingHubPort` keeps the hub config in memory and counts reloads instead of SIGHUP-ing a live nats-server. This is the seam **#1317** will make target the real multi-nats hub. |
| **Daemon restart** (`DaemonPort.restart`) | **STUBBED** — the `leaveNetwork` ports builder records restart requests instead of `launchctl kickstart`. |
| Real NATS server / Cloudflare / D1 / any network I/O | **NEVER**. |

### Authority collapse (Q5)

The guard uses ONE admin identity for the network-admin, hub-admin, and
registry-admin roles (the Q5 "one principal is both authorities" collapse). The
registry's hub-admin write gate falls back to `REGISTRY_ADMIN_PUBKEYS` when
`REGISTRY_HUB_ADMIN_PUBKEYS` is unset, so a single seed drives create + admit +
seal + revoke. A fully-separable deployment (distinct network-admin vs hub-admin)
is a separate concern already unit-tested at the registry layer.

## The two regression anchors (HARD assertions)

- **#1262** — a registered principal MUST leave a **PENDING admission row**. The
  bug was a registered principal with **no** row (the register hook swallowed the
  upsert failure), so the admin saw nothing to admit. Pinned in **step 3**:
  after `provision-stack register --network testnet`, the in-memory issuance
  store has exactly one PENDING row for the member.
- **#1220** — `network join` wrote a **peer-scoped** `accept_subjects` entry
  (`federated.andreas.meta-factory.agent.>`) into `jc/default`, which the boot
  config validator rejects (accept_subjects must begin with the receiving stack's
  OWN `federated.{me}.{stack}.` scope), failing daemon boot. Pinned in **step 6**:
  the join derivation's peer subtree is fed through the REAL `CortexConfigSchema`
  and asserted to be rejected with an `accept_subjects` error, while the own-only
  (zero-peer) derivation is asserted to PASS.

## Step ↔ status map

| Step | Coverage | Status |
|---|---|---|
| 1. Stand up (stack create ×2) | born-aligned, no drift | **LIVE** |
| 2. Network create | NetworkRecord row incl. `admin_pubkeys` | **LIVE** |
| 3. Register | PENDING admission row EXISTS (**#1262**) | **LIVE** |
| 3b. Register output surfaces request-id | `#1315` | `test.todo` |
| 4. Admit | row ADMITTED | **LIVE** |
| 4a. `admit --list-pending` | `#1314` | `test.todo` |
| 4b. `network reject` verb | `#1348` | `test.todo` |
| 5. Seal (`secret add-member`, hub stubbed) | sealed blob on the row | **LIVE** |
| 5a. `admit --and-seal` fold | `#1316` | `test.todo` |
| 6. Join accept_subjects vs boot validator (**#1220**) | own-only PASS + peer REJECTED | **LIVE** |
| 6b. Full join output passes config load (post-fix) | `#1220` fix | `test.todo` |
| 7. Revoke (`secret revoke-member`) | REVOKED + blob cleared + hub user dropped | **LIVE** |
| 8. Leave (`leaveNetwork`, daemon stubbed) | config cleaned + leaf torn down + daemon restarted | **LIVE** |
| 9a. Idempotence — re-run leave | clean no-op (not-joined) | **LIVE** |
| 9b. Idempotence — re-run revoke | clean no-op (nothing to revoke) | **LIVE** |

## How to flip a `test.todo` to live

1. Land the sibling fix (e.g. `#1314` adds `network admit --list-pending`).
2. In `lifecycle.test.ts`, find the `todo("step … (#NNNN): …")` line for that
   issue and replace it with a real `test("…", async () => { … })` that drives
   the new verb and asserts against the in-process registry store (the harness
   already exposes `getStore` / `getIssuanceStore` on `ctx.env`).
3. For **#1220** specifically: once the join **writer** emits only own-scoped
   subjects, flip step 6b to live (the full join output — own ∪ peers — passes
   `CortexConfigSchema`) and update the step-6 HARD assertion, which currently
   documents the *pre-fix* rejection.

## Notes for a reviewer

- The suite is an **ordered, shared-state** walkthrough (a break mid-funnel
  fails loudly and cascades — that is the intent of a lifecycle guard, not a
  smell). `ctx` threads the request-id, secret ports, and leave handle across
  steps.
- `test.todo("name")` is the correct single-arg runtime form (bun reports these
  as todo); the `todo` cast near the top of `lifecycle.test.ts` only exists to
  keep `tsc --noEmit` happy with the bundled bun-types signature.
- `LIVE_NATS=1` real-server variant (spawning nats-servers to exercise the hub
  reload + daemon restart for real) is intentionally **out of scope** here and a
  future opt-in — do not block on it.
