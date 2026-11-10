import { afterEach, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initDatabase } from "../../db/init";
import { composeDesk } from "../compose";
import { canonicalWire } from "../../../../conversations/domain-adapters/operations/validation";
import type { Json } from "../../../../conversations/domain-adapters/operations/types";
import { ReadBindings } from "../../../../conversations/domain-adapters/reads/bindings";
import { catchupItems } from "../../dashboard-v2/components/desk-catch-up";
import { DeskItemRow } from "../../dashboard-v2/components/desk-view";
import { ATTENTION_DESK, attentionRig } from "./fixtures/adapter-attention-fixtures";

const opened: Awaited<ReturnType<typeof attentionRig>>[] = [];
const dbs: ReturnType<typeof initDatabase>[] = [];
afterEach(async () => { for (const db of dbs.splice(0)) db.close(); await Promise.all(opened.splice(0).map(item => item.rig.close())); });
async function open(policy: "local" | "cloud" = "local") { const item = await attentionRig(policy); opened.push(item); return item; }
async function compose(item: Awaited<ReturnType<typeof open>>, enabled = true) {
  const db = initDatabase(":memory:");
  dbs.push(db);
  return composeDesk(db, ATTENTION_DESK, undefined, { now: item.time.clock.now(), adapterAttention: { ...item.feature, enabled } });
}
function fields(value: Json): Record<string, Json> { return (value as Record<string, Json>)["display/data"] as Record<string, Json>; }

test("two unknown adapters produce distinct canonical items and use existing Catch-up filters without fetching", async () => {
  const item = await open();
  for (const index of [0, 1]) expect((await item.ingest(index)).status).toBe("ok");
  const before = item.fetches;
  const view = await compose(item);
  expect(item.fetches).toBe(before);
  expect(view.items).toHaveLength(2);
  for (const source of item.sources) {
    const card = view.items.find(card => card.source === source.adapterId)!;
    expect(card).toMatchObject({ kind: "adapter", title: "Synthetic review", why: "Review the synthetic observation.", dueAt: "2026-11-01", area: "lab", urgency: "today", score: 55, actions: [], readOnly: true, freshness: "fresh", detail: { links: [{ label: "Open source", url: "https://example.test/synthetic" }] } });
    expect(card.key).toBe(`adapter:${canonicalWire({ adapterId: source.adapterId, connectionId: source.connectionId, objectType: "document", canonicalId: "item-0" })}`);
    expect(card.attention).toBeUndefined();
    expect(card.interrupt).toBeUndefined();
    expect(catchupItems(view.items, "lab", "all", "adapter", source.adapterId)).toEqual([card]);
    expect(catchupItems(view.items, "lab", "update", "adapter")).toEqual([]);
  }
  expect(new Set(view.items.map(card => card.key)).size).toBe(2);
  expect(catchupItems(view.items, "other", "all")).toEqual([]);
});

test("the host alone derives the exact ranking at due-date boundaries and ignores authority-shaped data", async () => {
  const item = await open();
  const dueDates = ["2026-10-31", "2026-11-01", "2026-11-02", "2026-11-08", "2026-11-09", null];
  const objects = dueDates.map((due, index) => ({ ...(item.value(0, `Review ${index}`, due) as Record<string, Json>), urgency: "now", score: 9999, attention: "update", interrupt: true, notification: true, actions: ["send"] }));
  expect((await item.ingest(0, objects)).status).toBe("ok");
  const view = await compose(item);
  expect(view.items.map(card => [card.urgency, card.score])).toEqual([["today", 55], ["today", 55], ["this-week", 45], ["this-week", 45], ["waiting", 25], ["waiting", 25]]);
  for (const card of view.items) {
    expect(card.actions).toEqual([]);
    expect(card.more).toBeUndefined();
    expect(card.attention).toBeUndefined();
    expect(card.interrupt).toBeUndefined();
  }
});

test("disabled and unmapped observations stay stored and queryable without appearing on Desk", async () => {
  const item = await open();
  await item.ingest(0);
  expect((await compose(item, false)).items).toEqual([]);
  const db = initDatabase(":memory:"); dbs.push(db);
  expect((await composeDesk(db, ATTENTION_DESK, undefined)).items).toEqual([]);
  const bindings = new ReadBindings(item.rig.registry);
  for (const [index, adapter] of item.adapters.entries()) {
    const binding = structuredClone(adapter.binding);
    delete binding.attention;
    const source = item.sources[index]!;
    expect(bindings.register(binding, { adapterId: source.adapterId, connectionId: source.connectionId, readCapabilityIds: [source.capabilityId] }).ok).toBe(true);
  }
  item.feature.bindings = bindings;
  expect((await compose(item)).items).toEqual([]);
  const stored = await item.store.read(item.rig.context, item.sources[0]!, item.rig.sink);
  expect(stored.kind).toBe("released");
  if (stored.kind === "released") expect((stored.value as { objects: Json[] }).objects).toHaveLength(1);
});

test("bad pointers and invalid field values omit only the bad item and report a safe source problem", async () => {
  const item = await open();
  const objects = [item.value(0, "Valid"), ...["missing", "number", "date", "link", "area"].map(kind => {
    const value = item.value(0, `Private invalid ${kind}`);
    const display = fields(value);
    if (kind === "missing") delete display.reason;
    if (kind === "number") display.reason = 42;
    if (kind === "date") display.due = "2026-02-30";
    if (kind === "link") display.url = "javascript:alert(1)";
    if (kind === "area") delete display.area;
    return value;
  })];
  expect((await item.ingest(0, objects)).status).toBe("ok");
  await item.ingest(1);
  const view = await compose(item);
  expect(view.items).toHaveLength(2);
  expect(view.sources.find(source => source.id === "adapter:synthetic-one")).toEqual({ id: "adapter:synthetic-one", ok: false, error: "An adapter attention mapping could not be displayed safely." });
  expect(JSON.stringify(view)).not.toContain("Private invalid");
});

test("mapped display text uses source redaction and stale status remains visible in a row", async () => {
  const item = await open();
  const value = item.value(0, "Review ghp_abcdefghijklmnopqrstuvwxyz");
  fields(value).reason = "Bearer abcdefghijklmnop";
  await item.ingest(0, [value]);
  item.time.advance(720000);
  const view = await compose(item);
  expect(view.items[0]).toMatchObject({ title: "Review [redacted]", why: "[redacted]", freshness: "stale" });
  expect(JSON.stringify(view)).not.toMatch(/ghp_|abcdefghijklmnop/);
  const html = renderToStaticMarkup(createElement(DeskItemRow, { item: view.items[0]!, rank: 1, onOpen: () => undefined, onAction: () => undefined, sending: null, onFocusEvent: () => undefined, onCorrect: () => undefined }));
  expect(html).toContain("Stale observation");
  expect(html).not.toContain("Plan this");
});

test("revoked read, local-only release and owner deletion remove content and source counts", async () => {
  const item = await open();
  await item.ingest(0);
  await item.ingest(1);
  expect((await compose(item)).items).toHaveLength(2);
  await item.revoke(0);
  const revoked = await compose(item);
  expect(revoked.items).toHaveLength(1);
  expect(JSON.stringify(revoked)).not.toContain("synthetic-one");
  await item.remove(1);
  expect((await compose(item)).items).toEqual([]);
  const local = await open("cloud");
  await local.ingest(0);
  const restriction = { ...local.restrictions[0]!, revision: "2", egress: "local" as const };
  await local.rig.service.publishHostRecord({ kind: "restriction", value: restriction }, 1);
  const hidden = await compose(local);
  expect(hidden.items).toEqual([]);
  expect(hidden.sources.some(source => source.id.includes("synthetic-one"))).toBe(false);
  expect(JSON.stringify(hidden)).not.toContain("Synthetic review");
});
