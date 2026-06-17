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
 *     signals (collector degraded/recovered, transport backend un/reachable,
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
import { produceObservabilityAttention } from "../projection/observability-attention";
import { ADAPTER_ATTENTION_PREFIX } from "../projection/adapter-lifecycle";
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
    expect(familyForType("system.transport.leaf_disconnect")).toBe("transport");
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
    expect(projectObservability(db, envelope("system.transport.leaf_connect", { leaf: "leaf-a" }), fakeRegistry)).toBe("transport");

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
      envelope("system.transport.leaf_connect", { leaf: "leaf-a" }),
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
      envelope("system.transport.leaf_disconnect", { leaf: "leaf-a" }),
      "joel/research",
      fakeRegistry,
    );
    expect(broadcasts.some((m) => m.type === "mc.projection" && m.family === "attention")).toBe(false);
    const attnCount = (db.query(`SELECT COUNT(*) AS n FROM attention_items`).get() as { n: number }).n;
    expect(attnCount).toBe(0);
  });

  it("a LOCAL transport health signal STILL opens an attention item (regression guard)", () => {
    // Contrast: the same disconnect via the LOCAL path opens the att:adapter: item.
    projectObservability(db, envelope("system.transport.leaf_disconnect", { leaf: "leaf-a" }), fakeRegistry);
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

  it("opens on transport backend.unreachable and on leaf_disconnect", () => {
    const backend = produceObservabilityAttention(db, {
      type: "system.transport.backend.unreachable",
      payload: { backend: "victoria" },
    });
    expect(backend).toMatchObject({ action: "opened" });
    expect(attentionRow(db, backend!.itemId)?.status).toBe("open");

    const leaf = produceObservabilityAttention(db, {
      type: "system.transport.leaf_disconnect",
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

  it("falls back to the namespace id when the origin id is absent", () => {
    const res = produceObservabilityAttention(db, { type: "system.transport.backend.unreachable", payload: {} });
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
