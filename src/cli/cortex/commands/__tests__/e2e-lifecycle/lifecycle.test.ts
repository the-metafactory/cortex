/**
 * C-1355 — E2E lifecycle integration guard.
 *
 * A scripted register → admit → seal → join → revoke → leave walkthrough driven
 * against a LOCAL in-process registry (`src/services/network-registry`) and
 * temp-dir config trees. Every mid-funnel breakage in the admission epic (#832,
 * #1262, #1220, #1316, #1317) was found by a HUMAN walking the SOP; nothing in CI
 * exercised the lifecycle AS A SEQUENCE. This suite is that guard, and the epic's
 * progress meter: steps gated on unmerged sub-issues are `todo(...)` named
 * with their issue number; each fix PR flips its todo to live.
 *
 * WHAT IS REAL vs STUBBED (see README.md in this dir for the full matrix):
 *   - REAL:  the registry Hono app + in-memory store; the CLI dispatch paths
 *            (`dispatchStack` / `dispatchNetwork` / `dispatchProvisionStack`);
 *            the `runNetworkSecret` orchestrator; real Ed25519 seeds + real
 *            crypto_box seal; the REAL boot config validator (`CortexConfigSchema`).
 *   - STUBBED: the hub-reload port (multi-nats SIGHUP — #1317's seam) and the
 *            daemon-restart (not invoked; the join writer is asserted at the
 *            derivation→validation seam, per #1220's own ask).
 *   - NEVER:  a real NATS server, Cloudflare, D1, or any network I/O.
 *
 * The two REGRESSION ANCHORS this pins hard:
 *   - #1262: a registered principal with NO PENDING admission row (silent-drop).
 *   - #1220: `network join` writing a peer-scoped `accept_subjects` entry that
 *            the REAL boot config validator rejects.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

import { dispatchStack } from "../../stack";
import { discoverStacks } from "../../stack-lib";
import { dispatchNetwork } from "../../network";
import { dispatchProvisionStack } from "../../provision-stack";
import { runNetworkSecret } from "../../network-secret-lib";
import { buildLiveSecretPorts } from "../../network-secret-adapters";
import { fetchSealedLeafSecret } from "../../../../../common/registry/fetch-sealed-secret";
import type { NetworkSecretPorts } from "../../network-secret-ports";
import { leaveNetwork } from "../../network-lib";

import { deriveAcceptSubjects } from "../../../../../bus/agent-network/accept-subjects";
import {
  materialFromSeedString,
  type StackIdentityMaterial,
} from "../../../../../bus/stack-provisioning";
import {
  CortexConfigSchema,
  PolicyFederatedNetworkSchema,
} from "../../../../../common/types/cortex-config";
import { hubLeafUserPresent } from "../../../../../common/nats/hub-leaf-authorization";
import {
  getStore,
  getIssuanceStore,
} from "../../../../../services/network-registry/src/store";

import {
  REGISTRY_BASE,
  type Env,
  makeRegistryEnv,
  resetRegistry,
  installRegistryFetchRouter,
  makeRecordingHubPort,
  type RecordingHubPort,
  makeLeaveNetworkPorts,
  type LeavePortsHandle,
  freshDir,
  cleanupDirs,
} from "./harness";

// The network + identities the walkthrough operates on.
const NETWORK_ID = "testnet";
const ADMIN_PRINCIPAL = "netadmin";
const JOINER_PRINCIPAL = "joiner";
const JOINER_STACK_SLUG = "work";
const JOINER_STACK_ID = `${JOINER_PRINCIPAL}/${JOINER_STACK_SLUG}`;

interface Ctx {
  env: Env;
  restoreFetch: () => void;
  adminSeedPath: string;
  adminPubkey: string;
  adminMaterial: StackIdentityMaterial;
  adminConfigDir: string;
  joinerConfigDir: string;
  joinerSeedPath: string;
  joinerPubkey: string;
  requestId?: string;
  hub?: RecordingHubPort;
  secretPorts?: NetworkSecretPorts;
  leave?: LeavePortsHandle;
}

const ctx = {} as Ctx;

/**
 * bun accepts `todo("name")` at runtime (the suite reports these as todo),
 * but the bundled bun-types signature wants a body fn, so `tsc --noEmit` flags a
 * bare label. This cast keeps the correct single-arg runtime form type-clean.
 */
const todo = test.todo as unknown as (name: string) => void;

/** Read `pubkey_b64` out of a `provision-stack generate --json` envelope. */
function pubkeyFromGenerate(stdout: string): string {
  const data = (JSON.parse(stdout) as { data?: { pubkey_b64?: string } }).data;
  const pk = data?.pubkey_b64;
  if (typeof pk !== "string" || pk.length === 0) {
    throw new Error(`provision-stack generate --json produced no pubkey_b64: ${stdout}`);
  }
  return pk;
}

beforeAll(async () => {
  resetRegistry();

  // --- Mint the ADMIN identity (network admin + hub admin + registry admin —
  //     the Q5 authority collapse; one seed drives create + admit + seal + revoke).
  ctx.adminConfigDir = freshDir("c1355-admin-cfg-");
  ctx.joinerConfigDir = freshDir("c1355-joiner-cfg-");
  ctx.adminSeedPath = join(freshDir("c1355-admin-seed-"), "admin.nk");
  const adminGen = await dispatchProvisionStack([
    "generate",
    ADMIN_PRINCIPAL,
    "--seed-path",
    ctx.adminSeedPath,
    "--stack-id",
    `${ADMIN_PRINCIPAL}/hub`,
    "--json",
  ]);
  expect(adminGen.exitCode).toBe(0);
  ctx.adminPubkey = pubkeyFromGenerate(adminGen.stdout);
  ctx.adminMaterial = materialFromSeedString(readFileSync(ctx.adminSeedPath, "utf-8").trim());
  expect(ctx.adminMaterial.pubkeyB64).toBe(ctx.adminPubkey);

  // --- Registry env, now that we know the admin pubkey, + the fetch router.
  ctx.env = await makeRegistryEnv([ctx.adminPubkey]);
  ctx.restoreFetch = installRegistryFetchRouter(ctx.env);

  // --- Mint the JOINER stack identity (the member that registers/joins).
  ctx.joinerSeedPath = join(freshDir("c1355-joiner-seed-"), "joiner.nk");
  const joinerGen = await dispatchProvisionStack([
    "generate",
    JOINER_PRINCIPAL,
    "--seed-path",
    ctx.joinerSeedPath,
    "--stack-id",
    JOINER_STACK_ID,
    "--json",
  ]);
  expect(joinerGen.exitCode).toBe(0);
  ctx.joinerPubkey = pubkeyFromGenerate(joinerGen.stdout);
});

afterAll(() => {
  ctx.restoreFetch?.();
  cleanupDirs();
  resetRegistry();
});

describe("C-1355 — E2E admission lifecycle guard", () => {
  // ===========================================================================
  // Step 1 — Stand up: two stacks in temp config dirs, born-aligned, no drift.
  // ===========================================================================
  test("step 1: stack create (admin-side + joiner-side) → born-aligned, no drift", async () => {
    const admin = await dispatchStack([
      "create",
      "hub",
      "--principal",
      ADMIN_PRINCIPAL,
      "--config-dir",
      ctx.adminConfigDir,
      "--apply",
    ]);
    expect(admin.exitCode).toBe(0);

    const joiner = await dispatchStack([
      "create",
      JOINER_STACK_SLUG,
      "--principal",
      JOINER_PRINCIPAL,
      "--config-dir",
      ctx.joinerConfigDir,
      "--apply",
    ]);
    expect(joiner.exitCode).toBe(0);

    // Born-aligned: the dir basename == the slug == the stack.id trailing segment,
    // so `discoverStacks` reports every discovered stack as aligned (no drift).
    const adminStacks = discoverStacks(ctx.adminConfigDir);
    const joinerStacks = discoverStacks(ctx.joinerConfigDir);
    expect(adminStacks.length).toBeGreaterThanOrEqual(1);
    expect(joinerStacks.length).toBeGreaterThanOrEqual(1);
    expect(adminStacks.every((s) => s.aligned === true)).toBe(true);
    expect(joinerStacks.every((s) => s.aligned === true)).toBe(true);
    expect(joinerStacks.some((s) => s.stackId === JOINER_STACK_ID)).toBe(true);
  });

  // ===========================================================================
  // Step 2 — Network: create testnet against the in-process registry.
  // ===========================================================================
  test("step 2: network create → NetworkRecord row incl. admin_pubkeys", async () => {
    const res = await dispatchNetwork([
      "create",
      NETWORK_ID,
      "--hub",
      "tls://127.0.0.1:17422",
      "--leaf-port",
      "17422",
      "--admin-seed",
      ctx.adminSeedPath,
      "--network-admins",
      ctx.adminPubkey,
      "--registry-url",
      REGISTRY_BASE,
      "--apply",
    ]);
    expect(res.exitCode).toBe(0);

    const record = await getStore(ctx.env).getNetwork(NETWORK_ID);
    expect(record).toBeDefined();
    expect(record!.hub_url).toBe("tls://127.0.0.1:17422");
    expect(record!.leaf_port).toBe(17422);
    // #1321 — the per-network admin allowlist (comma-separated base64 pubkeys).
    expect(record!.admin_pubkeys ?? "").toContain(ctx.adminPubkey);
  });

  // ===========================================================================
  // Step 3 — Register: the #1262 regression anchor.
  //   A registered principal MUST leave a PENDING admission row. In #1262 a
  //   principal landed in the registry with NO PENDING row, so the admin saw
  //   nothing to admit; the issue flags register + raise-admission-request as
  //   separate steps and leaves the exact cause open (asking whether
  //   `register --network` is meant to auto-raise). This guard pins the intended
  //   outcome — register --network yields exactly one PENDING row.
  // ===========================================================================
  test("step 3: register joiner --network testnet → PENDING admission row EXISTS (#1262)", async () => {
    const res = await dispatchProvisionStack([
      "register",
      JOINER_PRINCIPAL,
      "--seed-path",
      ctx.joinerSeedPath,
      "--stack-id",
      JOINER_STACK_ID,
      "--registry-url",
      REGISTRY_BASE,
      "--network",
      NETWORK_ID,
      "--json",
    ]);
    expect(res.exitCode).toBe(0);

    // The principal record landed AND a PENDING admission row was created.
    const pending = await getIssuanceStore(ctx.env).listIssuanceRequests("PENDING");
    const mine = pending.filter((r) => r.peer_pubkey === ctx.joinerPubkey);
    // HARD #1262 ASSERTION: exactly one PENDING row for this member, not zero.
    expect(mine.length).toBe(1);
    expect(mine[0]!.status).toBe("PENDING");
    expect(mine[0]!.network_id).toBe(NETWORK_ID);
    expect(mine[0]!.principal_id).toBe(JOINER_PRINCIPAL);

    ctx.requestId = mine[0]!.request_id;
    expect(ctx.requestId).toBeTruthy();
  });

  // #1315 — the register CLI should print the admission request-id back to the
  // registrant so they can quote it. The ROW existing is asserted above (live);
  // surfacing the id in the CLI OUTPUT lands with #1315.
  todo(
    "step 3b (#1315): register CLI output surfaces the admission request-id to the registrant",
  );

  // ===========================================================================
  // Step 4 — Decide: admit the PENDING request → ADMITTED.
  // ===========================================================================
  test("step 4: network admit <request-id> --apply → row ADMITTED", async () => {
    expect(ctx.requestId).toBeDefined();
    const res = await dispatchNetwork([
      "admit",
      ctx.requestId!,
      "--admin-seed",
      ctx.adminSeedPath,
      "--registry-url",
      REGISTRY_BASE,
      "--apply",
      "--json",
    ]);
    expect(res.exitCode).toBe(0);

    const row = await getIssuanceStore(ctx.env).getIssuanceRequest(ctx.requestId!);
    expect(row?.status).toBe("ADMITTED");
  });

  // #1314 — `network admit --list-pending` shows the row before the decision.
  todo("step 4a (#1314): network admit --list-pending shows the PENDING row");
  // #1348 — the reject verb: a second registration rejected → REJECTED.
  todo("step 4b (#1348): network reject <id> on a second registration → row REJECTED");
  // #1350 S1 — the depart motion: a member's own `leave --apply` exits the roster.
  todo("step 4c (#1350 S1): member depart — leave exits the roster (ADMITTED→DEPARTED)");

  // ===========================================================================
  // Step 5 — Seal: mint the per-member leaf PSK, seal it to the member, and
  //   deliver the opaque blob onto the ADMITTED row. The hub-reload port is
  //   STUBBED (multi-nats reload = #1317); we assert it is EXERCISED and that the
  //   sealed blob lands on the registry row.
  // ===========================================================================
  test("step 5: network secret add-member --apply (hub reload STUBBED) → sealed blob on the row", async () => {
    expect(ctx.requestId).toBeDefined();
    ctx.hub = makeRecordingHubPort("");
    // Real admission/delivery/crypto ports (against the in-process registry via
    // the routed fetch), with ONLY the hub-reload port swapped for the recorder.
    const live = buildLiveSecretPorts({
      hubConfigPath: "<unused — hub port overridden below>",
      registryUrl: REGISTRY_BASE,
      material: ctx.adminMaterial,
      fetchImpl: globalThis.fetch,
    });
    ctx.secretPorts = { ...live, hub: ctx.hub };

    const report = await runNetworkSecret(
      {
        action: "add-member",
        networkId: NETWORK_ID,
        memberPubkey: ctx.joinerPubkey,
        deliver: "sealed",
        apply: true,
      },
      ctx.secretPorts,
    );
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);

    // The stubbed hub-reload port was exercised (write + reload).
    expect(ctx.hub.writes.length).toBeGreaterThanOrEqual(1);
    expect(ctx.hub.reloads).toBeGreaterThanOrEqual(1);
    // The member's leaf authorization user is present in the (stubbed) hub conf.
    expect(hubLeafUserPresent(ctx.hub.conf, JOINER_PRINCIPAL)).toBe(true);

    // The opaque sealed blob is present on the ADMITTED registry row.
    const row = await getIssuanceStore(ctx.env).getIssuanceRequest(ctx.requestId!);
    expect(row?.status).toBe("ADMITTED");
    expect(typeof row?.sealed_secret).toBe("string");
    expect((row?.sealed_secret ?? "").length).toBeGreaterThan(0);
  });

  // #1316 — the admit-and-seal FOLD: `network admit --and-seal` does step 4 + step
  // 5 in one privileged move (today they are two commands, driven separately above).
  todo("step 5a (#1316): network admit --and-seal folds admit + secret add-member");
  // #1349 S1 — the M3 payload key K rides the SAME sealed blob: add-member seals
  // payload_key, join installs it. Flipped LIVE with the Slice 1 merge.
  test("step 5b (#1349 S1): sealed K delivery — add-member seals payload_key, joiner unseals it", async () => {
    expect(ctx.requestId).toBeDefined();
    expect(ctx.secretPorts).toBeDefined();
    // Clearly-FAKE 32-byte K (all-0x07) — never realistic key material.
    const K = Buffer.alloc(32, 7).toString("base64");
    const KID = `${NETWORK_ID}/k1`;

    // add-member is idempotent on the ADMITTED row — re-seal WITH the payload key.
    const report = await runNetworkSecret(
      {
        action: "add-member",
        networkId: NETWORK_ID,
        memberPubkey: ctx.joinerPubkey,
        deliver: "sealed",
        apply: true,
        payloadKey: K,
        payloadKeyKid: KID,
      },
      ctx.secretPorts!,
    );
    expect(report.ok).toBe(true);
    // K is NEVER printed — only the kid + a fingerprint reach the report.
    expect(report.steps.join("\n")).not.toContain(K);
    expect(JSON.stringify(report.data)).not.toContain(K);
    expect(report.data.payload_key_kid).toBe(KID);
    expect(report.data.payload_key_fingerprint).toBeDefined();

    // The joiner fetches + unseals the blob from the in-process registry and
    // recovers K + kid — the end-to-end sealed-delivery path.
    const joinerMaterial = materialFromSeedString(readFileSync(ctx.joinerSeedPath, "utf-8"));
    const res = await fetchSealedLeafSecret({
      registryUrl: REGISTRY_BASE,
      networkId: NETWORK_ID,
      principalId: JOINER_PRINCIPAL,
      material: joinerMaterial,
      fetchImpl: globalThis.fetch,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.payloadKey).toBe(K);
      expect(res.payloadKeyKid).toBe(KID);
    }
  });

  // ===========================================================================
  // Step 6 — Join: the #1220 regression anchor.
  //   `network join` renders a stack's `accept_subjects` from its own identity ∪
  //   its roster peers (deriveAcceptSubjects). Those subjects MUST pass the SAME
  //   full config validation the daemon runs at boot (CortexConfigSchema). #1220:
  //   join wrote a PEER-scoped subject (federated.andreas.meta-factory.agent.>)
  //   into jc/default, which the validator rejects (accept_subjects must begin
  //   with the receiving stack's OWN federated.{me}.{stack}. scope), failing boot.
  // ===========================================================================
  describe("step 6: join-rendered accept_subjects vs the REAL boot config validator (#1220)", () => {
    // No `stack:` block → deriveStackId resolves `${principal}/default`, so the
    // receiving scope is `federated.joiner.default.` — exactly jc/default's case.
    const self = { principal: JOINER_PRINCIPAL, stack: "default" };

    function federatedConfig(acceptSubjects: string[]): unknown {
      return {
        principal: { id: JOINER_PRINCIPAL },
        agents: [
          {
            id: "luna",
            displayName: "Luna",
            persona: "./personas/luna.md",
            presence: {
              discord: {
                token: "discord-bot-token",
                guildId: "1487000000000000000",
                agentChannelId: "1487000000000000001",
                logChannelId: "1487000000000000002",
              },
            },
          },
        ],
        claude: {},
        policy: {
          federated: {
            networks: [
              {
                id: NETWORK_ID,
                leaf_node: NETWORK_ID,
                accept_subjects: acceptSubjects,
                max_hop: 5,
              },
            ],
          },
        },
      };
    }

    test("own-only accept_subjects (zero-peer join) PASS full config load (LIVE)", () => {
      const accept = deriveAcceptSubjects(self, []);
      expect(accept).toEqual(["federated.joiner.default.>"]);
      const parsed = CortexConfigSchema.safeParse(federatedConfig(accept));
      expect(parsed.success).toBe(true);
    });

    test("HARD #1220 assertion: a join-derived PEER subtree is REJECTED by the real config validator", () => {
      // The join derivation adds the peer PRESENCE subtree — the exact string that
      // broke jc/default's boot (issue #1220).
      const derived = deriveAcceptSubjects(self, [
        { principal: "andreas", stack: "meta-factory" },
      ]);
      expect(derived).toContain("federated.andreas.meta-factory.agent.>");

      const parsed = CortexConfigSchema.safeParse(federatedConfig(derived));
      // Current (buggy) behaviour: the peer-scoped subject fails the own-scope rule.
      expect(parsed.success).toBe(false);
      const issues = parsed.success ? "" : JSON.stringify(parsed.error.issues);
      expect(issues).toContain("accept_subjects");
    });

    // When #1220 is fixed (the join writer emits only own-scoped subjects), the
    // WHOLE join output must pass full config load. Flip this to live then, and
    // update the HARD assertion above (which documents the pre-fix failure).
    todo(
      "step 6 (#1220 fix): full join output (own ∪ peers) passes CortexConfigSchema",
    );
  });

  // ===========================================================================
  // Step 7 — Revoke: cut the member. Row → REVOKED, sealed blob cleared, hub
  //   authorization user dropped (transport CUT) via the stubbed reload.
  // ===========================================================================
  test("step 7: network secret revoke-member --apply → REVOKED, blob cleared, hub user dropped", async () => {
    expect(ctx.secretPorts).toBeDefined();
    const reloadsBefore = ctx.hub!.reloads;

    const report = await runNetworkSecret(
      {
        action: "revoke-member",
        networkId: NETWORK_ID,
        memberPubkey: ctx.joinerPubkey,
        deliver: "sealed",
        apply: true,
      },
      ctx.secretPorts!,
    );
    expect(report.ok).toBe(true);
    expect(report.applied).toBe(true);

    // Hub transport cut: the leaf authorization user is gone + a reload happened.
    expect(hubLeafUserPresent(ctx.hub!.conf, JOINER_PRINCIPAL)).toBe(false);
    expect(ctx.hub!.reloads).toBeGreaterThan(reloadsBefore);

    // Registry row REVOKED and the sealed blob cleared.
    const row = await getIssuanceStore(ctx.env).getIssuanceRequest(ctx.requestId!);
    expect(row?.status).toBe("REVOKED");
    expect(row?.sealed_secret).toBeNull();
  });

  // #1349 S2 — key rotation re-seals a fresh K' to every ADMITTED member (and
  // NEVER to a REVOKED/DEPARTED row), bumping the kid.
  todo("step 7b (#1349 S2): rotate-key re-seals K' to every ADMITTED member (never REVOKED/DEPARTED)");

  // ===========================================================================
  // Step 8 — Leave: joiner tears down its local federation wiring.
  //   Drives the REAL `leaveNetwork` orchestrator over an in-memory config store
  //   seeded with the joined network, with the daemon-restart adapter STUBBED
  //   (the seam the issue calls out — no launchctl, no nats-server). Own-scoped
  //   accept_subjects here (a valid zero-peer join; the #1220-invalid peer form is
  //   pinned separately in step 6). Asserts: config cleaned, leaf teardown,
  //   daemon restarted, roster no longer lists the network.
  // ===========================================================================
  test("step 8: network leave --apply → config cleaned + leaf torn down + daemon restarted (stubbed)", async () => {
    const joined = PolicyFederatedNetworkSchema.parse({
      id: NETWORK_ID,
      leaf_node: NETWORK_ID,
      accept_subjects: [`federated.${JOINER_PRINCIPAL}.default.>`],
      max_hop: 5,
    });
    ctx.leave = makeLeaveNetworkPorts([joined]);

    const res = await leaveNetwork(NETWORK_ID, ctx.leave.ports);
    expect(res.ok).toBe(true);
    expect(res.notJoined ?? false).toBe(false);
    // policy.federated.networks[] rewritten WITHOUT testnet.
    expect(ctx.leave.writes.length).toBe(1);
    expect(ctx.leave.writes[0]).toEqual([]);
    expect(ctx.leave.current()).toEqual([]);
    // Leaf include directive + file torn down for the network.
    expect(ctx.leave.removedIncludes).toContain(NETWORK_ID);
    expect(ctx.leave.removedFiles).toContain(NETWORK_ID);
    // Daemon restarted exactly once (the stubbed launchctl kickstart).
    expect(ctx.leave.counters.restarts).toBe(1);
    // Roster (remaining) no longer lists the network.
    expect(res.remaining ?? []).not.toContain(NETWORK_ID);
  });

  // ===========================================================================
  // Step 9 — Idempotence sweep: re-running leave AND revoke are clean no-ops.
  // ===========================================================================
  test("step 9a: idempotence — re-run network leave is a clean no-op (not-joined, no write/restart)", async () => {
    expect(ctx.leave).toBeDefined();
    const writesBefore = ctx.leave!.writes.length;
    const restartsBefore = ctx.leave!.counters.restarts;

    // The store is already empty from step 8 → leave short-circuits notJoined.
    const res = await leaveNetwork(NETWORK_ID, ctx.leave!.ports);
    expect(res.ok).toBe(true);
    expect(res.notJoined).toBe(true);
    // NOTHING mutated on the re-run.
    expect(ctx.leave!.writes.length).toBe(writesBefore);
    expect(ctx.leave!.counters.restarts).toBe(restartsBefore);
  });

  test("step 9b: idempotence — re-run revoke-member is a clean no-op (no hub write/reload, row unchanged)", async () => {
    expect(ctx.secretPorts).toBeDefined();
    const reloadsBefore = ctx.hub!.reloads;
    const writesBefore = ctx.hub!.writes.length;

    const report = await runNetworkSecret(
      {
        action: "revoke-member",
        networkId: NETWORK_ID,
        memberPubkey: ctx.joinerPubkey,
        deliver: "sealed",
        apply: true,
      },
      ctx.secretPorts!,
    );
    // No ADMITTED row remains → the orchestrator refuses with "nothing to revoke"
    // and mutates NOTHING (idempotent no-op).
    expect(report.applied).toBe(false);
    expect(report.reason ?? "").toContain("nothing to revoke");
    expect(ctx.hub!.reloads).toBe(reloadsBefore);
    expect(ctx.hub!.writes.length).toBe(writesBefore);

    const row = await getIssuanceStore(ctx.env).getIssuanceRequest(ctx.requestId!);
    expect(row?.status).toBe("REVOKED");
  });

  // #1351 S2 — stack retirement tombstones the stack: `provision-stack retire`
  // returns 409 while ADMITTED rows still reference it, then tombstones once clear.
  todo("step 10 (#1351 S2): provision-stack retire tombstones the stack (409 while ADMITTED rows live)");
});
