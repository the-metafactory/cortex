# Runbook — provisioning a hub-admin key for Mission Control govern verbs (D-11)

> **Status:** runbook · foundation for the MC future-state plan (`docs/plan-mc-future-state.md`) slice **FLG-2** and the R3 high-blast verbs (FLG-6/8/9). Records decision **D-11** (`docs/decisions-mc-future-state.md`). **[principal-hands]** — a human runs these steps; no agent executes a production registry deploy.

## Why this exists

Mission Control's **hub-admin** govern verbs — *authorize* (FLG-2), *seal / admit-and-seal* (FLG-6), *rotate-K* (FLG-8), *revoke* (FLG-9) — are signed by the operating principal's **daemon** and verified by the registry against the **hub-admin authority**. That authority is a *different* allowlist from the registry-admin one:

| Authority | Allowlist (registry secret) | Governs | ADR |
|---|---|---|---|
| **registry-admin** | `REGISTRY_ADMIN_PUBKEYS` (+ per-network `admin_pubkeys`) | admit / reject onto a roster | ADR-0020 |
| **hub-admin** | `REGISTRY_HUB_ADMIN_PUBKEYS` | mint/deliver leaf secrets, seal, rotate-K, revoke, authorize | ADR-0018 Q5 |

Verified in the registry source: `src/services/network-registry/src/index.ts` declares `REGISTRY_HUB_ADMIN_PUBKEYS` (:93) and `parseHubAdminPubkeys()` (:114). **When it is unset, the hub-admin routes `503` fail-closed** — so a glass verb (FLG-2 onward) cannot even *demo* until the operating daemon's hub-admin pubkey is on this allowlist. **Executing this runbook is therefore a hard gate for FLG-2.**

`REGISTRY_HUB_ADMIN_PUBKEYS` is a comma-separated list of **base64 Ed25519 pubkeys** and is a **secret set at deploy time** (not committed to `wrangler.toml`).

## Procedure

1. **Get the daemon's hub-admin pubkey.** This is the base64 Ed25519 pubkey the daemon signs hub-admin claims with (the same key shape the CLI `--admin-seed` derives). Derive it from the hub-admin seed the principal controls, e.g. the network-admin nkey:
   ```bash
   # base64 Ed25519 pubkey for the admin seed the daemon will sign with
   cortex network status --json 2>/dev/null | jq -r '.hub_admin_pubkey // empty'   # if surfaced, else derive from the seed file
   ```
   If it is not surfaced, derive it from the seed the same way `cortex network secret add-member --admin-seed <path>` does (base64, 44 chars). **Record the pubkey — it is public and safe to paste; the seed is NOT.**

2. **Add it to the registry's hub-admin allowlist — ALWAYS `--env production`.**
   ```bash
   cd src/services/network-registry
   # append the new pubkey to the comma-separated set (fetch the current value first if others exist)
   bunx wrangler secret put REGISTRY_HUB_ADMIN_PUBKEYS --env production
   # paste: <existing-pubkeys>,<new-daemon-hub-admin-pubkey>
   ```
   > ⚠️ **Never a bare `wrangler deploy` / bare `secret put`.** `package.json`'s `deploy` script is bare (`wrangler deploy`) — running it or a bare `secret put` targets the **dev** environment and can clobber prod onto the dev DB. Every registry mutation is `--env production` explicitly. The registry is **not** deployed by `arc upgrade`.

3. **Verify — the daemon can now sign a hub-admin op without a 403/503.**
   ```bash
   # dry-run authorize (or any hub-admin verb) — should NOT return 503 admin_not_configured / 403 admin_not_authorized
   cortex network authorize <request-id> --admin-seed <hub-admin-seed> --dry-run
   ```
   A clean dry-run (no `admin_not_configured` / `admin_not_authorized`) confirms the pubkey is live on the allowlist.

## Out of scope / notes

- **Self-service enrollment is out of scope** (D-11 recommendation). A principal does not add *themselves* to the hub-admin allowlist from the glass; it is a deliberate manual, human-run act. Decentralized self-service touches the self-hostable-registry / `did:web` direction (#1324) and is a separate track.
- **Two authorities never conflate** (plan invariant 5): being on `REGISTRY_ADMIN_PUBKEYS` does **not** grant hub-admin, and vice-versa. A principal driving seal/rotate/revoke from the glass needs `REGISTRY_HUB_ADMIN_PUBKEYS`; a principal only admitting/rejecting needs `REGISTRY_ADMIN_PUBKEYS`.
- **Hub-locality still applies** (plan invariant 7 / FLG-7): being on the hub-admin allowlist authorizes the *registry* half; the hub-side conf write (seal / revoke-cut / rotate SIGHUP) is still valid only when the executing daemon's host **is** the hub.

## References

- ADR-0018 (admission gate + leaf-secret distribution) §Q5 — the hub-admin authority
- ADR-0020 (per-network admin read-scoping) — the registry-admin authority
- `docs/plan-mc-future-state.md` §3 signed-op ledger + §4.D (FLG-2/6/8/9) + §6 invariants 5, 7
- `docs/decisions-mc-future-state.md` — D-11
- `src/services/network-registry/src/index.ts` — `REGISTRY_HUB_ADMIN_PUBKEYS`, `parseHubAdminPubkeys()`
