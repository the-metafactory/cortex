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
   * `request_id` + the member's `principal_id` (the leaf-user default), or
   * `undefined` when no ADMITTED row exists for that member+network.
   */
  findAdmittedRow(
    networkId: string,
    memberPubkey: string,
  ): Promise<{ request_id: string; principal_id: string } | undefined>;
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

/** The full port bundle the orchestrator depends on. */
export interface NetworkSecretPorts {
  hub: HubAuthPort;
  admission: AdmissionLookupPort;
  delivery: SealDeliveryPort;
  crypto: SecretCrypto;
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
