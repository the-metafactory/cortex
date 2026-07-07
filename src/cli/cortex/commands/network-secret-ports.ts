/**
 * ADR-0018 PR5b (#1240) — `cortex network secret` injected-dependency seams.
 *
 * Like `network-ports.ts` for join, every SIDE EFFECT the secret-tooling
 * orchestrator (`network-secret-lib.ts`) depends on is a port: a real adapter
 * for production (`network-secret-adapters.ts`) and a fake the tests assert
 * against. The orchestrator is PURE over its ports and gates every MUTATION on
 * `apply` — dry-run touches nothing.
 *
 * The mutations are the two halves of the per-member leaf PSK (ADR-0018):
 *   - HUB-LOCAL: write the member's `authorization` user into the hub
 *     nats-server config + reload it (cut/allow transport). The hub-admin
 *     authority (Q5).
 *   - REGISTRY: deliver the opaque sealed blob onto the member's ADMITTED
 *     admission row (sealed mode), or revoke it. NEVER the registry-admin
 *     admit gate — a distinct hub-admin authority.
 */

/** Read/write the hub nats-server config + reload it (SIGHUP). HUB-LOCAL. */
export interface HubAuthPort {
  /** Read the hub nats-server config text. */
  readConf(): Promise<string>;
  /** Write the hub config back (chmod 600 — it carries leaf secrets). */
  writeConf(text: string): Promise<void>;
  /** Reload the hub nats-server (SIGHUP) so the auth change takes effect. */
  reload(): Promise<void>;
  /** The hub config path, for plan/report output. */
  readonly confPath: string;
}

/** Look up a member's admission row in the registry (read-only). */
export interface AdmissionLookupPort {
  /**
   * Find the ADMITTED admission row for (networkId, memberPubkey). Returns the
   * `request_id` + the member's `principal_id` (the leaf-user default) + the
   * row's `stack_id` (`{principal}/{stack}` slash form, when the registry
   * carries it — cortex#1598 derives the scoped-user's stack segment from it),
   * or `undefined` when no ADMITTED row exists for that member+network.
   */
  findAdmittedRow(
    networkId: string,
    memberPubkey: string,
  ): Promise<{ request_id: string; principal_id: string; stack_id?: string } | undefined>;
}

/** Deliver / revoke the opaque sealed blob on the registry. HUB-ADMIN authority. */
export interface SealDeliveryPort {
  /** POST the opaque sealed ciphertext onto the ADMITTED row (add-member/rotate). */
  postSealedSecret(requestId: string, sealedBlob: string): Promise<void>;
  /** POST a hub-admin revoke (ADMITTED → REVOKED + clear blob). */
  revoke(requestId: string): Promise<void>;
}

/** PSK minting + sealing. Injected so tests get deterministic material. */
export interface SecretCrypto {
  /** Mint a fresh per-member leaf PSK (base64url). */
  mintPsk(): string;
  /** Seal `plaintext` to `recipientPubkeyB64` (crypto_box_seal). */
  seal(plaintext: string, recipientPubkeyB64: string): Promise<string>;
}

/**
 * cortex#1481 (epic #1479, join-2) — resolve whether THIS host is the
 * network's hub, so the orchestrator can REFUSE to write a foreign hub's
 * authorization onto the WRONG machine. Read-only.
 *
 * The #1 storm cause this exists to prevent: `add-member`/`admit --and-seal`
 * write the minted leaf PSK into `--hub-config` (default: the LOCAL nats).
 * When the network's actual hub is ANOTHER principal's server, that write
 * lands on the admin's own laptop — never the real hub — so the joiner's leaf
 * presents a PSK the real hub never authorized and Authorization-Violation-
 * storms. (Real incident: the metafactory-community bring-up 2026-07-03 — the
 * PSK landed on the admin's local nats, never on the hub owner's VM.)
 */
export interface HubLocalityPort {
  /**
   * The cached network descriptor's `hub_url` for `networkId` — the SAME
   * `~/.config/cortex/network-cache/<network>.json` DD-10 last-known-good
   * cache `cortex network join` writes after a verified fetch (S1, #735).
   * Read-only, LOCAL DISK ONLY — deliberately never a live registry round
   * trip: the secret-tooling adapters carry no registry-pubkey-pin setup
   * today, and a live-fetch failure must never block a seal that would
   * otherwise succeed. `undefined` when nothing is cached for this network on
   * this host (never joined/synced here) — the pure decision function
   * ({@link decideHubLocality} in `network-secret-lib.ts`) treats an
   * unresolved hub_url as "cannot confirm local" and fails safe to EXTERNAL.
   */
  resolveHubUrl(networkId: string): Promise<string | undefined>;
  /** This machine's own hostname (`os.hostname()`). Injectable for tests. */
  localHostname(): string;
  /**
   * cortex#1481 (Sage review, Important 2) — resolve whether `hubUrl`'s host
   * points at one of THIS machine's own network interfaces. The load-bearing
   * signal for a REAL deployment: `network join` caches the hub as an FQDN
   * (e.g. `tls://nats.meta-factory.dev:7422`) while `os.hostname()` returns a
   * short name (`macjcf`), so a loopback-alias / exact-hostname match alone
   * calls the hub-owner's OWN VM external and kills the auto-write path. This
   * resolves the host via DNS and compares against `os.networkInterfaces()`.
   * FAIL-SAFE: any DNS/resolution error → `false` (→ EXTERNAL), NEVER throws
   * (logged via `process.stderr.write`). `false` for an unparseable/absent
   * host too.
   */
  hubHostIsLocalInterface(hubUrl: string): Promise<boolean>;
}

/**
 * cortex#1598 (epic #1595 slice 2) — mint a subject-scoped hub-transport user
 * on an OPERATOR-MODE hub, returning its `.creds` TEXT for sealing. Backed by
 * the `arc nats add-federated-user` verb (arc#269): cortex shells arc → arc
 * calls nsc (the ADR-0013 Model B boundary; cortex NEVER calls nsc directly).
 *
 * The operator-mode admit path seals this scoped credential instead of writing
 * an inline PSK leaf user into the hub config — an operator hub has no inline
 * `authorization` block to write, and a shared-string leaf user would crash it
 * (cortex#794). OPTIONAL on {@link NetworkSecretPorts}: the simple/PSK path and
 * every existing fake keep compiling without it.
 */
export interface ScopedUserMintPort {
  /**
   * Mint (idempotent) a scoped federated user + return its `.creds` TEXT.
   * Never leaves the creds file on disk: the adapter writes to a tmp path,
   * reads the text back, and unlinks it (nsc can re-derive creds anytime).
   */
  mintScopedUser(input: {
    /** The hub's federation account (UPPER_SNAKE nsc account). */
    hubFedAccount: string;
    /** DOTTED `<principal>.<stack>` — the `{{name()}}` scope-template convention. */
    natsUser: string;
    /** The network id (diagnostics only; the scope is account-derived). */
    networkId: string;
  }): Promise<
    | {
        ok: true;
        /** The minted user's `.creds` text (JWT + seed) — sealed, never logged. */
        creds: string;
        /** U-prefixed user NKey public key (fingerprint-class; safe to log). */
        userPubKey: string;
        /** A-prefixed pubkey of the `federated`-role scoped signing key. */
        signingKeyPubKey: string;
        /** A-prefixed pubkey of the hub FED account (the probe-then-stamp target, C3). */
        accountPubKey: string;
        scopeAlreadyPresent: boolean;
        userAlreadyPresent: boolean;
      }
    | { ok: false; reason: string; code?: "ARC_TOO_OLD" | "USER_NOT_SCOPED" | "OTHER" }
  >;

  /**
   * cortex#1599 (epic #1595 slice 4) — ROTATE: revoke the OLD key server-side
   * (`nsc revocations add-user` + push — runtime, no hub restart) then re-mint
   * FRESH material under the same scoped signing key + return its `.creds` TEXT.
   * Same never-leaves-disk creds handling as {@link mintScopedUser}. Backed by
   * `arc nats reissue-federated-user`. OPTIONAL — the rotate operator branch
   * requires it and fails clearly when it (or the arc verb) is absent.
   */
  reissueScopedUser?(input: {
    hubFedAccount: string;
    natsUser: string;
    networkId: string;
  }): Promise<
    | {
        ok: true;
        /** The NEW user's `.creds` text — sealed, never logged. */
        creds: string;
        /** U-prefixed pubkey of the NEW user. */
        userPubKey: string;
        signingKeyPubKey: string;
        accountPubKey: string;
        /** U-prefixed pubkey of the OLD (revoked) user — fingerprint-class. */
        revokedPubKey: string;
      }
    | { ok: false; reason: string; code?: "ARC_TOO_OLD" | "USER_NOT_SCOPED" | "USER_NOT_FOUND" | "PUSH_FAILED" | "OTHER" }
  >;

  /**
   * cortex#1599 — REVOKE: add the user's pubkey to the account revocation map +
   * push (runtime transport cut, no hub restart), then delete the local user.
   * A push failure surfaces as `PUSH_FAILED` (the memory/preload-resolver caveat
   * is loud, never a silent no-op). Backed by `arc nats revoke-federated-user`.
   * OPTIONAL — the revoke operator branch requires it.
   */
  revokeScopedUser?(input: {
    hubFedAccount: string;
    natsUser: string;
    networkId: string;
  }): Promise<
    | { ok: true; revokedPubKey: string }
    | { ok: false; reason: string; code?: "ARC_TOO_OLD" | "USER_NOT_FOUND" | "PUSH_FAILED" | "OTHER" }
  >;
}

/** The full port bundle the orchestrator depends on. */
export interface NetworkSecretPorts {
  hub: HubAuthPort;
  admission: AdmissionLookupPort;
  delivery: SealDeliveryPort;
  crypto: SecretCrypto;
  /** cortex#1481 — the hub-locality read the orchestrator gates the hub write on. */
  hubLocality: HubLocalityPort;
  /**
   * cortex#1598 — OPTIONAL scoped-user mint (operator-mode hubs only). Absent on
   * the simple/PSK path and in every per-member fake; the operator branch of
   * `addOrRotate` requires it and fails clearly when it is missing.
   */
  scopedMint?: ScopedUserMintPort;
}

// ===========================================================================
// C-1349 Slice 2 — network-wide payload-key (K) rotation ports.
//
// `rotate-key` is network-WIDE (mint K′ → re-seal EVERY ADMITTED member with
// leaf_psk UNCHANGED + payload_key=K′ + bumped kid → advance the hub K store),
// so it needs three seams the per-member add/rotate/revoke orchestrator does
// not: enumerate ADMITTED rows, mint K, and read/write the hub STACK config's
// `payload_key`. It gets its OWN port bundle so the per-member ports (and their
// fakes) stay untouched.
// ===========================================================================

/** One ADMITTED admission row, the unit `rotate-key` re-seals K′ to. */
export interface AdmittedMember {
  request_id: string;
  /** The member's principal id — the DEFAULT hub leaf-user (add-member default). */
  principal_id: string;
  /** The member's registered ed25519 pubkey (base64) — the seal target. */
  peer_pubkey: string;
}

/** Enumerate EVERY ADMITTED admission row for a network (admin read). */
export interface AdmittedListPort {
  /**
   * List every ADMITTED row for `networkId` (never PENDING/REVOKED/DEPARTED/
   * REJECTED — the whole point post-eviction). Same admin-signed read the
   * `admit --list-pending` path uses; ADR-0020 scopes reads to GLOBAL admins,
   * so a per-network admin may 403 (surfaced readably, never a silent empty).
   */
  listAdmittedRows(networkId: string): Promise<AdmittedMember[]>;
}

/**
 * Read/write the HUB STACK's own cortex config `policy.federated.networks[]` —
 * the K store the encryption runtime reads (`networkKeyFromConfig`). `rotate-key`
 * advances the target network's `payload_key` + `payload_key_id` here, via the
 * SAME offer.ts write-guard Slice 1 added (`writeNetworksGuarded`).
 */
export interface HubKeyStorePort {
  readNetworks(): Promise<import("../../../common/types/cortex-config").PolicyFederatedNetwork[]>;
  writeNetworks(
    networks: readonly import("../../../common/types/cortex-config").PolicyFederatedNetwork[],
  ): Promise<void>;
  /** The hub stack config path, for plan/report output. */
  readonly configPath: string;
}

/** K minting + sealing for network-wide rotation. Injected for determinism. */
export interface KeyRotationCrypto {
  /** Mint a fresh 32-byte payload key K′ (raw bytes; base64-encoded at the edges). */
  mintPayloadKey(): Uint8Array;
  /** Seal `plaintext` to `recipientPubkeyB64` (crypto_box_seal). */
  seal(plaintext: string, recipientPubkeyB64: string): Promise<string>;
}

/** The full port bundle `rotate-key` depends on. */
export interface NetworkKeyRotationPorts {
  /** Read the hub nats-server config text (to recover each member's leaf PSK). */
  readHubConf(): Promise<string>;
  admission: AdmittedListPort;
  /** Reuses the per-member sealed-blob POST (`postSealedSecret`). */
  delivery: SealDeliveryPort;
  crypto: KeyRotationCrypto;
  keyStore: HubKeyStorePort;
}
