# Design — Isolated stack hosting (Mode B: a stack on its own infrastructure)

**Status:** design / pre-ADR · **Sequencing:** PRE-release (rides the federation test-zone track) · **Date:** 2026-06-19 (split 2026-06-26) · **Companion:** `docs/design-distributed-agent-execution.md` (Mode A — the execution axis) · **Refs:** ADR-0013 (sovereign federation), `docs/design-g1-account-topology.md`, `docs/sop-onboard-peer-principal.md`, `docs/sop-network-join.md`

> **The hosting axis.** Where does the *head* (the cortex daemon) live? Today every stack sits on the principal's Mac. This doc covers running a **complete cortex stack on its own infrastructure** — its own identity, lifecycle, and management, independent of the Mac — federating back over the bus. This is distinct from *execution* (where hands run, Mode A) and connects directly to the **pre-release federation / multi-principal test zone**: an isolated stack off the Mac is the building block of a realistic federation test that doesn't depend on a live external peer.

## 1. Mode B — Isolated self-hosted stack (relocate the head)

The **entire daemon** runs on separate infrastructure — its own identity, bus participation, lifecycle, and management, independent of the Mac (Mac can be off).

- **Buys:** a genuinely sovereign peer stack; realistic federation testing without depending on a real external peer (e.g. JC); 24/7 stacks decoupled from the laptop; true multi-stack topologies with no single point.
- **Key insight:** Mode B does **not** require Managed Agents. It requires cortex to be a **portable, self-hosting, sovereign deployable unit** — which `arc install Cortex` + the config-split layout + ADR-0013 sovereign federation already mostly deliver. Substrate is a choice:
  - **CF Container (microVM)** — elegant (egress/credential proxies, managed provisioning), but CF-coupled.
  - **VPS / fly.io / dedicated box** — full control, no coupling. Likely the better first target for a stack you "manage on its own infrastructure."
- **Does CF host the *head* too?** CF's "full VM" is **Cloudflare Containers** (Linux microVMs). They *can* run a stack daemon, but their model is on-demand / Worker-fronted / scale-to-zero — which suits ephemeral *hands* (Mode A) far better than an always-on, identity-bearing *head* holding persistent NATS-leaf + Discord-gateway connections (those never go idle, fighting scale-to-zero + the per-instance duration model). For an always-on isolated head, a classic VM/VPS is the natural host. **The elegant shape is the hybrid: head on a VM (Mode B) + hands on CF (Mode A).** (Verify CF Containers' current always-on / duration limits before betting the head on them.)
- **What a Mode-B stack needs on its box:** Bun + (its own NATS or a leaf to a hub, run operator-mode) + config-split dir + its own NKey seed / NSC operator root + its bot tokens + its own `arc upgrade` / restart lifecycle.

## 2. The load-bearing decision: the hub must leave the Mac

Today the Mac almost certainly hosts the NATS hub. The instant a stack lives off-Mac **and must run when the Mac is off**, the hub has to leave the Mac too. Two shapes (ADR-0013 already frames this):

1. **Stable off-machine hub** — a small always-on box runs the hub; stacks (Mac + remote) leaf-connect to it. Simplest for a test zone.
2. **Fully sovereign per-stack principals** — each stack runs its own operator-mode NSC operator root and leaf-links peer-to-peer / to a network. The real sovereign model; more setup per stack.

This — not the compute substrate — is the architectural fork. Pick (1) for the first test zone; (2) is the production-sovereign end state.

## 3. Hosting: sizing + pricing (researched 2026-06)

**Size by execution backend — this is the load-bearing sizing decision:**

- **Head only (hands run `managed`/off-host, Mode A):** the cortex daemon is a light Bun process (bus client + adapters + orchestration), no local inference. **1–2 GB / 1 vCPU is plenty.** 2 GB is *not* slim here.
- **Head + `backend: local` (hands on the same box):** Claude Code itself needs **~4 GB minimum**, ~8 GB comfortable, **16 GB+** for parallel sub-agents — and carries documented **memory-leak** behaviour (RSS to 8–13 GB+, pathologically 100 GB+, over 30–60 min sessions). On a small box, 2 GB is unworkable for local execution; size at 8–16 GB+ with session-restart hygiene.
- **Ephemeral sandboxed hands (Mode A) sidestep the leak entirely** — one task, torn down, the long-session leak never accumulates. A further reason the hybrid (small always-on head + ephemeral CF hands) is the resilient shape, not just the cheap one.

**Always-on VM options for the head (lightweight, 1–2 GB):**

| Provider | ~Spec | ~Price/mo | Notes |
|---|---|---|---|
| **Hetzner** | CX23 (shared) → CPX22 2vCPU/4GB | ~€3.49 → €7.99 (Apr-2026) | best value; EU regions |
| **DigitalOcean** | 1 vCPU / 1 GB basic droplet | ~$4 | simple, global |
| **Fly.io** | shared-cpu-1x / 1 GB (256 MB ≈ $2) | ~$6.79 | per-second billing, easy deploy, scale-to-zero option |
| **CF Containers** | microVM | per-10ms-active CPU + provisioned mem | great for *hands* (Mode A); awkward/pricey for an always-on *head* |

A 3-stack federation **test zone** ≈ **$12–30/mo** (Hetzner/Fly), or near-zero with Fly's scale-to-zero for non-always-on test stacks.

## 4. Spike B1 (priority — the stated need): one isolated stack off the Mac

Stand up a single cortex stack on a remote box (start with a VPS/CF Container — whichever is faster), with its own identity, and **federate it with a local Mac stack**. Decide the hub shape (§2) as part of it. Outcome: the first off-machine federation test + proof cortex's daemon + leaf networking run cleanly off-Mac. **This is the foundation of the multi-stack federation test zone (N such stacks)** — the pre-release "test `cortex network` + `cortex stack` management + federated networks + multi-principal" item.

Concretely (decisions flagged are the principal's — infra + secrets):
1. Pick the box (VPS vs CF Container) and the hub shape (§2.1 stable off-machine hub is simplest first).
2. `arc install Cortex` on the box; `cortex stack create <slug>` for a born-aligned config-split stack; provision its NKey seed + (operator-mode) NSC operator + bot tokens **on the box** (not synced from the Mac).
3. `cortex network create` / `join` to federate it with a Mac stack; verify leaf link + cross-principal dispatch.
4. Confirm the stack survives the Mac being offline.

## 5. Open questions

- Secrets on remote infra (NKey seed, operator-mode NSC operator root, bot tokens) — provisioning + rotation off-Mac (CF vault/egress vs VPS secret store).
- CF Container vs VPS as the default Mode-B substrate (control vs convenience).
- Whether Mode-B stacks default to sovereign-per-principal (§2.2) or shared-hub (§2.1) for the test zone vs production.
- Relationship to the pre-release federation epic — does Mode-B hosting become a slice of it, or its own tracking issue under it?
