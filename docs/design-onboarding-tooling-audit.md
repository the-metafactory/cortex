# Design — Onboarding & federation control-plane: tooling audit + simplification

**Status:** audit (2026-06-18) · **Author:** Luna (for Andreas) · **Drives:** the future onboarding-agent work

## Why this exists

Standing up stacks, creating networks, and joining them are now mostly one-command
operations. But onboarding a **new peer principal onto an existing network** still
*feels* complex — and it is: it spans **6 SOPs and ~15 human steps**, with sharp
manual edges (most acutely, the NSC account-topology surgery to make `federated.>`
actually cross a hub's account boundary — done by hand today). This doc audits the
end-to-end lifecycle use-case by use-case, locates where the complexity actually
lives, and names the tooling gaps to close so onboarding becomes genuinely simple.
It is the substrate the dedicated **onboarding-agent** session should build on —
the agent is only as good as the primitives beneath it, so the primitives come first.

Grounded in a read-only survey of `src/cli/cortex/commands/network*.ts`,
`src/services/network-registry/`, `src/common/nats/leaf-remote-renderer.ts`,
`src/common/config/loader.ts`, the `docs/sop-*` set, and the compass SOPs
(2026-06-18). Where a claim needed verifying it was checked against the code, not
asserted.

## Use-case audit

| Use case | Tooling today | Manual / sharp edges | Verdict |
|---|---|---|---|
| **Stand up a new stack** (local-only) | `cortex stack create` — born-aligned scaffold, config-split template, seed path | NATS bus `.conf` + plist **hand-written**; `nkey_pub` write-back in **3 sites** post-boot; first `launchctl load`; 4 Discord secrets | Mostly tooled; bus + `nkey_pub` are the gaps |
| **Create a new network** (admin) | `cortex network create` — signed-admin, dry-run default | one-time `wrangler secret put REGISTRY_ADMIN_PUBKEYS` + deploy | One-time; acceptable |
| **Join a network** (your own stack) | `cortex network join` — **O-3 (2026-06) auto-converts** the bus to operator-mode, renders leaf, writes policy, restarts | leaf `.creds` must pre-exist; `announce_capabilities` pre-filled | Strong. **Doc lag:** the SOPs still describe bus conversion as a manual step the O-3 code now does |
| **Join — 2nd+ stack** | same + `--principal-seed <root>` | flag-only, no config field | Minor friction |
| **Onboard a NEW peer principal** | partial: `provision-stack register` + the O-4a register→PENDING→grant→serve broker | **leaf-creds handoff (two-party)**, **leafnode topology + reachability (two-party)**, **federated account export/import (manual NSC)**, registry pin, `accept_subjects` | **The hard one — ~15 steps, 6 SOPs** |
| **Issue leaf creds** (hub side) | `cortex creds issue` → `arc nats add-bot` (local hub only) | admin-grant is a **raw signed HTTP call** (no CLI wrapper); cross-account material manual | Half-tooled |
| **Version / release / deploy** | `arc-manifest.yaml` + `arc upgrade Cortex` | **4 independent deploy surfaces** (bot via arc; dashboard, MC API worker, registry via 3× wrangler), nothing orchestrates them | Fragmented |

## Where the complexity actually lives — ranked

1. **Federated account-topology — zero tooling (the linchpin).** For `federated.>` to
   cross account/operator boundaries on a hub, someone runs `nsc add export` on the
   leaf-bound account + `nsc add import` on the destination account (or co-locates
   both in one operator universe by hand-copying `resolver_preload`). **Verified: neither
   `cortex` nor `arc` tools this** — it is pure manual `nsc` surgery. This is the edge
   that just cost real debugging time, and it's the least tooled.
2. **Leaf-creds issuance + delivery (two-party, gating).** O-4a built the *broker*
   (register→PENDING→grant→serve of the **public** leaf package), but the admin-side
   **grant is an unwrapped HTTP+sign call**, and the secret `.creds` delivery is
   out-of-band by design.
3. **Leafnode topology + reachability (two-party).** Who hosts the hub + NAT traversal
   (cloudflared / VPS / Tailscale) — an architectural agreement with no tooling and no
   single checklist.
4. **`nkey_pub` post-boot write-back in 3 sites** (`stack.nkey_pub`,
   `policy.principals[].nkey_pub`, `agents[].nkey_pub`) — miss one → silent
   signature-verification failure.
5. **4-surface deploy with no orchestration** — a bot-only `arc upgrade` leaves a stale
   dashboard / MC API / registry; nothing sequences or version-checks them together.
6. **Doc fragmentation** — 6 overlapping SOPs (one superseded-but-retained), no single
   end-to-end "onboard a peer principal" path.

## The two irreducible steps

Two hotspots are **genuine two-party decisions** an agent can *orchestrate and prompt*
but not unilaterally perform:

- **Creds trust-handoff** — the hub admin must consciously admit a peer (the human-grant
  decision); the secret `.creds` crosses out-of-band.
- **Hub topology agreement** — both principals agree who hosts the leaf hub and how it's
  reachable across the internet.

Everything else below is closeable with tooling.

## Separation of concerns (the layer split this plan MUST honor)

Per the federation-wire-protocol SOP and `CLAUDE.md`:

- **Cortex (M7)** owns **identity addressing** (which principal / stack / assistant) and
  **control-plane orchestration** (the CLIs that *call* lower layers). It **never decides
  topology** and **consumes M2–M6, owning no part of M1–M6**.
- **arc** owns the **NSC account tree** (`nsc`, operator/account/user JWTs, the `$SYS`
  account, `resolver_preload`). cortex reaches it only *through* arc — the established
  precedent is `cortex creds issue → arc nats add-bot`.
- **myelin (M1–M3)** owns **topology & routing** (networks, leaf links, `selectLink`); the
  network is a topology fact resolved from `policy.federated.networks[].peers[]`, **never a
  value on the wire**.

Two distinct concerns the audit deliberately keeps apart (easy to conflate):

- **Account topology** (M1/M4 — arc/myelin transport): *does the leaf bridge the right NATS
  account so traffic can physically flow.* What G1 addresses — and **NOT cortex's to own**;
  it is arc's, orchestrated by cortex.
- **The `federated.` subject scope** (M3 — myelin grammar, governed by the wire-protocol
  5-check): envelope addressing. None of G1–G5 emit/route/consume `federated.*`
  **envelopes**, so the 5-check is not triggered by this tooling — but the onboarding-agent
  capstone, when it drives federated *dispatch*, MUST run it, and no G-item may put a network
  id on the wire or have cortex decide a route.

## Make it simple — the plan

Close the closeable gaps as named primitives, then let the onboarding agent orchestrate
on top:

- **G1 — account-topology tooling** *(highest leverage)*: the NSC export/import (or
  `resolver_preload` co-location) primitive that lets `federated.>` cross without hand-`nsc`.
  **Per the layer split above, this lives in `arc`** (the `nsc`/account-tree owner —
  precedent: `cortex creds issue → arc nats add-bot`); cortex's control plane *orchestrates*
  it (from `cortex network join` / the grant act) but **never runs `nsc` itself**.
- **G2 — `cortex creds grant <request-id>`**: wrap the admin-side issuance-request grant
  — sign the decision, issue creds via `arc`, assemble + post the public leaf package,
  and assign the `community-fleet` Discord role (the O-5 helper) — turning the human-grant
  into one command. This is the scripted grant-act the onboarding agent runs.
- **G3 — `nkey_pub` auto write-back**: the daemon self-registers its pubkey at boot, or
  `arc upgrade` patches all 3 sites — eliminate the silent-failure edge.
- **G4 — `cortex release`**: one orchestrator (or checklist command) over the 4 deploy
  surfaces with a version-skew guard.
- **G5 — SOP consolidation**: collapse the 6 SOPs into one end-to-end "onboard a peer
  principal" runbook, with the two irreducible two-party steps explicitly flagged as the
  only non-automatable moments.

**The onboarding agent (capstone, separate session)** then drives the consolidated flow,
runs the scripted hub-side grant-act (G1 + G2), and *escalates* only the two two-party
moments. It does not replace the tooling — G1–G5 are its building blocks.

## Sequencing

G1 and G2 are the high-leverage pair (they kill the two worst manual edges and are what
the agent most needs). G3/G4 are independent quality-of-life closers. G5 (consolidation)
is best done *after* G1/G2 land so the runbook documents the simplified flow, not the old
one. The agent capstone follows G1+G2+G5.
