# SOP — Stack Identity (NKey signing key)

**Status:** active (v2.0.3 — cortex#324)
**Owner:** principal
**Audience:** anyone running a cortex stack on the metafactory bus

---

## What is the stack NKey?

Every cortex stack on the metafactory bus has a **signing identity** — a NATS NKey keypair (`SU…` seed + `U…` public key) that cortex uses to sign every outbound envelope via myelin's `signEnvelope`. Peers on the bus that trust this stack's public key verify the signature via `verifySignedByChain` (cortex#320 / v2.0.2) before accepting the message.

The stack NKey is **different** from:

| Key | Purpose | Prefix | Threat scope |
|---|---|---|---|
| **Operator root** | Signs operator JWT, mints account JWTs | `SO` | Catastrophic — full bus control |
| **Account signing** | Mints user JWTs | `SA` | High — mint arbitrary identities under the account |
| **Stack signing** (this doc) | Signs outbound envelopes | `SU` | Medium — forge envelopes from this stack |
| **NATS auth user** | Authenticates with NATS server | `SU` | Medium — connect as this user |

In practice, single-principal deployments can reuse one user-class (`SU`) NKey for both stack signing and NATS auth — that's what `arc upgrade Cortex` provisions by default, and what `migrate-config --auto-stack-key` migrates legacy configs onto.

## Why ON by default?

cortex#320 (v2.0.2) wired the verification side: every peer running cortex now calls `verifySignedByChain` on inbound peer-dispatch envelopes. If the publisher didn't sign, every consumer rejects.

Through cortex#314 (v2.0.0) and earlier, `stack.nkey_seed_path` was **opt-in**: principals had to know to declare it, generate a key, chmod 600 it, and update their config. The dominant install shape was unsigned — including the principal's own deployment.

cortex#324 (v2.0.3) flips the default. Stack signing is ON. `arc upgrade Cortex` auto-provisions the key; cortex.ts emits a loud stderr WARNING when the field is missing; cortex.yaml.example ships the worked example. Principals upgrading from v2.0.2 either get auto-provisioned (recommended) or see the warning on first boot.

v2.0.4 will promote the missing-field condition to a refuse-to-boot.

## Where does the seed live?

Canonical path: `~/.config/nats/cortex.nk` for the main stack, `~/.config/nats/cortex-work.nk` for the secondary work stack.

Permissions: **chmod 600** (the loader enforces this — anything more permissive fails closed at boot).

The seed file format is whatever `nsc generate nkey -u` produces — a single line of base32 starting with `SU`, optionally followed by a trailing newline (the loader trims).

## How does arc provision it?

On every `arc upgrade Cortex`, `scripts/postupgrade.sh` sources `scripts/lib/stack-identity-provision.sh` and calls `provision_stack_identity`:

1. **Idempotency check** — if `cortex.yaml` already declares `stack.nkey_seed_path`, skip. No edits.
2. **NKey existence check** — if `~/.config/nats/cortex.nk` is present, reuse it. Otherwise generate a fresh `SU`-prefixed seed via `nsc` (preferred) or via `bun` + `nkeys.js` (fallback).
3. **Backup** — copy the existing config to `cortex.yaml.pre-stack-identity-${timestamp}` before any edit. Principal can roll back trivially.
4. **Edit** — append `nkey_seed_path` (and `nkey_pub` when the pubkey can be derived) into the existing `stack:` block, or create a `stack:` block if none exists.

The same flow runs for `cortex.work.yaml` against `~/.config/nats/cortex-work.nk` when the secondary work stack config exists.

## How does cortex.ts use it?

At boot (`src/cortex.ts` lines 316–428):

1. Load the seed file (chmod 600 gate, `SU` prefix gate, `nkeys.fromSeed` parse).
2. If `stack.nkey_pub` is also declared, assert the loaded keypair's pubkey matches the declared value. A mismatch throws — the principal-rotation split-brain hazard.
3. Derive the principal DID: `did:mf:${stack.id.replace("/", "-")}`.
4. Stage the signer onto `MyelinRuntime.publish()` — every outbound envelope gets stamped with `signed_by[0]` carrying the DID + signature.

Boot log line on success:

```
cortex: stack signing key staged — principal=did:mf:andreas-meta-factory (active once myelin runtime starts)
```

Boot log line on missing-field:

```
WARNING: stack identity not configured — cortex will publish unsigned envelopes.
  Peers that verify signed_by[] will reject these messages.
  Run `arc upgrade Cortex --force` to auto-provision, or add
  `stack.nkey_seed_path` (+ optionally `stack.nkey_pub`) to cortex.yaml.
  See docs/sop-stack-identity.md for the full SOP.
```

## How do I rotate?

Stack-NKey rotation is a coordinated change across (a) this stack and (b) every peer that trusts this stack's pubkey.

1. **Generate a new seed:**
   ```bash
   nsc generate nkey -u > ~/.config/nats/cortex.nk.new
   chmod 600 ~/.config/nats/cortex.nk.new
   ```
2. **Derive the new pubkey:**
   ```bash
   bun -e 'import { fromSeed } from "nkeys.js"; import { readFileSync } from "fs"; console.log(fromSeed(new TextEncoder().encode(readFileSync(process.argv[2], "utf-8").trim())).getPublicKey())' ~/.config/nats/cortex.nk.new
   ```
3. **Update peers' `trust:` lists.** Every cortex stack that consumes envelopes from this stack must add the new pubkey to its `policy.principals[].trust[]` (or wherever the trust anchor lives in their config). Until peers have the new pubkey, they will reject your envelopes.
4. **Swap the seed atomically:**
   ```bash
   mv ~/.config/nats/cortex.nk ~/.config/nats/cortex.nk.old
   mv ~/.config/nats/cortex.nk.new ~/.config/nats/cortex.nk
   ```
5. **Update `stack.nkey_pub` in cortex.yaml** to the new value. (If you leave the old `nkey_pub`, cortex.ts boot will throw `seed file pubkey ... does not match declared stack.nkey_pub ...` — the split-brain guard.)
6. **Restart cortex** — `launchctl unload && launchctl load` the meta-factory plist.
7. **Verify** — peers' logs should show successful chain verification on the new envelopes. The cortex boot log should show the new principal DID's pubkey.

When everything is verified working, delete `cortex.nk.old`.

## Threat model

- **Seed leak (catastrophic).** Anyone with the seed can mint envelopes that any peer trusting this stack's pubkey will accept. Mitigations: chmod 600, never commit, rotate on suspicion.
- **Principal rotation split-brain.** Seed file rotated but peers still trust the old pubkey — every outbound envelope rejected. Mitigation: `stack.nkey_pub` consistency-pin at boot (catches the mismatch); SOP step 3 above (update peers BEFORE swap).
- **Hardware backing.** Not yet — the loader's signature is the seam where a Yubikey/TPM-backed signer can replace the in-memory keypair without changing call sites. Forward work.

## Cross-references

- **cortex#114** — IAW Phase B umbrella (signing umbrella)
- **cortex#200** — myelin `signEnvelope` consumer pattern (Phase B.1c)
- **cortex#262** — Phase A.5 stack-id grammar (`{principal}/{stack}`)
- **cortex#314** — `cortex.yaml.example` first-install safety (v2.0.0)
- **cortex#320 / PR #322** — runner-side `verifySignedByChain` wired (v2.0.2)
- **cortex#324** — this PR (v2.0.3 — walk-the-talk default)
- **`src/common/config/stack-signing-key.ts`** — loader (chmod 600 + `SU` prefix gate)
- **`src/cortex.ts`** lines 316–428 — boot-time staging
- **`scripts/lib/stack-identity-provision.sh`** — arc upgrade auto-provisioner
- **`docs/design-policy-cutover.md`** — policy-side cutover that consumes the signed envelopes
- **`docs/design-internet-of-agentic-work.md`** §3.1 — IAW federation context
