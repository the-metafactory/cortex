/**
 * F-3b (cortex#659): MyelinRuntime LinkPool tests — reworked for ADR 0001
 * (supersedes cortex#661).
 *
 * The runtime backs EVERY publish/subscribe, so the back-compat invariant
 * is load-bearing: with ZERO per-network `nats:` configured, the pool has
 * ONLY the primary link and behaviour is byte-identical to the pre-F-3b
 * single-link runtime. These tests cover the design (`docs/design-multi-
 * network.md` §7) matrix, on the ADR 0001 grammar:
 *
 *   (a) zero networks → single primary link, publishes route to primary
 *       (back-compat proof). local.* is byte-identical pre/post ADR 0001.
 *   (a') ADR 0001: a federated envelope with NO network_id derives a valid
 *       `federated.{principal}.{stack}.…` subject (no throw) and rides primary
 *       in the zero-leaf pool.
 *   (b) a `federated.{target-principal}.{stack}.*` publish routes to the leaf
 *       hosting that target principal (per-link publish capture).
 *   (c) `local.*` / `public.*` always → primary even with leaves present.
 *   (d) `federated.{unknown-principal}.*` → routing error + NO publish.
 *   (e) per-link dedupe (the cortex#491 `boundByPattern` is per-link).
 *   (f) ADR 0001: emit↔route round-trip — `runtime.publish` of a federated
 *       envelope routes to the leaf hosting the TARGET PRINCIPAL (subject[1])
 *       via the derive path + `peers[]` topology resolution.
 *   (+) negative leakage (§5 cardinal): `federated.{B}.*` never on link A.
 *   (+) `stop()` drains + closes ALL pool links.
 *
 * ADR 0001 (supersedes cortex#661): federated subjects carry
 * `federated.{principal}.{stack}.…` (the TARGET principal — same identity
 * grammar as `local.*`); the network is NEVER on the wire. `selectLink` resolves
 * which leaf a target principal lives behind from `policy.federated.networks[].peers[]`,
 * so the network fixtures below declare `peers[]` and the explicit
 * `publishOnSubject` subjects address by target principal, not network id.
 *
 * Uses the `MyelinRuntimeOptions.connectImpl` fake-link seam — no real
 * `nats-server`. A PER-URL fake registry lets each test assert WHICH link
 * saw WHICH publish: `connectImpl` receives `ConnectionOptions.servers[0]`
 * (the url), so the fake routes by url to a distinct recording connection.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type {
  ConnectionOptions,
  MsgHdrs,
  NatsConnection,
  Status,
  Subscription,
} from "nats";
import type { AgentConfig } from "../../../common/types/config";
import type {
  PolicyFederatedNetwork,
  PolicyFederatedPeer,
} from "../../../common/types/cortex-config";
import { startMyelinRuntime, type RoutingError } from "../runtime";

function makeConfig(natsBlock: AgentConfig["nats"]): AgentConfig {
  return {
    agent: { name: "luna", displayName: "Luna" },
    nats: natsBlock,
  } as unknown as AgentConfig;
}

/** One fake NATS connection that records its own publishes + subscribes. */
function makeFakeConn() {
  const statusListeners = new Set<(s: Status | null) => void>();
  const subscribePatterns: string[] = [];
  const publishes: {
    subject: string;
    payload: string | Uint8Array;
    // RFC-0007 §6.3 (cortex#2016): the `Nats-Msg-Id` header the runtime
    // stamps for JetStream dedup, or undefined when no header rode the publish.
    msgId: string | undefined;
  }[] = [];

  const status = () =>
    (async function* () {
      const queue: (Status | null)[] = [];
      let waiter: ((s: Status | null) => void) | null = null;
      const listener = (s: Status | null) => {
        if (waiter) {
          const w = waiter;
          waiter = null;
          w(s);
        } else {
          queue.push(s);
        }
      };
      statusListeners.add(listener);
      try {
        while (true) {
          if (queue.length > 0) {
            const next = queue.shift()!;
            if (next === null) return;
            yield next;
            continue;
          }
          const next = await new Promise<Status | null>((r) => (waiter = r));
          if (next === null) return;
          yield next;
        }
      } finally {
        statusListeners.delete(listener);
      }
    })();

  const subscribe = mock((pattern: string) => {
    subscribePatterns.push(pattern);
    let iteratorResolve: (() => void) | null = null;
    const iteratorDone = new Promise<void>((r) => {
      iteratorResolve = r;
    });
    // eslint-disable-next-line require-yield
    const iterator = (async function* () {
      await iteratorDone;
    })();
    return {
      [Symbol.asyncIterator]: () => iterator,
      drain: mock(async () => {
        iteratorResolve?.();
      }),
      closed: Promise.resolve(),
    } as unknown as Subscription;
  });

  const drain = mock(async () => {
    for (const l of statusListeners) l(null);
  });

  const publish = mock(
    (
      subject: string,
      payload: string | Uint8Array,
      options?: { headers?: MsgHdrs },
    ) => {
      // `MsgHdrs.get` returns "" for an absent key; normalize to undefined so
      // the "no header" case is distinguishable from an empty-string id.
      const msgId = options?.headers?.get("Nats-Msg-Id") || undefined;
      publishes.push({ subject, payload, msgId });
    },
  );

  const nc = { status, subscribe, drain, publish } as unknown as NatsConnection;
  return { nc, subscribe, subscribePatterns, publishes, publish, drain };
}

/**
 * A per-URL fake registry. `connectImpl` branches on the connect url so
 * each physical link gets its own recording connection — the test then
 * asserts which url (i.e. which link) saw which publish.
 */
function makeFakeRegistry() {
  const byUrl = new Map<string, ReturnType<typeof makeFakeConn>>();
  const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
    const url = (opts.servers as string[])[0] ?? "<no-url>";
    let conn = byUrl.get(url);
    if (!conn) {
      conn = makeFakeConn();
      byUrl.set(url, conn);
    }
    return conn.nc;
  };
  return {
    connectImpl,
    /** Fetch the recording connection for a url (created on connect). */
    forUrl: (url: string) => byUrl.get(url),
    byUrl,
  };
}

const PRIMARY_URL = "nats://localhost:4222";
const RESEARCH_URL = "nats://research:4222";
const JV_URL = "nats://jv:4222";

/**
 * A federated peer fixture — a remote principal reachable on a network. ADR
 * 0001 routes by TARGET PRINCIPAL, so the peer's `principal_id` is what
 * `selectLink` resolves to a leaf. `stack_id` / `principal_pubkey` are
 * structural-only here (routing doesn't crypto-verify).
 */
function makePeer(principalId: string): PolicyFederatedPeer {
  return {
    principal_id: principalId,
    stack_id: `${principalId}/home`,
    principal_pubkey: "U" + "A".repeat(55),
  };
}

/** Minimal valid `PolicyFederatedNetwork` fixture. */
function makeNetwork(
  overrides: Partial<PolicyFederatedNetwork>,
): PolicyFederatedNetwork {
  return {
    id: "research-collab",
    leaf_node: "nats-leaf-research",
    peers: [],
    accept_subjects: [],
    deny_subjects: [],
    announce_capabilities: [],
    max_hop: 0,
    ...overrides,
  };
}

/**
 * Federated envelope. ADR 0001 — the derived subject is
 * `federated.{principal-from-source}.{stack}.{type}`; the network is resolved
 * from the target principal at the routing layer, NOT carried on the wire.
 * `extensions.network_id` MAY still be set as a routing HINT but never affects
 * the subject. `targetPrincipal` overrides `source` so the derive-path tests can
 * address a specific peer principal.
 */
function makeEnvelope(
  overrides: Partial<{
    id: string;
    type: string;
    classification: string;
    /** The principal whose identity the subject carries (envelope.source[0]). */
    targetPrincipal: string;
  }> = {},
) {
  const principal = overrides.targetPrincipal ?? "metafactory";
  return {
    id: overrides.id ?? "11111111-1111-4111-8111-111111111111",
    source: `${principal}.grove.local`,
    type: overrides.type ?? "system.adapter.degraded",
    timestamp: "2026-06-04T12:00:00.000Z",
    sovereignty: {
      classification: (overrides.classification ?? "local") as
        | "local"
        | "federated"
        | "public",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any" as const,
    },
    payload: { adapter_id: "discord-luna" },
  };
}

describe("MyelinRuntime LinkPool (F-3b, cortex#659; ADR 0001)", () => {
  let logs: { kind: "log" | "info" | "warn" | "error"; msg: string }[];
  let restore: () => void;

  beforeEach(() => {
    logs = [];
    const o = {
      log: console.log,
      info: console.info,
      warn: console.warn,
      error: console.error,
    };
    console.log = (...a: unknown[]) => logs.push({ kind: "log", msg: a.map(String).join(" ") });
    console.info = (...a: unknown[]) => logs.push({ kind: "info", msg: a.map(String).join(" ") });
    console.warn = (...a: unknown[]) => logs.push({ kind: "warn", msg: a.map(String).join(" ") });
    console.error = (...a: unknown[]) => logs.push({ kind: "error", msg: a.map(String).join(" ") });
    restore = () => {
      console.log = o.log;
      console.info = o.info;
      console.warn = o.warn;
      console.error = o.error;
    };
  });
  afterEach(() => restore());

  // (a) BACK-COMPAT PROOF — zero per-network nats: ⇒ single primary link,
  //     all publishes route to it, byte-identical to today.
  test("(a) back-compat: zero federated networks ⇒ single primary link; all publishes route to primary", async () => {
    const reg = makeFakeRegistry();
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: ["local.{principal}.>"] }),
      { connectImpl: reg.connectImpl, stack: "default" },
      // NB: federatedNetworks omitted entirely.
    );
    expect(runtime.enabled).toBe(true);
    // Exactly ONE physical link was opened.
    expect(reg.byUrl.size).toBe(1);
    const primary = reg.forUrl(PRIMARY_URL)!;
    expect(primary).toBeDefined();

    // local.* publish → primary, with the SAME subject the pre-F-3b runtime
    // produced (`local.{principal-from-source}.{stack}.{type}`). BACK-COMPAT
    // PROOF: this assertion is byte-identical pre/post ADR 0001 — the
    // federated grammar change touches ONLY the federated.* branch.
    await runtime.publish(makeEnvelope({ type: "system.adapter.degraded" }));
    expect(primary.publishes.map((p) => p.subject)).toEqual([
      "local.metafactory.default.system.adapter.degraded",
    ]);

    // ADR 0001 — a federated envelope rides primary in the zero-leaf pool (the
    // `pool.size === 1` short-circuit in selectLink), and its subject carries
    // the SOURCE PRINCIPAL at segment[1] (same identity grammar as local.*),
    // NOT a network id. No routing error: the unknown-principal skip is a
    // multi-link-only concept.
    await runtime.publish(
      makeEnvelope({
        classification: "federated",
        type: "system.adapter.degraded",
      }),
    );
    expect(primary.publishes.map((p) => p.subject)).toEqual([
      "local.metafactory.default.system.adapter.degraded",
      "federated.metafactory.default.system.adapter.degraded",
    ]);
    // No routing error was logged in the back-compat case.
    expect(logs.some((l) => l.msg.includes("unknown_network_in_publish_subject"))).toBe(false);

    await runtime.stop();
  });

  // (g) RFC-0007 §6.3 / grill D12 (cortex#2016) — every runtime publish stamps
  //     the envelope id as the `Nats-Msg-Id` header so JetStream deduplicates a
  //     duplicated/retried publish within the stream's `duplicate_window`. The
  //     header rides the SAME single publish funnel every emit uses, so proving
  //     it on the primary link proves it for every stream-backed subject.
  test("(g) runtime.publish stamps Nats-Msg-Id = envelope.id on the wire (JetStream dedup, cortex#2016)", async () => {
    const reg = makeFakeRegistry();
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: ["local.{principal}.>"] }),
      { connectImpl: reg.connectImpl, stack: "default" },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;

    const id = "abcabcab-1111-4111-8111-abcabcabcabc";
    await runtime.publish(makeEnvelope({ id, type: "system.adapter.degraded" }));

    expect(primary.publishes).toHaveLength(1);
    // The dedup key is the envelope id verbatim.
    expect(primary.publishes[0]?.msgId).toBe(id);
    // Sanity: the id header rode the publish that carried the envelope subject.
    expect(primary.publishes[0]?.subject).toBe(
      "local.metafactory.default.system.adapter.degraded",
    );

    await runtime.stop();
  });

  // (a') ADR 0001 — a federated envelope with NO network_id is no longer an emit
  //      error: the network is not on the wire, so `deriveNatsSubject` derives a
  //      valid `federated.{principal}.{stack}.…` subject from `envelope.source`
  //      (identical to the local.* branch). In the zero-leaf pool it rides
  //      primary, no throw, no routing error.
  test("(a') ADR 0001: a federated envelope with NO network_id derives a valid subject and rides primary (no throw)", async () => {
    const reg = makeFakeRegistry();
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl: reg.connectImpl, stack: "default" },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;

    await runtime.publish(makeEnvelope({ classification: "federated" }));
    expect(primary.publishes.map((p) => p.subject)).toEqual([
      "federated.metafactory.default.system.adapter.degraded",
    ]);

    await runtime.stop();
  });

  // (b) federated.{target-principal}.* routes to the leaf hosting that principal.
  test("(b) federated.{target-principal}.* publish routes to the leaf hosting that principal", async () => {
    const reg = makeFakeRegistry();
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        peers: [makePeer("jcfischer")],
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    expect(runtime.enabled).toBe(true);
    // Two physical links: primary + the research leaf.
    expect(reg.byUrl.size).toBe(2);
    const primary = reg.forUrl(PRIMARY_URL)!;
    const research = reg.forUrl(RESEARCH_URL)!;

    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated", targetPrincipal: "jcfischer" }),
      "federated.jcfischer.host.system.adapter.degraded",
    );
    // Landed on the research leaf ONLY (jcfischer is a peer on research-collab).
    expect(research.publishes.map((p) => p.subject)).toEqual([
      "federated.jcfischer.host.system.adapter.degraded",
    ]);
    expect(primary.publishes).toEqual([]);

    await runtime.stop();
  });

  // (c) local.* / public.* always → primary even with leaves present.
  test("(c) local.* and public.* always route to primary even with leaf links present", async () => {
    const reg = makeFakeRegistry();
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        peers: [makePeer("jcfischer")],
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;
    const research = reg.forUrl(RESEARCH_URL)!;

    await runtime.publishOnSubject!(makeEnvelope(), "local.metafactory.system.x");
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "public" }),
      "public.system.x",
    );
    expect(primary.publishes.map((p) => p.subject)).toEqual([
      "local.metafactory.system.x",
      "public.system.x",
    ]);
    // The leaf saw NONE of it.
    expect(research.publishes).toEqual([]);

    await runtime.stop();
  });

  // (d) federated.{unknown-principal}.* → routing error + NO publish.
  test("(d) federated.{unknown-principal}.* emits routing error and does NOT publish (skip)", async () => {
    const reg = makeFakeRegistry();
    const routingErrors: RoutingError[] = [];
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        peers: [makePeer("jcfischer")],
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      {
        connectImpl: reg.connectImpl,
        federatedNetworks: networks,
        onRoutingError: (info) => routingErrors.push(info),
      },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;
    const research = reg.forUrl(RESEARCH_URL)!;

    // `nobody` is in no network's peers[] — unroutable target principal.
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated", id: "deadbeef-id" }),
      "federated.nobody.host.system.x",
    );

    // Routing error fired with the canonical reason; the unresolved target
    // principal is carried in the (legacy-named) `networkId` field; NOTHING
    // published.
    expect(routingErrors).toEqual([
      {
        reason: "unknown_network_in_publish_subject",
        subject: "federated.nobody.host.system.x",
        networkId: "nobody",
        envelopeId: "deadbeef-id",
      },
    ]);
    expect(primary.publishes).toEqual([]);
    expect(research.publishes).toEqual([]);

    await runtime.stop();
  });

  // (+) NEGATIVE LEAKAGE (§5 cardinal): a publish to a principal on leaf B
  //     never appears on leaf A.
  test("(+) negative leakage: a federated publish for a jv-network principal never appears on the research leaf", async () => {
    const reg = makeFakeRegistry();
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        peers: [makePeer("jcfischer")],
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
      makeNetwork({
        id: "jv",
        leaf_node: "nats-leaf-jv",
        peers: [makePeer("partner")],
        nats: { url: JV_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    expect(reg.byUrl.size).toBe(3); // primary + research + jv
    const research = reg.forUrl(RESEARCH_URL)!;
    const jv = reg.forUrl(JV_URL)!;

    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated", targetPrincipal: "partner" }),
      "federated.partner.host.system.x",
    );
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated", targetPrincipal: "jcfischer" }),
      "federated.jcfischer.host.system.y",
    );

    // partner traffic hit jv only; jcfischer traffic hit research only.
    expect(jv.publishes.map((p) => p.subject)).toEqual(["federated.partner.host.system.x"]);
    expect(research.publishes.map((p) => p.subject)).toEqual([
      "federated.jcfischer.host.system.y",
    ]);
    // CARDINAL: the partner (jv) subject never leaked onto the research leaf's wire.
    expect(research.publishes.some((p) => p.subject.startsWith("federated.partner."))).toBe(false);

    await runtime.stop();
  });

  // (+) two networks SHARING a leaf_node ⇒ ONE physical link (de-dup key).
  //     A peer on either network resolves to the SAME shared leaf.
  test("(+) two networks sharing a leaf_node share one physical leaf link", async () => {
    const reg = makeFakeRegistry();
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "shared-leaf",
        peers: [makePeer("jcfischer")],
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
      makeNetwork({
        id: "research-collab-2",
        leaf_node: "shared-leaf",
        peers: [makePeer("kestrel")],
        // Second declaration omits nats: (rides the first's link) — the
        // F-3a cross-validator guarantees consistency.
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    // primary + ONE shared leaf = 2 links (not 3).
    expect(reg.byUrl.size).toBe(2);
    const shared = reg.forUrl(RESEARCH_URL)!;

    // Both networks' peers route to the SAME leaf.
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated", targetPrincipal: "jcfischer" }),
      "federated.jcfischer.host.system.a",
    );
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated", targetPrincipal: "kestrel" }),
      "federated.kestrel.host.system.b",
    );
    expect(shared.publishes.map((p) => p.subject)).toEqual([
      "federated.jcfischer.host.system.a",
      "federated.kestrel.host.system.b",
    ]);

    await runtime.stop();
  });

  // (e) per-link dedupe — the cortex#491 boundByPattern is per-link
  //     (primary-bound in F-3b). A duplicate self-subscribe to a pattern a
  //     boot subscriber already bound returns the SAME subscriber.
  test("(e) per-link dedupe: duplicate primary subscribe returns the existing subscriber (no double-bind)", async () => {
    const reg = makeFakeRegistry();
    const runtime = await startMyelinRuntime(
      makeConfig({
        url: PRIMARY_URL,
        name: "cortex",
        subjects: ["local.metafactory.system.>"],
      }),
      { connectImpl: reg.connectImpl },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;
    // Boot subscribed once.
    expect(primary.subscribePatterns).toEqual(["local.metafactory.system.>"]);

    // Self-subscribe the SAME resolved pattern — must NOT create a second
    // NATS subscription (dedupe via the primary link's boundByPattern).
    const sub = await runtime.subscribe!("local.metafactory.system.>");
    expect(sub).not.toBeNull();
    expect(primary.subscribePatterns).toEqual(["local.metafactory.system.>"]);
    expect(
      logs.some((l) => l.msg.includes("skipping duplicate subscribe")),
    ).toBe(true);

    await runtime.stop();
  });

  // (f) EMIT↔ROUTE ROUND-TRIP (ADR 0001 — supersedes the cortex#661 asymmetry).
  //     `deriveNatsSubject` emits `federated.{principal}.{stack}.{type}` from
  //     `envelope.source` — segment[1] is the TARGET PRINCIPAL. `selectLink`
  //     resolves that principal to a leaf via `peers[]`. This test proves the
  //     derive path (`runtime.publish`, NOT publishOnSubject) for a federated
  //     envelope addressed to a peer principal routes to that peer's leaf —
  //     emit, selectLink, and the topology map agree on the identity, end to end.
  test("(f) EMIT↔ROUTE round-trip (ADR 0001): runtime.publish() of a federated envelope routes to the target principal's leaf via the derive path", async () => {
    const reg = makeFakeRegistry();
    const routingErrors: RoutingError[] = [];
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        peers: [makePeer("jcfischer")],
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      {
        connectImpl: reg.connectImpl,
        federatedNetworks: networks,
        stack: "default",
        onRoutingError: (info) => routingErrors.push(info),
      },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;
    const research = reg.forUrl(RESEARCH_URL)!;

    // DERIVE path: envelope addressed to peer `jcfischer` (source first segment)
    // → derived subject `federated.jcfischer.default.<type>` (segment[1] = target
    // principal). selectLink resolves jcfischer → research leaf via peers[].
    await runtime.publish(
      makeEnvelope({
        classification: "federated",
        id: "seam-adr1-id",
        targetPrincipal: "jcfischer",
      }),
    );

    // No routing error; the envelope lands on the research leaf ONLY (no leak).
    expect(routingErrors).toEqual([]);
    expect(research.publishes.map((p) => p.subject)).toEqual([
      "federated.jcfischer.default.system.adapter.degraded",
    ]);
    expect(primary.publishes).toEqual([]);

    await runtime.stop();
  });

  // (+) stop() drains + closes ALL pool links.
  test("(+) stop() drains and closes every pool link", async () => {
    const reg = makeFakeRegistry();
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        peers: [makePeer("jcfischer")],
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
      makeNetwork({
        id: "jv",
        leaf_node: "nats-leaf-jv",
        peers: [makePeer("partner")],
        nats: { url: JV_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl: reg.connectImpl, federatedNetworks: networks },
    );
    const primary = reg.forUrl(PRIMARY_URL)!;
    const research = reg.forUrl(RESEARCH_URL)!;
    const jv = reg.forUrl(JV_URL)!;

    await runtime.stop();

    // Each link's underlying connection was drained on close().
    expect(primary.drain).toHaveBeenCalled();
    expect(research.drain).toHaveBeenCalled();
    expect(jv.drain).toHaveBeenCalled();
  });

  // (+) a leaf that fails to connect at boot does NOT take the runtime down
  //     (degrade-don't-crash seam — full lifecycle is F-3c). Its hosted
  //     principals' publishes then resolve to the unknown/down skip.
  test("(+) leaf connect failure degrades (runtime stays enabled on primary); that network's publishes skip", async () => {
    const routingErrors: RoutingError[] = [];
    // A registry whose JV url throws on connect, but primary + research succeed.
    const byUrl = new Map<string, ReturnType<typeof makeFakeConn>>();
    const connectImpl = async (opts: ConnectionOptions): Promise<NatsConnection> => {
      const url = (opts.servers as string[])[0] ?? "";
      if (url === JV_URL) throw new Error("leaf down");
      let conn = byUrl.get(url);
      if (!conn) {
        conn = makeFakeConn();
        byUrl.set(url, conn);
      }
      return conn.nc;
    };
    const networks = [
      makeNetwork({
        id: "research-collab",
        leaf_node: "nats-leaf-research",
        peers: [makePeer("jcfischer")],
        nats: { url: RESEARCH_URL, name: "cortex" },
      }),
      makeNetwork({
        id: "jv",
        leaf_node: "nats-leaf-jv",
        peers: [makePeer("partner")],
        nats: { url: JV_URL, name: "cortex" },
      }),
    ];
    const runtime = await startMyelinRuntime(
      makeConfig({ url: PRIMARY_URL, name: "cortex", subjects: [] }),
      { connectImpl, federatedNetworks: networks, onRoutingError: (i) => routingErrors.push(i) },
    );
    // Primary up ⇒ runtime enabled despite the dead jv leaf.
    expect(runtime.enabled).toBe(true);
    expect(logs.some((l) => l.kind === "error" && l.msg.includes("nats-leaf-jv"))).toBe(true);

    const research = byUrl.get(RESEARCH_URL)!;
    // research-hosted principal still routes fine.
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated", targetPrincipal: "jcfischer" }),
      "federated.jcfischer.host.system.a",
    );
    expect(research.publishes.map((p) => p.subject)).toEqual([
      "federated.jcfischer.host.system.a",
    ]);
    // partner (jv-hosted) traffic skips — its leaf is down (link === null).
    await runtime.publishOnSubject!(
      makeEnvelope({ classification: "federated", targetPrincipal: "partner" }),
      "federated.partner.host.system.b",
    );
    expect(routingErrors.map((e) => e.networkId)).toEqual(["partner"]);

    await runtime.stop();
  });
});
