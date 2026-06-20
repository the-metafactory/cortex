> # ⚠️ SUPERSEDED — see `sop-onboard-peer-principal.md`
>
> **Superseded by [`docs/sop-onboard-peer-principal.md`](./sop-onboard-peer-principal.md) for the end-to-end peer-onboarding path.** Retained for: the manual cloudflared-led peering recipe (offline/no-registry fallback), reachability option comparison, and the offline hand-pin steps. For the steady-state case, follow the new runbook instead.
>
> **This manual, cloudflared-led runbook (#728) is also superseded by the one-command join** ([`docs/sop-network-join.md`](./sop-network-join.md), S6 / Network Join Control Plane #733). For the steady-state case, **do not follow the steps below** — run:
>
> ```bash
> cortex provision-stack register <principal-id> --seed-path <p> --registry-url <url> --stack-id <id>   # once
> cortex network join <network> --principal <id> --registry-url <url> --registry-pubkey <b64> \
>   --seed-path <p> --creds <p> --account <A…> --nats-config <p> --plist <p> --apply
> cortex network status --principal <id>
> ```
>
> The registry is now the source of truth (descriptor + roster + trust anchor — [ADR-0003](./adr/0003-network-join-control-plane.md) DD-2/DD-9/DD-12); the command absorbs every manual step below.
>
> **This document is kept for historical reference and as the manual fallback** for: no reachable registry, the offline hand-pin path (DD-5 fallback), or bringing up a brand-new hub before its descriptor exists. Note that a **public NATS hub** (JC's hub) makes the cloudflared "Reachability" section below **moot for the 2-party case** — leaf nodes dial outbound to the public hub (NAT-safe), so no tunnel is needed.

# Runbook — Configure Federation Peering (cross-principal review test)

**Goal:** wire two principals' cortex stacks together so a `pilot request-review` on one side is reviewed by the other and the verdict comes back — the end-to-end cross-principal review loop.
**Worked example:** **Andreas** (NZ, principal `andreas`) ↔ **JC** (Switzerland, principal `jcfischer`).
**Posture for the test:** `security.signing: off` — the `peers[]` membership list + the physical NATS leaf-link separation are the boundary. Crypto verify (signing/mTLS/encryption) is the later ramp; not required to light the loop.
**Contract:** [`docs/adr/0002-federated-dispatch-addressing-and-verdict-back.md`](./adr/0002-federated-dispatch-addressing-and-verdict-back.md) + [`docs/sop-federation-onboarding.md`](./sop-federation-onboarding.md). Before editing any wire code, run `/wire-check`.

## Prerequisites (BOTH sides)

- **cortex ≥ v4.7.0** (federated review consumer, Offer + Direct) — `arc upgrade Cortex`.
- **pilot ≥ v1.3.0** (cross-principal `--principal` / `--reviewer` flags) — update the pilot checkout (`cd ~/Developer/pilot && git pull`) or `arc upgrade pilot` where managed.
- A reviewer **assistant** on the *receiving* side that declares a `code-review.*` capability (e.g. Echo on JC's stack).
- NATS server admin on at least one side (to host the leaf hub).

The loop is **three independent layers** — do them in order. (1) topology, (2) trust, (3) dispatch.

---

## Step 0 — Agree the identities + who hosts the leaf hub

Exchange, out of band:

| | Andreas | JC |
|---|---|---|
| principal / stack | `andreas/meta-factory` | `jcfischer/{stack}` (JC picks, e.g. `jcfischer/sage-host`) |
| NATS reachable URL | e.g. `nats://andreas-host:4222` | e.g. `nats://jc-host:4222` |
| stack signing pubkey | (from Step 2) | (from Step 2) |

**Decide whose NATS hosts the leaf hub.** Simplest: one side runs the **hub** (a `leafnodes{}` *listener*), the other connects in as a **remote**. Either side can host; the network name (`metafactory`) is **topology only — it never goes on the wire**.

---

## Step 1 — Stand up the NATS leaf link (topology)

This joins the two buses. It is **NATS-server config**, not cortex config.

**Hub side** (say Andreas) — add a leafnode listener to the NATS config (`~/.config/nats/<conf>`):
```
leafnodes {
  port: 7422
  # auth recommended even for the test:
  authorization { user: leaf, password: <shared-secret> }
}
```

**Remote side** (JC) — connect in:
```
leafnodes {
  remotes = [
    { url: "nats-leaf://leaf:<shared-secret>@andreas-host:7422" }
  ]
}
```

Reload both NATS servers. Verify the leaf link is **up** (NATS logs show the leafnode connection). The leaf only needs to carry `federated.>` — keep `local.*` off the bridge.

### Reachability — the cross-internet crux (the part that actually blocks)

cortex's NATS listens on **`127.0.0.1:4222`** (localhost) and home machines sit behind NAT, so the remote side cannot reach the hub directly. The hub host must expose its **leaf port** reachably. Pick one:

- **(Recommended here) cloudflared TCP tunnel.** The hub side already has `cloudflared` + a CF zone (`meta-factory.ai`). Run a named tunnel with a TCP ingress to the leaf port, mapped to a hostname (e.g. `nats-leaf.meta-factory.ai`). The remote connects with `cloudflared access tcp --hostname nats-leaf.meta-factory.ai --url localhost:7422`, then points its NATS leaf `remote` at `nats://localhost:7422`. Uses existing CF; no VPS; auth via CF Access + the leaf password.
- **Neutral cloud NATS hub.** A small NATS on a VPS / Synadia NGS that **both** sides connect to as leaf remotes — neither is behind NAT for the link. Cleanest topology; costs a box.
- **Tailscale / WireGuard.** A tailnet between the two machines; the remote dials the hub's tailscale IP:7422. Simplest if both already run it.

### The host package (what the hub side hands the peer)

Once the hub is reachable, send the peer **out of band**:
1. **Leaf endpoint + creds** — `nats-leaf://leaf:<secret>@<reachable-host>:7422` (+ the `cloudflared access tcp …` command if using CF).
2. **Your stack identity** — `{principal}/{stack}` + the stack **pubkey** (`U…`, from `system.yaml`'s `nats.identity.publicKey` / the stack's `nkey_pub`).
3. **A pre-filled config template** — the peer's Step-3 block with you already listed as their peer.

And ask the peer to send back: their `{principal}/{stack}` + their stack pubkey (Step 2), so you can add **them** to your `peers[]`.

---

## Step 2 — Provision identity + exchange pubkeys (trust)

Each side mints (or reuses) its **stack signing NKey** and shares the **public** half:
```bash
cortex provision-stack generate andreas --seed-path ~/.config/nats/cortex.nk --stack-id andreas/meta-factory
# prints the U-prefixed public NKey → give it to JC
```
JC does the mirror for `jcfischer/{stack}` and gives Andreas his pubkey.

For a 2-party test, **`peers[]` (the manual pin) is simpler than the registry** — skip the registry. (Each side *may* instead `cortex provision-stack register …` against `network.meta-factory.ai` and pin the registry; the registry replaces hand-maintaining pubkeys when there are >2 peers. Not needed here.)

---

## Step 3 — Configure the federated network + peer (dispatch, cortex config)

On **each** side, add a federated network entry. In the config-split layout this is the **`network/` layer**, or inline under `policy.federated` in `~/.config/cortex/<stack>/stacks/<stack>.yaml`.

**Andreas's side** (`andreas/meta-factory`):
```yaml
policy:
  federated:
    networks:
      - id: metafactory
        leaf_node: nats-leaf-metafactory        # a name for the link from Step 1
        max_hop: 1                                # required — a conscious hop budget
        accept_subjects:
          - federated.andreas.meta-factory.>      # accept inbound addressed to ME
        announce_capabilities:
          - code-review.typescript                # what I offer peers (Offer mode)
        peers:
          - principal_id: jcfischer
            stack_id: jcfischer/sage-host
            principal_pubkey: U…                  # JC's stack pubkey from Step 2 (U-prefixed, 56 chars)
        # F-3a: the leaf connection for this network (whose NATS to publish federated.* onto)
        nats:
          url: nats://andreas-host:4222           # the bus that carries the leaf link
          name: nats-leaf-metafactory
```

**JC's side** (`jcfischer/sage-host`) — the mirror image:
```yaml
policy:
  federated:
    networks:
      - id: metafactory
        leaf_node: nats-leaf-metafactory
        max_hop: 1
        accept_subjects:
          - federated.jcfischer.sage-host.>       # accept inbound addressed to JC
        announce_capabilities:
          - code-review.typescript
        peers:
          - principal_id: andreas
            stack_id: andreas/meta-factory
            principal_pubkey: U…                  # Andreas's stack pubkey
        nats:
          url: nats://jc-host:4222
          name: nats-leaf-metafactory
```

Key rules (the `/wire-check` checklist):
- `accept_subjects` must be **your OWN** `federated.{me}.{my-stack}.>` (the receiver subscribes to its own identity).
- `peers[].principal_id` is what the inbound gate checks — a request from a principal **not** in `peers[]` is denied + dropped.
- **No `network_id` anywhere on the wire** — the network is resolved from `peers[]` at routing time.

---

## Step 4 — Reload the daemons

Pick up the new config (the federated consumer only wires when `networks[]` is non-empty):
```bash
launchctl unload ~/Library/LaunchAgents/ai.meta-factory.cortex.<stack>.plist
launchctl load   ~/Library/LaunchAgents/ai.meta-factory.cortex.<stack>.plist
```
Verify in the daemon log: the review consumer reports a **federated** subscription on `federated.{me}.{my-stack}.tasks.code-review.>` (and the Direct `tasks.*.code-review.>`), and the leaf link is connected.

---

## Step 5 — Test end-to-end

From **Andreas's** side, request a review from **JC's** reviewer pool (**Offer**):
```bash
pilot request-review --pr <PR-URL-or-number> \
  --principal jcfischer/sage-host \
  --capability code-review.typescript \
  --wait
```
Or a **Direct** request to a named reviewer:
```bash
pilot request-review --pr <…> --reviewer echo@jcfischer/sage-host --wait
```

What should happen (trace it if it doesn't):
1. pilot emits `federated.jcfischer.sage-host.tasks.code-review.typescript` — `source` = `jcfischer.sage-host.pilot` (addresses JC), `originator.identity` = `did:mf:andreas-meta-factory` (the requester). **No `network_id`.**
2. The leaf link carries it to JC's bus.
3. JC's cortex consumer gates on `peers[]` (andreas IS a peer ✓), runs the review via the reviewer assistant, emits the verdict to `federated.andreas.meta-factory.review.verdict.<kind>` — requester decoded from `originator` (`did:mf:andreas-meta-factory` → first-hyphen split → `andreas` / `meta-factory`).
4. The verdict rides the leaf back; `pilot --wait` (subscribed to its own `federated.andreas.meta-factory.review.verdict.>`) resolves.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| pilot `--wait` hangs (exit 124) | Leaf link down (Step 1); or requester not in JC's `peers[]` → silently dropped; or JC's cortex < v4.7.0 |
| JC's cortex logs `peer_not_in_accept_list` / `unknown_network` | Andreas's `principal_id` missing from JC's `peers[]`, or the inbound subject's principal ≠ JC's `accept_subjects` identity |
| Request never arrives | leaf not bridging `federated.>`; or pilot < v1.3.0 (no `--principal` flag); or `--principal` resolves to local (fails closed by design) |
| Verdict never comes back | requester decode failed (`originator.identity` not `did:mf:{p}-{s}`); check both sides are on the ADR-0002 grammar (cortex ≥ v4.7.0, pilot ≥ v1.3.0) |

## After the test works

Ramp confidentiality in order (see the stock-take + ADR-0002): **signing** (`off → permissive → enforce` — turns on the registry-resolved peer-pubkey verify) → **mTLS** on the leaf/cloud-publisher → **payload encryption**. Each is a deliberate step once the plaintext loop is proven.
