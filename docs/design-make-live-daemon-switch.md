# Design — make-live / daemon-switch (land a provisioned stack onto its own account)

**Feature:** C-1257 (PR7 / #1225, EPIC #1142, ADR-0013 sovereign model)
**Status:** implemented (validated on the `work` throwaway stack)
**Companion:** `cortex network provision` (#1253 + arc#255) — the non-disruptive account-tree mint this step lands.

## 1. Problem

`cortex network provision <stack> --apply` mints a principal's sovereign nsc
account tree (`OP_<PRINCIPAL>` → `<PRINCIPAL>_<STACK>_FED` + `<PRINCIPAL>_<STACK>_AGENTS`),
wires the local `federated.>` export/import, ensures the signing seed, and writes
`stack.nats_infra` (`account`, `agents_account`, `creds_path`) back to config.

Provision is deliberately **non-disruptive** — it never switches the running
daemon onto the new account. Three gaps remain after provision (verified on
`work`):

1. **The creds file is never minted.** `nats_infra.creds_path` is written but no
   `.creds` exists under the new agents account.
2. **The local NATS server never learns the new account.** `~/.config/nats/local.conf`
   (`resolver: MEMORY`) carries only the OLD shared `ANDREAS_AGENTS` account in
   `resolver_preload`.
3. **There is no make-live command for a LOCAL stack.** `cortex network join`
   renders leaf/operator-mode config only for *federated* stacks; a local stack
   (e.g. `work`) has no network, so nothing flips its daemon onto its own account.

Result: provision succeeds, but the daemon keeps authenticating under
`ANDREAS_AGENTS` — the shared second-signing-facility #1225 is eliminating.

## 2. What the daemon authenticates with (ground truth)

The cortex daemon opens ONE bus connection using **`nats.credsPath`** (the
`.creds` file — `src/bus/nats/connection.ts`, `credsAuthenticator`). The account a
connection lands in is determined entirely by that creds file. Confirmed on the
live `work` daemon via the NATS monitor (`/connz?auth=true`):

```
cortex-work -> acct AADPQ7M7… (ANDREAS_AGENTS)     # before make-live
cortex-work -> acct AARHPQIM… (ANDREAS_WORK_AGENTS)# after make-live
```

`nats.accountSigningKeyPath` is a **separate** concern — the SA-seed the
`TrustResolver` uses to verify *peer* bots' signed request envelopes
(`src/common/agents/trust-resolver.ts`). It is NOT used to open the daemon's own
connection. See §7 (deferred).

`nats_infra.creds_path` (provision's write-back) describes the FEDERATION leaf's
creds — a different connection (server-to-server leaf), handled by `network join`.
It is NOT the daemon's own connection creds. **make-live mints the daemon's own
connection creds to `nats.credsPath`.**

## 3. Decisions

### 3.1 Command home — `cortex network make-live <stack>`

make-live is a **separate, explicit step** (provision stays non-disruptive). It
lives under `cortex network`, alongside `provision` and `join`, so the whole
sovereign-bus pipeline reads as one namespace:

```
cortex network provision <stack> --apply   # mint account tree (non-disruptive)
cortex network make-live  <stack> --apply   # land the daemon on its agents account
cortex network join       <network> --apply # (federated only) render the leaf
```

**Fork for confirmation (Andreas):** the alternative home is `cortex stack make-live`
(make-live operates on a single LOCAL stack's bus identity, which is arguably a
`stack`-lifecycle concern like `stack create`). We chose `network` for
pipeline-consistency with `provision` (which is also stack-scoped yet lives under
`network`). The orchestration lib is pure and the dispatch wiring is one line, so
moving it to `stack` later is trivial.

### 3.2 Mechanics — LOCAL stack (the core daemon-switch)

Ensure-shaped, idempotent, dry-run by default (`--apply` mutates). Inputs derived
from config (`nats.credsPath`, `nats.name`, `stack.nats_infra.agents_account`,
principal/slug → `ANDREAS_<STACK>_AGENTS`) + flags:

0. **Resolve the target nats-server PER STACK.** The nats config make-live edits +
   hard-restarts is derived from `stack.nats_infra.config_path` (or `--nats-config`),
   the same field `network join` derives from — there is **NO** hardcoded default.
   `metafactory` + `work` legitimately resolve to the shared `~/.config/nats/local.conf`
   from their own config; a co-located stack on its OWN nats-server (`community.conf`,
   `halden.conf`) carries its own `config_path`. When neither flag nor config supplies
   it, make-live **fails fast** rather than guessing — a silent `local.conf` default
   would edit the wrong file and hard-restart the wrong (shared) server for a
   community/halden stack. **Operator-mode guard:** a bus with no `resolver_preload`
   block (the anonymous/hard-isolated `halden` pattern) is refused early — make-live
   does not apply to it.
1. **Mint creds under the agents account.** `arc nats add-bot <nats.name>
   --account <AGENTS> --output <nats.credsPath> --force`. The existing creds is
   backed up to a **timestamped** `<creds>.bak-makelive-<ts>` first (so a second
   `--apply`/`--force` never clobbers the FIRST migration's original-account
   backup — the rollback artefact). Idempotent: skipped when the bot user already
   exists under the agents account AND the creds file is present.
2. **Teach the NATS server the new account.** Append the agents account JWT to
   `resolver_preload` in the **resolved** nats config (§0). Keyed on the account
   pubkey — present ⇒ no-op; absent ⇒ append a labelled block. **Never touches
   other accounts** (multi-stack safety, §3.5). The account JWT comes from
   `arc nats export-account <AGENTS>` (read-only verb). **Pubkey cross-check:** the
   exported account pubkey is asserted equal to the config `agents_account` pubkey
   (the resolver map key) before the write — a drift (slug rename / re-mint / stale
   `nats_infra`) would write `<configPubkey>: <jwt-for-another-account>`, which nats
   keys under `jwt.sub` → auth failure. Mismatch ⇒ fail-fast (re-run provision).
3. **Restart the NATS server.** A MEMORY resolver does **NOT** pick up
   `resolver_preload` changes on `SIGHUP` (empirically verified — the appended
   account did not load after `kill -HUP`). A hard restart is required
   (`launchctl kickstart -k <nats-service-label>`). Gated on the resolver having
   **actually changed** — a `--force` re-mint over an already-present account does
   NOT hard-restart the (shared) server for a no-op resolver.
4. **Restart the cortex daemon** so it reconnects with the new creds
   (`launchctl kickstart -k <cortex-daemon-label>`, descriptor discovered by the
   #800 `findCortexDaemonDescriptor` config-arg matcher). Skipped when nothing
   changed.

Service descriptors are discovered, never guessed: the cortex daemon by the #800
`--config` matcher; the nats-server by a sibling matcher that finds the launchd
plist / systemd unit running `nats-server -c <natsConfigPath>`. **The dry-run
resolves and PRINTS both restart targets** (the matched plist/unit paths) so the
operator verifies the — possibly shared-server — blast radius before `--apply`; a
needed-but-undiscoverable service surfaces as a dry-run WARNING.

### 3.3 Mechanics — FEDERATED stack

make-live is **network-agnostic**: it lands the daemon on `ANDREAS_<STACK>_AGENTS`
regardless of federation. For a federated stack the order is provision →
make-live → `network join`; join renders the leaf (operator-mode `.conf` + leaf
creds / secret-auth pipe) binding the FED account, and the provision-wired
`federated.> ` export/import (FED → AGENTS) delivers cross-network traffic into
the daemon's AGENTS account. The two accounts (FED for the leaf, AGENTS for the
daemon) are exactly provision's split.

**Encryption / `payload_key` survives by construction.** make-live edits only the
creds file + `resolver_preload` + restarts two services. It NEVER touches
`policy.federated`, the per-network `payload_key`, or any encryption block, so the
confidentiality setup is untouched by the account swap.

### 3.4 Idempotent + reversible

- **Re-runnable.** Each step is ensure-shaped; a converged re-run mints nothing,
  edits nothing, and restarts nothing.
- **Rollback** (documented, manual): restore the FIRST-migration
  `<creds>.bak-makelive-<ts>` (the earliest timestamp — the original-account creds)
  over `nats.credsPath`, remove the agents-account block from `resolver_preload`
  (restore `local.conf` from the timestamped backup make-live writes), restart the
  nats-server + the cortex daemon. The daemon returns to `ANDREAS_AGENTS`.

### 3.5 Multi-stack on one nats-server

The local nats-server (`homebrew.mxcl.nats-server`, `-c local.conf`) is shared by
several stacks (`work`, `meta-factory`, the MC aggregators). The
`resolver_preload` append is a **pure addition** keyed on the new account's
pubkey; it neither rewrites nor reorders the accounts already present. Verified:
after landing `work` on `ANDREAS_WORK_AGENTS`, every other connection stayed on
`ANDREAS_AGENTS` and reconnected cleanly across the nats-server restart.

## 4. New arc verb — `nats export-account <name>`

A read-only companion to `init-operator` / `add-account` (schema
`arc.nats.operator.v1`). Returns the account's pubkey, its account JWT (for
`resolver_preload`), and its identity seed path (SA-seed, for the deferred
`accountSigningKeyPath` rewrite):

```
arc nats export-account ANDREAS_WORK_AGENTS --json
→ {"schema":"arc.nats.operator.v1","ok":true,"account":"ANDREAS_WORK_AGENTS",
   "pubKey":"AARHPQIM…","jwt":"eyJ…","seedPath":"~/.local/share/nats/nsc/keys/keys/A/AR/AARHPQIM….nk"}
```

Pure read (`nsc describe account --raw` + keystore-path derivation). cortex never
runs nsc — it shells `arc nats export-account` (the ADR-0013 invariant).

## 5. Success oracle (validated on `work`)

1. **new creds exist** under the agents account (`/connz` user iss = AGENTS).
2. **resolver carries the new account** (a client with AGENTS creds connects).
3. **daemon authenticates under `ANDREAS_WORK_AGENTS`** — `/connz?auth=true` shows
   `cortex-work -> AARHPQIM…`, and `work-logs/` carries **0** own-auth
   `Authorization Violation`.

## 6. Anti-rot guard

A real-spawn integration test (sibling of the arc#255 guard) exercises the make-
live plan + apply against an injected arc/exec/fs contract, asserting: creds
minted under the agents account, the agents JWT appended to `resolver_preload`
exactly once (idempotent on re-run), both services restarted only when state
changed, and the encryption/federated config left byte-identical.

## 7. Deferred (explicit)

- **`nats.accountSigningKeyPath` rewrite.** make-live does NOT repoint the
  TrustResolver SA-seed to the new account in this iteration. It is not on the
  daemon-auth path (creds-only), it lives in the higher-blast `system/` config
  layer, and on a multi-agent stack the account-signing-key question (whether the
  AGENTS account carries a dedicated signing key vs its identity key) needs its
  own treatment. `export-account` already returns the `seedPath` so the rewrite is
  a small follow-up. Flagged for Andreas.
- **Full federated E2E.** Validated path is LOCAL (`work`). The federated
  composition (make-live then `join`) is covered by design + the existing join
  tests; a federated stack make-live + join round-trip is a follow-up on a
  throwaway federated stack.
