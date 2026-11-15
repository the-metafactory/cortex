import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { answering, openHost, scratchHosts } from "../../__tests__/fixtures/scratch";
import { toolBody } from "../../__tests__/fixtures/tool-body";
import { exerciseCloudWorkSource } from "../../__tests__/fixtures/work-source-conversation";
import { assertMailPolicyRace, assertMailWorkPolicies, callMailWorkTool, openMailWorkRig, SHARED_MAIL_ID, type MailWorkRig } from "../../domain-adapters/__tests__/fixtures/mail-work-tools-fixtures";

const opened: MailWorkRig[] = [];
const { dirs, hosts } = scratchHosts("mail-work-sources-");
afterEach(async () => { for (const rig of opened.splice(0)) await rig.close(); });
async function open(policy: "local" | "cloud" = "local") { const rig = await openMailWorkRig(policy); opened.push(rig); return rig; }

describe("listed Mail behind the work tools", () => {
  test.each(["local", "cloud"] as const)("%s reads only permitted fields, records connection-qualified sources and never starts an operation", async policy => {
    const rig = await open(policy);
    await assertMailWorkPolicies(rig);
  });

  test("cloud cannot distinguish empty and populated local accounts or look up their existence", async () => {
    const rig = await open("cloud");
    const populated = await callMailWorkTool(rig, "work_search", { kinds: ["mail"], query: "LOCAL-MAIL-CANARY" });
    const listing = rig.listings[0]!;
    rig.listings[0] = { ...listing, mail: listing.mail.filter(mail => mail.account !== "account-0") };
    const empty = await callMailWorkTool(rig, "work_search", { kinds: ["mail"], query: "LOCAL-MAIL-CANARY" });
    expect(populated).toEqual(empty);
    const before = rig.rig.calls.read;
    for (const id of [rig.id(), rig.id(0, "<missing@example.test>")]) {
      const result = await callMailWorkTool(rig, "work_read", { kind: "mail", id });
      expect(result.json.status).toBe("unauthorized");
      expect(result.remembered).toEqual([]);
    }
    expect(rig.rig.calls.read).toBe(before);
    expect(JSON.stringify((await callMailWorkTool(rig, "work_search", {})).json)).not.toContain("LOCAL-MAIL-CANARY");
  });

  for (const name of ["work_search", "work_read"] as const) {
    test.each([1, 2])(`${name} withholds policy changes at fetch %i`, async fetchNumber => {
      await assertMailPolicyRace(await open("cloud"), name, fetchNumber);
    });
  }

  test("local-only Mail cannot leave through a cloud model or Discord", async () => {
    const rig = await open();
    for (const options of [{ route: "cloud" as const }, { transport: "discord" as const }]) {
      const read = await callMailWorkTool(rig, "work_read", { kind: "mail", id: rig.id() }, options);
      expect(read.json.status).toBe("unauthorized");
      expect(read.remembered).toEqual([]);
    }
  });

  test("search follows bounded pages and applies offsets to subject, sender and paragraph matches", async () => {
    const rig = await open();
    const listing = rig.listings[0]!;
    const seed = listing.mail[0]!;
    rig.listings[0] = { ...listing, mail: Array.from({ length: 25 }, (_, index) => ({ ...seed, id: `<${index}@example.test>`, subject: `Example ${index}` })) };
    const page = await callMailWorkTool(rig, "work_search", { kinds: ["mail"], query: "sender@example.test", limit: 2, offset: 21 });
    expect(page.json.results.map((object: { id: string }) => object.id)).toEqual([rig.id(0, "<21@example.test>"), rig.id(0, "<22@example.test>")]);
    expect(page.json.next).toEqual({ offset: 23 });
    expect(page.remembered).toHaveLength(2);
    expect((await callMailWorkTool(rig, "work_search", { kinds: ["mail"], query: "absent" })).json.status).toBe("empty");
    expect((await callMailWorkTool(rig, "work_read", { kind: "mail", id: rig.id(0, SHARED_MAIL_ID) })).json.status).toBe("not-found");
  });

  test("failures claim no absence and unavailable or malformed references make no owner call", async () => {
    const rig = await open();
    const before = rig.rig.calls.read;
    for (const id of [SHARED_MAIL_ID, JSON.stringify(["unknown", SHARED_MAIL_ID]), "{}", '["only-one"]']) {
      expect(["unauthorized", "unavailable"]).toContain((await callMailWorkTool(rig, "work_read", { kind: "mail", id })).json.status);
    }
    expect((await callMailWorkTool(rig, "work_read", { kind: "mail", id: rig.id() }, { enabled: false })).json.status).toBe("unavailable");
    expect(rig.rig.calls.read).toBe(before);
    rig.rig.hooks.query = () => Promise.reject(new Error("synthetic owner failure"));
    for (const [name, input] of [["work_search", { kinds: ["mail"] }], ["work_read", { kind: "mail", id: rig.id() }]] as const) {
      const result = await callMailWorkTool(rig, name, input);
      expect(result.json.status).toBe("unavailable");
      expect(result.remembered).toEqual([]);
    }
  });

  test("bounded scans report incomplete coverage rather than a false absence", async () => {
    const rig = await open();
    const listing = rig.listings[0]!;
    const seed = listing.mail[0]!;
    rig.listings[0] = { ...listing, mail: Array.from({ length: 550 }, (_, index) => ({ ...seed, id: `<${index}@example.test>`, subject: index === 549 ? "Late match" : "Other mail" })) };
    const result = await callMailWorkTool(rig, "work_search", { kinds: ["mail"], query: "Late match" });
    expect(result.json.status).toBe("partial");
    expect(result.json.coverage).toBe("partial");
    expect(result.json.results).toEqual([]);
    expect(result.remembered).toEqual([]);
    expect(rig.rig.calls.read).toBe(26);
  });

  test.each(["work_search", "work_read"] as const)("%s sources still restrict the conversation after the host reopens", async name => {
    const rig = await open("cloud");
    const lane = { provider: "example", model: "example", adapter: "claude" as const };
    let result: Record<string, unknown> = {};
    const options = { dir: await dirs.make(), stack: "test", label: "test", expectedLabel: "test", lanes: { local: lane, cloud: lane }, now: () => new Date("2026-11-14T08:00:00.000Z"), turns: answering(async request => {
      result = toolBody(await request.tools!.call(randomUUID(), name, name === "work_read" ? { kind: "mail", id: rig.id(1) } : { kinds: ["mail"] }, request.signal));
      return "Read the listed Mail.";
    }) };
    let host = await openHost(hosts, options);
    const attach = () => host.attachSources({ resolvers: {}, readbacks: {}, readers: rig.readers(), queries: rig.readers });
    await attach();
    const id = await exerciseCloudWorkSource(host, "Mail source");
    expect(result.status).toBe(name === "work_read" ? "ok" : "partial");
    await host.close();
    host = await openHost(hosts, options);
    await attach();
    await rig.setPolicy(1, "local");
    await expect(host.meta(id)).rejects.toThrow("Previously retrieved related work");
  });
});
