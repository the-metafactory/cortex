import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DESK_API_VERSION } from "../../../desk-api/version";
import { handleDeskItemsDefer } from "../api/desk-items-defer";
import { DEFAULT_CONFIG } from "../config";
import { readSnooze, readSnoozes } from "../desk/mail-snooze";
import { DESK_ITEM_KINDS } from "../desk/types";
import { startServer } from "../server";
import { openMailRoundRig, postDeskJson, roundAt, roundEvent, roundMail, type MailRoundRig } from "./fixtures/mail-round-rig";

const NOW = roundAt(16, 10);
let rig: MailRoundRig;

const post = (body: unknown): Promise<Response> => postDeskJson(rig.baseUrl(), "/api/desk/items/defer", body);

beforeEach(async () => {
  rig = await openMailRoundRig(NOW, { mailDigest: undefined, mailInvitations: undefined });
  rig.setState({ mail: [roundMail("a", NOW - 1000), roundMail("b", NOW - 2000), roundMail("c", NOW - 3000)], events: [roundEvent("next", roundAt(16, 14), roundAt(16, 15)), roundEvent("over", roundAt(16, 8), roundAt(16, 9))] });
  await rig.get();
});

afterEach(async () => { await rig.close(); });

describe("Desk item defer HTTP contract", () => {
  it("puts a mail away until tomorrow in the snooze store and cancels it without a return reason", async () => {
    expect((await rig.get()).items.some((item) => item.key === "mail:a")).toBe(true);
    const response = await post({ action: "defer", key: "mail:a", until: { kind: "tomorrow" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-desk-api-version")).toBe(DESK_API_VERSION);
    const answer = await response.json();
    expect(answer).toMatchObject({ ok: true, until: "until tomorrow at 08:00", untilIso: new Date(roundAt(17, 8)).toISOString() });
    const row = readSnooze(rig.database(), "a");
    expect(row).toMatchObject({ subject: "Subject a", state: "snoozed", kind: "time", untilAt: roundAt(17, 8) });
    const view = await rig.get();
    expect(view.items.some((item) => item.key === "mail:a")).toBe(false);
    expect(view.deferred).toEqual([{ key: "mail:a", title: "Subject a", until: "until tomorrow at 08:00" }]);

    expect((await post({ action: "defer.cancel", key: "mail:a" })).status).toBe(200);
    const back = await rig.get();
    expect(back.deferred).toEqual([]);
    const item = back.items.find((entry) => entry.key === "mail:a");
    expect(item).toBeDefined();
    expect(item?.back).toBeUndefined();
    expect(item?.why).not.toContain("Back because");
    expect(readSnooze(rig.database(), "a")).toBeNull();

    expect((await rig.post({ action: "snooze", key: "mail:a", until: { kind: "tomorrow" } })).status).toBe(200);
    expect(readSnooze(rig.database(), "a")).toEqual(row);
    expect((await rig.get()).deferred).toEqual(view.deferred);
    expect((await post({ action: "defer.cancel", key: "mail:a" })).status).toBe(200);
  });

  it("orders timed and meeting waits by return time, then person waits, using stored titles and labels", async () => {
    expect((await post({ action: "defer", key: "mail:a", until: { kind: "person", address: "waiting@example.org" } })).status).toBe(200);
    expect((await post({ action: "defer", key: "mail:b", until: { kind: "tomorrow" } })).status).toBe(200);
    expect((await post({ action: "defer", key: "mail:c", until: { kind: "meeting", event: "cal:round-source:next" } })).status).toBe(200);
    const deferred = (await rig.get()).deferred;
    expect(deferred).toEqual([
      { key: "mail:c", title: "Subject c", until: "until “Meeting next” ends" },
      { key: "mail:b", title: "Subject b", until: "until tomorrow at 08:00" },
      { key: "mail:a", title: "Subject a", until: "until waiting@example.org writes" },
    ]);
    rig.reopen();
    expect((await rig.get()).deferred).toEqual(deferred);
    expect((await rig.post({ action: "snooze.cancel", key: "mail:c" })).status).toBe(200);
    expect((await rig.get()).deferred.map((item) => item.key)).toEqual(["mail:b", "mail:a"]);
  });

  it("lists a deferred mail even when it is absent from the current mailbox reading", async () => {
    await post({ action: "defer", key: "mail:a", until: { kind: "person", address: "waiting@example.org" } });
    rig.setState({ mail: [] });
    rig.setNow(NOW + 31_000);
    expect((await rig.refresh()).deferred).toEqual([{ key: "mail:a", title: "Subject a", until: "until waiting@example.org writes" }]);
  });

  it("removes awakened and hidden mail from deferred", async () => {
    await rig.post({ action: "hide", key: "mail:a" });
    await post({ action: "defer", key: "mail:b", until: { kind: "tomorrow" } });
    expect((await rig.get()).deferred.map((item) => item.key)).toEqual(["mail:b"]);
    expect((await post({ action: "defer.cancel", key: "mail:a" })).status).toBe(400);
    expect(readSnooze(rig.database(), "a")?.kind).toBe("hidden");
    rig.setNow(roundAt(17, 7));
    expect((await rig.get()).deferred[0]?.until).toBe("until today at 08:00");
    rig.setNow(roundAt(17, 8));
    const view = await rig.get();
    expect(view.deferred).toEqual([]);
    expect(view.items.find((item) => item.key === "mail:b")?.back?.line).toContain("Back because");
  });

  it("accepts the remaining time choices through the same snooze validation", async () => {
    for (const until of [{ kind: "later" }, { kind: "next-week" }, { kind: "date", date: "2026-12-01" }]) {
      const response = await post({ action: "defer", key: "mail:a", until });
      expect(response.status).toBe(200);
      expect((await rig.get()).deferred[0]?.until).toBe((await response.json()).until);
      expect((await post({ action: "defer.cancel", key: "mail:a" })).status).toBe(200);
    }
  });

  it("preserves the refusal for a Message-ID listed under more than one mailbox account", async () => {
    const mail = roundMail("a", NOW - 1000);
    rig.setState({ mail: [mail, { ...mail, account: "other" }] });
    rig.setNow(NOW + 31_000);
    await rig.refresh();
    const response = await post({ action: "defer", key: "mail:a", until: { kind: "tomorrow" } });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("more than one account");
    expect(readSnoozes(rig.database())).toEqual([]);
  });

  it("refuses every unsupported kind and unknown key with a kind-specific reason and no writes", async () => {
    const keys = [...DESK_ITEM_KINDS.filter((kind) => kind !== "mail").map((kind) => `${kind}:a`), "unknown:a", "missing", "mail:gone", "mail:"];
    for (const key of keys) {
      const response = await post({ action: "defer", key, until: { kind: "tomorrow" } });
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(key.includes(":") ? key.split(":")[0] : "unknown");
    }
    expect((await post({ action: "defer.cancel", key: "mail:gone" })).status).toBe(400);
    expect(readSnoozes(rig.database())).toEqual([]);
    expect(rig.database().query("SELECT * FROM desk_mail_log").all()).toEqual([]);
  });

  it("keeps snooze refusals unchanged for an ended meeting and invalid dates or addresses", async () => {
    for (const until of [{ kind: "meeting", event: "cal:round-source:over" }, { kind: "meeting", event: "cal:round-source:missing" }, { kind: "date", date: "2026-02-30" }, { kind: "date", date: "2026-11-01" }, { kind: "person", address: "not an address" }]) {
      const response = await post({ action: "defer", key: "mail:a", until });
      const alias = await rig.post({ action: "snooze", key: "mail:a", until });
      expect(response.status).toBe(409);
      expect(response.status).toBe(alias.status);
      expect(await response.json()).toEqual(await alias.json());
    }
    expect(readSnoozes(rig.database())).toEqual([]);
  });

  it("pins strict defer and cancel request shapes, methods and the disabled Desk refusal", async () => {
    for (const body of [null, {}, { action: "defer", key: "mail:a" }, { action: "defer", key: "mail:a", until: { kind: "soon" } }, { action: "defer", key: "mail:a", until: { kind: "tomorrow", date: "2026-11-17" } }, { action: "defer.cancel", key: "mail:a", until: { kind: "tomorrow" } }, { action: "snooze", key: "mail:a", until: { kind: "tomorrow" } }]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await fetch(`${rig.baseUrl()}/api/desk/items/defer`, { method: "POST", body: "{" })).status).toBe(400);
    const wrongMethod = await fetch(`${rig.baseUrl()}/api/desk/items/defer`);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect((await handleDeskItemsDefer(new Request("http://localhost/api/desk/items/defer", { method: "POST" }), rig.database(), undefined)).status).toBe(409);
    expect(readSnoozes(rig.database())).toEqual([]);
  });

  it("publishes the defer actions in the versioned contract", async () => {
    const response = await fetch(`${rig.baseUrl()}/api/desk/contract`);
    const contract = await response.json();
    expect(contract.version).toBe(DESK_API_VERSION);
    expect(contract.vocabularies.DEFER_ACTIONS).toEqual(["defer", "defer.cancel"]);
    expect(contract.vocabularies.SNOOZE_TIMES).toEqual(["later", "tomorrow", "next-week"]);
    expect((await rig.get()).deferred).toEqual([]);
  });

  it("keeps the Host, Origin and identity gates on the new route", async () => {
    const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.org"] } }, rig.database());
    const base = `http://localhost:${ctx.port}`;
    const send = (headers: Record<string, string>) => fetch(`${base}/api/desk/items/defer`, { method: "POST", headers: { "content-type": "application/json", origin: base, "Cf-Access-Authenticated-User-Email": "principal@example.org", ...headers }, body: JSON.stringify({ action: "defer", key: "mail:a", until: { kind: "tomorrow" } }) });
    try {
      expect((await send({ Host: "untrusted.example.org" })).status).toBe(403);
      expect((await send({ Origin: "https://untrusted.example.org" })).status).toBe(403);
      expect((await send({ "Cf-Access-Authenticated-User-Email": "stranger@example.org" })).status).toBe(403);
      expect((await send({})).status).toBe(409);
      expect(readSnoozes(rig.database())).toEqual([]);
    } finally { ctx.stop(true); }
  });
});
