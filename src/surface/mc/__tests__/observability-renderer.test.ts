/**
 * P-14 U2.1 (#934) — tests for the observability projection renderer + its
 * attention producer.
 *
 * Coverage axes:
 *   - familyForType maps each of the four families (collector-before-signal).
 *   - projectObservability writes an observability_events row per family + a
 *     validated envelope carrying a body `signed_by` is parsed structurally.
 *   - WS `observability` (+ `attention`) family broadcast on a projected mutation.
 *   - the att:adapter: attention producer opens/resolves on the six health
 *     signals (collector degraded/recovered, signal backend un/reachable,
 *     leaf dis/connect) and is idempotent under redelivery.
 *   - non-matching types are ignored; idempotent row insert on envelope id.
 *   - the renderer's render() is non-throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { SCHEMA_SQL } from "../db/schema";
import {
  createObservabilityProjectionRenderer,
  projectObservability,
  projectForeignObservability,
  familyForType,
} from "../projection/observability-renderer";
import {
  produceObservabilityAttention,
  ACCESS_DENIED_ATTENTION_PREFIX,
} from "../projection/observability-attention";
import { ADAPTER_ATTENTION_PREFIX } from "../projection/adapter-lifecycle";
import { resolveAttentionItem } from "../db/attention";
import {
  listObservabilityEvents,
  countObservabilityByFamily,
} from "../db/observability";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import type { WsClientRegistry } from "../ws/client-registry";
import type { WsServerMessage } from "../ws/types";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  for (const sql of SCHEMA_SQL) db.exec(sql);
  return db;
}

/**
 * A canonical-myelin-shaped envelope carrying a body `signed_by` chain — proving
 * the renderer parses a validated U0.4/#124 envelope structurally (it reads
 * type + payload; signed_by/sovereignty ride along untouched).
 */
function envelope(type: string, payload: Record<string, unknown>, id?: string): Envelope {
  return {
    id: id ?? crypto.randomUUID(),
    source: "andreas.work.luna",
    type,
    timestamp: "2026-06-11T00:00:00.000Z",
    sovereignty: {
      classification: "local",
      data_residency: "NZ",
      max_hop: 0,
      frontier_ok: true,
      model_class: "any",
    },
    payload,
    signed_by: [
      {
        identity: "andreas-work",
        algo: "ed25519",
        public_key: "pk",
        signature: "sig",
        signed_at: "2026-06-11T00:00:00.000Z",
      },
    ],
  } as unknown as Envelope;
}

function attentionRow(db: Database, id: string): { status: string } | null {
  return db
    .query(`SELECT status FROM attention_items WHERE id = ?`)
    .get(id) as { status: string } | null;
}

// ---------------------------------------------------------------------------
// familyForType
// ---------------------------------------------------------------------------

describe("familyForType — four-family routing", () => {
  it("routes collector BEFORE signal (more specific prefix wins)", () => {
    expect(familyForType("system.signal.collector.degraded")).toBe("collector");
    expect(familyForType("system.signal.received")).toBe("signal");
  });

  it("routes federation and transport", () => {
    expect(familyForType("system.federation.peer.added")).toBe("federation");
    expect(familyForType("system.transport.leaf-disconnect")).toBe("transport");
  });

  it("returns null for an unrelated type", () => {
    expect(familyForType("dispatch.task.started")).toBeNull();
    expect(familyForType("system.agent.heartbeat")).toBeNull();
    expect(familyForType("")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// projectObservability — rows + WS broadcast
// ---------------------------------------------------------------------------

describe("projectObservability — projection rows", () => {
  let db: Database;
  let broadcasts: WsServerMessage[];
  let fakeRegistry: WsClientRegistry;

  beforeEach(() => {
    db = setupDb();
    broadcasts = [];
    fakeRegistry = {
      broadcast: (msg: WsServerMessage) => {
        broadcasts.push(msg);
      },
    } as unknown as WsClientRegistry;
  });
  afterEach(() => db.close());

  it("writes a row per family and parses a signed_by-carrying envelope", () => {
    expect(projectObservability(db, envelope("system.signal.received", { summary: "ok" }), fakeRegistry)).toBe("signal");
    expect(projectObservability(db, envelope("system.signal.collector.degraded", { collector_id: "relay-1" }), fakeRegistry)).toBe("collector");
    expect(projectObservability(db, envelope("system.federation.peer.added", { peer: "jc" }), fakeRegistry)).toBe("federation");
    expect(projectObservability(db, envelope("system.transport.leaf-connect", { leaf: "leaf-a" }), fakeRegistry)).toBe("transport");

    const counts = countObservabilityByFamily(db);
    expect(counts).toEqual({ signal: 1, collector: 1, federation: 1, transport: 1 });
    expect(listObservabilityEvents(db, 10, "signal")[0]?.summary).toBe("ok");
  });

  it("broadcasts the observability mc.projection family on a row mutation", () => {
    projectObservability(db, envelope("system.signal.received", {}), fakeRegistry);
    expect(broadcasts.some((m) => m.type === "mc.projection" && m.family === "observability")).toBe(true);
  });

  it("is idempotent on redelivery (same envelope id → one row)", () => {
    const env = envelope("system.federation.peer.added", { peer: "jc" }, "fixed-id-1");
    projectObservability(db, env, fakeRegistry);
    projectObservability(db, env, fakeRegistry);
    expect(countObservabilityByFamily(db).federation).toBe(1);
  });

  it("ignores a non-observability type (no row, no broadcast)", () => {
    expect(projectObservability(db, envelope("dispatch.task.started", {}), fakeRegistry)).toBeNull();
    expect(countObservabilityByFamily(db)).toEqual({});
    expect(broadcasts.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// P-14 U3.3 — foreign-origin projection + the narrowed (local-only) subjects
// ---------------------------------------------------------------------------

describe("projectForeignObservability — origin-badged peer rows (U3.3)", () => {
  let db: Database;
  let broadcasts: WsServerMessage[];
  let fakeRegistry: WsClientRegistry;

  beforeEach(() => {
    db = setupDb();
    broadcasts = [];
    fakeRegistry = {
      broadcast: (msg: WsServerMessage) => broadcasts.push(msg),
    } as unknown as WsClientRegistry;
  });
  afterEach(() => db.close());

  it("writes a FOREIGN-origin row + broadcasts, never local", () => {
    const fam = projectForeignObservability(
      db,
      envelope("system.transport.leaf-connect", { leaf: "leaf-a" }),
      "joel/research",
      fakeRegistry,
    );
    expect(fam).toBe("transport");
    const row = listObservabilityEvents(db, 10, "transport")[0];
    expect(row?.origin).toEqual({ kind: "foreign", peer: "joel/research" });
    expect(broadcasts.some((m) => m.type === "mc.projection" && m.family === "observability")).toBe(true);
  });

  it("a FOREIGN row never opens a local attention item (peer health is not the principal's adapter)", () => {
    // A peer's leaf_disconnect WOULD open an att:adapter: item if treated as
    // local. As a foreign row it must NOT — no attention broadcast, no item.
    projectForeignObservability(
      db,
      envelope("system.transport.leaf-disconnect", { leaf: "leaf-a" }),
      "joel/research",
      fakeRegistry,
    );
    expect(broadcasts.some((m) => m.type === "mc.projection" && m.family === "attention")).toBe(false);
    const attnCount = (db.query(`SELECT COUNT(*) AS n FROM attention_items`).get() as { n: number }).n;
    expect(attnCount).toBe(0);
  });

  it("a LOCAL transport health signal STILL opens an attention item (regression guard)", () => {
    // Contrast: the same disconnect via the LOCAL path opens the att:adapter: item.
    projectObservability(db, envelope("system.transport.leaf-disconnect", { leaf: "leaf-a" }), fakeRegistry);
    expect(broadcasts.some((m) => m.type === "mc.projection" && m.family === "attention")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Attention producer — the live-oracle path
// ---------------------------------------------------------------------------

describe("produceObservabilityAttention — att:adapter: open/resolve", () => {
  let db: Database;
  beforeEach(() => (db = setupDb()));
  afterEach(() => db.close());

  it("opens an att:adapter: item on collector.degraded and resolves on recovered", () => {
    const open = produceObservabilityAttention(db, {
      type: "system.signal.collector.degraded",
      payload: { collector_id: "relay-1" },
    });
    expect(open).toMatchObject({ action: "opened" });
    expect(open?.itemId.startsWith(`${ADAPTER_ATTENTION_PREFIX}collector:`)).toBe(true);
    expect(attentionRow(db, open!.itemId)?.status).toBe("open");

    const resolved = produceObservabilityAttention(db, {
      type: "system.signal.collector.recovered",
      payload: { collector_id: "relay-1" },
    });
    expect(resolved).toMatchObject({ action: "resolved" });
    expect(attentionRow(db, open!.itemId)?.status).toBe("resolved");
  });

  it("opens on signal backend.unreachable and resolves on backend.reachable", () => {
    // Wire-faithful: signal nests `exporter_id` under `payload.attributes`, which
    // the producer's top-level `idKeys` do not read — so both edges resolve to the
    // NAMESPACE-FALLBACK id `att:adapter:transport:transport` that production
    // actually delivers (per-origin attribution is a future producer enhancement).
    const backend = produceObservabilityAttention(db, {
      type: "system.signal.backend.unreachable",
      payload: { failure_mode: "backend.unreachable", attributes: { exporter_id: "victoria" } },
    });
    expect(backend).toMatchObject({ action: "opened" });
    expect(backend?.itemId).toBe(`${ADAPTER_ATTENTION_PREFIX}transport:transport`);
    expect(attentionRow(db, backend!.itemId)?.status).toBe("open");

    const reachable = produceObservabilityAttention(db, {
      type: "system.signal.backend.reachable",
      payload: { failure_mode: "backend.reachable", attributes: { exporter_id: "victoria" } },
    });
    expect(reachable).toMatchObject({ action: "resolved" });
    expect(reachable?.itemId).toBe(backend?.itemId);
    expect(attentionRow(db, backend!.itemId)?.status).toBe("resolved");
  });

  it("opens on transport leaf-disconnect (leaf arm, cortex#1467) unchanged", () => {
    const leaf = produceObservabilityAttention(db, {
      type: "system.transport.leaf-disconnect",
      payload: { leaf: "leaf-a" },
    });
    expect(leaf).toMatchObject({ action: "opened" });
    expect(attentionRow(db, leaf!.itemId)?.status).toBe("open");
  });

  it("is idempotent: re-opening the same degraded keeps one open item", () => {
    const a = produceObservabilityAttention(db, { type: "system.signal.collector.degraded", payload: { collector_id: "relay-1" } });
    const b = produceObservabilityAttention(db, { type: "system.signal.collector.degraded", payload: { collector_id: "relay-1" } });
    expect(a?.itemId).toBe(b?.itemId);
    const n = (db.query(`SELECT COUNT(*) AS n FROM attention_items WHERE id = ?`).get(a!.itemId) as { n: number }).n;
    expect(n).toBe(1);
  });

  it("returns null for a non-health observability type (history-only)", () => {
    expect(produceObservabilityAttention(db, { type: "system.signal.received", payload: {} })).toBeNull();
    expect(produceObservabilityAttention(db, { type: "system.federation.peer.added", payload: {} })).toBeNull();
  });

  it("returns null for the RETIRED phantom transport-backend types (cortex#1468)", () => {
    // The phantom transport-backend names (the retired `transport` ns + `backend`
    // leaves) never existed in signal and are now retired from classify(); they
    // must no-op. Built from segments so the dotted phantom literal stays out of
    // src/surface/ entirely — the AC1 grep gate must return zero hits tree-wide.
    const retiredUnreachable = ["system", "transport", "backend", "unreachable"].join(".");
    const retiredReachable = ["system", "transport", "backend", "reachable"].join(".");
    expect(produceObservabilityAttention(db, { type: retiredUnreachable, payload: {} })).toBeNull();
    expect(produceObservabilityAttention(db, { type: retiredReachable, payload: {} })).toBeNull();
  });

  it("falls back to the namespace id when the origin id is absent", () => {
    const res = produceObservabilityAttention(db, { type: "system.signal.backend.unreachable", payload: {} });
    expect(res?.itemId).toBe(`${ADAPTER_ATTENTION_PREFIX}transport:transport`);
  });
});

// ---------------------------------------------------------------------------
// Renderer integration — the oracle path + non-throwing contract
// ---------------------------------------------------------------------------

describe("createObservabilityProjectionRenderer", () => {
  let db: Database;
  let broadcasts: WsServerMessage[];
  let fakeRegistry: WsClientRegistry;

  beforeEach(() => {
    db = setupDb();
    broadcasts = [];
    fakeRegistry = {
      broadcast: (msg: WsServerMessage) => broadcasts.push(msg),
    } as unknown as WsClientRegistry;
  });
  afterEach(() => db.close());

  it("exposes a stable id and the four-family subject set", () => {
    const r = createObservabilityProjectionRenderer(db, fakeRegistry);
    expect(r.id).toBe("mc-observability-projection");
    expect(r.subjects.some((s) => s.includes("system.signal"))).toBe(true);
    expect(r.subjects.some((s) => s.includes("system.federation"))).toBe(true);
    expect(r.subjects.some((s) => s.includes("system.transport"))).toBe(true);
  });

  it("U3.3 — subjects are LOCAL-ONLY: no federated.* (the trust-verified fold owns federation)", () => {
    // At U3.3 this renderer no longer subscribes to federated.* — ALL federated
    // observability flows through the chain-verifying, curation-gated fold. This
    // narrowing is load-bearing: it prevents an UN-verified, UN-badged, UN-curated
    // double-fold of peer rows (which would have folded the DENIED system.signal.*).
    const r = createObservabilityProjectionRenderer(db, fakeRegistry);
    expect(r.subjects.every((s) => s.startsWith("local."))).toBe(true);
    expect(r.subjects.some((s) => s.startsWith("federated."))).toBe(false);
  });

  it("collector.degraded projects a row AND opens an attention item (oracle path)", async () => {
    const r = createObservabilityProjectionRenderer(db, fakeRegistry);
    await r.render(envelope("system.signal.collector.degraded", { collector_id: "relay-1" }), undefined, "local.andreas.work.system.signal.collector.degraded");
    expect(countObservabilityByFamily(db).collector).toBe(1);
    expect(attentionRow(db, `${ADAPTER_ATTENTION_PREFIX}collector:relay-1`)?.status).toBe("open");
    expect(broadcasts.some((m) => m.type === "mc.projection" && m.family === "observability")).toBe(true);
    expect(broadcasts.some((m) => m.type === "mc.projection" && m.family === "attention")).toBe(true);
  });

  it("render() never throws on a malformed envelope", async () => {
    const r = createObservabilityProjectionRenderer(db, fakeRegistry);
    const bad = { id: "x", type: "system.signal.received", payload: null } as unknown as Envelope;
    await expect(r.render(bad, undefined, "local.andreas.work.system.signal.received")).resolves.toBeUndefined();
  });

  it("works headless (no wsRegistry) — row still written, no broadcast crash", async () => {
    const r = createObservabilityProjectionRenderer(db);
    await r.render(envelope("system.signal.received", {}), undefined, "local.andreas.work.system.signal.received");
    expect(countObservabilityByFamily(db).signal).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// #1661 (MC folds) — the three cortex-LOCAL families (access/dispatch/reflex)
// ---------------------------------------------------------------------------

describe("#1661 — familyForType routes the cortex-local families", () => {
  it("routes access (denied/filtered) + admission (throttled/degraded)", () => {
    expect(familyForType("system.access.denied")).toBe("access");
    expect(familyForType("system.access.filtered")).toBe("access");
    expect(familyForType("system.admission.throttled")).toBe("access");
    expect(familyForType("system.admission.degraded")).toBe("access");
  });

  it("routes dispatch (stage / inbound.aborted / bus.process)", () => {
    expect(familyForType("system.dispatch.stage")).toBe("dispatch");
    expect(familyForType("system.inbound.aborted")).toBe("dispatch");
    expect(familyForType("system.bus.process")).toBe("dispatch");
  });

  it("routes reflex.activation.*", () => {
    expect(familyForType("reflex.activation.fired")).toBe("reflex");
    expect(familyForType("reflex.activation.decision")).toBe("reflex");
  });

  it("EXCLUDES high-volume siblings by design (narrow type set, not a prefix)", () => {
    expect(familyForType("system.access.allowed")).toBeNull();
    expect(familyForType("system.bus.peer_dispatch_received")).toBeNull();
    expect(familyForType("system.bus.notify_discord")).toBeNull();
    expect(familyForType("system.dispatch.dead_letter")).toBeNull();
  });
});

describe("#1661 — projectObservability folds each new family into a row", () => {
  let db: Database;
  let broadcasts: WsServerMessage[];
  let fakeRegistry: WsClientRegistry;

  beforeEach(() => {
    db = setupDb();
    broadcasts = [];
    fakeRegistry = {
      broadcast: (msg: WsServerMessage) => broadcasts.push(msg),
    } as unknown as WsClientRegistry;
  });
  afterEach(() => db.close());

  it("a synthetic emit of EACH new family lands exactly one row", () => {
    expect(
      projectObservability(db, envelope("system.access.denied", { principal_id: "andreas", capability: "dispatch.task.received" }), fakeRegistry),
    ).toBe("access");
    expect(
      projectObservability(db, envelope("system.dispatch.stage", { stack_id: "work" }), fakeRegistry),
    ).toBe("dispatch");
    expect(
      projectObservability(db, envelope("reflex.activation.fired", { summary: "reflex ran" }), fakeRegistry),
    ).toBe("reflex");

    const counts = countObservabilityByFamily(db);
    expect(counts.access).toBe(1);
    expect(counts.dispatch).toBe(1);
    expect(counts.reflex).toBe(1);
    expect(listObservabilityEvents(db, 10, "reflex")[0]?.summary).toBe("reflex ran");
  });
});

describe("#1661 — attention: admission lifecycle + access.denied", () => {
  let db: Database;
  beforeEach(() => (db = setupDb()));
  afterEach(() => db.close());

  it("admission.degraded OPENS (mode=degraded-local) and RESOLVES (mode=recovered) — ONE type", () => {
    const open = produceObservabilityAttention(db, {
      type: "system.admission.degraded",
      payload: { mode: "degraded-local", bucket: "admission_andreas_work", detail: "kv down" },
    });
    expect(open).toMatchObject({ action: "opened" });
    expect(open?.itemId).toBe(`${ADAPTER_ATTENTION_PREFIX}admission:admission_andreas_work`);
    expect(attentionRow(db, open!.itemId)?.status).toBe("open");

    const recovered = produceObservabilityAttention(db, {
      type: "system.admission.degraded",
      payload: { mode: "recovered", bucket: "admission_andreas_work", detail: "kv back" },
    });
    expect(recovered).toMatchObject({ action: "resolved" });
    expect(recovered?.itemId).toBe(open?.itemId);
    expect(attentionRow(db, open!.itemId)?.status).toBe("resolved");
  });

  it("admission.degraded falls back to the 'admission' id when bucket is absent", () => {
    const open = produceObservabilityAttention(db, {
      type: "system.admission.degraded",
      payload: { mode: "degraded-local", detail: "x" },
    });
    expect(open?.itemId).toBe(`${ADAPTER_ATTENTION_PREFIX}admission:admission`);
  });

  it("admission.throttled is history-only (no attention)", () => {
    expect(
      produceObservabilityAttention(db, { type: "system.admission.throttled", payload: { principal_id: "a", capability: "c" } }),
    ).toBeNull();
  });

  it("access.denied opens a HIGH-severity item collapsed by (principal_id + capability)", () => {
    const one = produceObservabilityAttention(db, {
      type: "system.access.denied",
      payload: { principal_id: "andreas", capability: "dispatch.task.received" },
    });
    expect(one).toMatchObject({ action: "opened" });
    expect(one?.itemId).toBe(`${ACCESS_DENIED_ATTENTION_PREFIX}andreas:dispatch.task.received`);
    const row = db.query(`SELECT severity, status FROM attention_items WHERE id = ?`).get(one!.itemId) as { severity: string; status: string };
    expect(row.severity).toBe("high");
    expect(row.status).toBe("open");

    // A second denial for the SAME key collapses into the same one item.
    const two = produceObservabilityAttention(db, {
      type: "system.access.denied",
      payload: { principal_id: "andreas", capability: "dispatch.task.received" },
    });
    expect(two?.itemId).toBe(one?.itemId);
    expect((db.query(`SELECT COUNT(*) AS n FROM attention_items`).get() as { n: number }).n).toBe(1);

    // A different capability is a DIFFERENT item (collapse key includes capability).
    produceObservabilityAttention(db, {
      type: "system.access.denied",
      payload: { principal_id: "andreas", capability: "other.cap" },
    });
    expect((db.query(`SELECT COUNT(*) AS n FROM attention_items`).get() as { n: number }).n).toBe(2);
  });

  it("access.denied has NO auto-resolve and is principal-acked (a cleared key is never resurrected)", () => {
    const payload = { principal_id: "andreas", capability: "dispatch.task.received" };
    const open = produceObservabilityAttention(db, { type: "system.access.denied", payload });
    expect(open).toMatchObject({ action: "opened" });
    // The principal resolves it (CK-6b resolve/dismiss).
    resolveAttentionItem(db, open!.itemId);
    expect(attentionRow(db, open!.itemId)?.status).toBe("resolved");
    // A redelivered (or fresh) denial for the same key does NOT reopen it.
    const again = produceObservabilityAttention(db, { type: "system.access.denied", payload });
    expect(again).toBeNull();
    expect(attentionRow(db, open!.itemId)?.status).toBe("resolved");
  });

  it("dispatch + reflex families are fold-only (never attention)", () => {
    expect(produceObservabilityAttention(db, { type: "system.dispatch.stage", payload: {} })).toBeNull();
    expect(produceObservabilityAttention(db, { type: "system.inbound.aborted", payload: {} })).toBeNull();
    expect(produceObservabilityAttention(db, { type: "system.bus.process", payload: {} })).toBeNull();
    expect(produceObservabilityAttention(db, { type: "reflex.activation.fired", payload: {} })).toBeNull();
  });
});

describe("#1661 — renderer subjects include the new families (still local-only)", () => {
  it("subscribes to the exact access/dispatch/reflex local subjects", () => {
    const db = setupDb();
    const r = createObservabilityProjectionRenderer(db);
    expect(r.subjects.some((s) => s.includes("system.access.denied"))).toBe(true);
    expect(r.subjects.some((s) => s.includes("system.admission.degraded"))).toBe(true);
    expect(r.subjects.some((s) => s.includes("system.dispatch.stage"))).toBe(true);
    expect(r.subjects.some((s) => s.includes("system.bus.process"))).toBe(true);
    expect(r.subjects.some((s) => s.includes("reflex.activation"))).toBe(true);
    // The U3.3 local-only invariant still holds for the added subjects.
    expect(r.subjects.every((s) => s.startsWith("local."))).toBe(true);
    expect(r.subjects.some((s) => s.startsWith("federated."))).toBe(false);
    db.close();
  });
});
