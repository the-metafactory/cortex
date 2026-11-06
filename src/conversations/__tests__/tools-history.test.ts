import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import type { ToolsConfig } from "../../common/types/desk-conversations";
import { ConversationCreation } from "../creation";
import type { ConversationHost, HostOptions } from "../host";
import type { ToolOutcome, TurnRequest } from "../model";
import { DECISION_KIND, type Policy, type SourceState } from "../types";
import { answering, openHost, scratchHosts } from "./fixtures/scratch";
import { toolBody } from "./fixtures/tool-body";
import { fixtureOwner } from "./fixtures/owner";

const { dirs, hosts } = scratchHosts("conversation-history-");
const lane = { provider: "fixture", model: "model" };
const at = "2026-11-02T12:00:00.000Z";
const principal = "synthetic-principal";
const body = toolBody;
const input = (id: string, transport: "web" | "discord" = "web") => ({ inputId: id, transport, text: "Find earlier evidence.", mode: "queue" as const });
async function open(answer: (request: TurnRequest) => Promise<string>, extra: Partial<HostOptions> = {}) {
  return openHost(hosts, { dir: await dirs.make(), stack: "test", label: "test", expectedLabel: "test", lanes: { local: lane, cloud: lane }, turns: answering(answer), now: () => new Date(at), ...extra });
}
const create = (host: ConversationHost, title: string, policy: Policy = "cloud", owner = principal, links: Parameters<ConversationHost["create"]>[0]["links"] = []) => host.create({ title, policy, links, origin: { kind: "web" } }, owner);
async function decision(host: ConversationHost, title: string, policy: Policy = "cloud", owner = principal) {
  const conversation = await create(host, title, policy, owner);
  await host.record(conversation.id, "decision", DECISION_KIND, { text: "The earlier decision: choose the blue option.", at, evidence: "Original tool evidence" });
  return conversation;
}
async function turn(host: ConversationHost, id: string, transport: "web" | "discord" = "web", inputId = randomUUID()) {
  await host.submit(id, input(inputId, transport));
  await host.waitForIdle(id);
}
async function linkedDecision(host: ConversationHost) {
  const target = (await create(host, "Linked history", "cloud", principal, [{ owner: "balance-task", id: "synthetic" }])).id;
  await host.record(target, "decision", DECISION_KIND, { text: "earlier decision", at });
  return target;
}

describe("owner-backed history through model tool dispatch", () => {
  test("search cites an earlier decision, reads full evidence in windows and preserves both owned probes", async () => {
    let permitted = "";
    const recovered: string[] = [];
    let search: Record<string, any> = {};
    const host = await open(async request => {
      search = body(await request.tools!.call("search", "conversation_search", { query: "earlier decision" }, request.signal));
      expect(search.status).toBe("ok");
      expect(search.matches).toHaveLength(1);
      const citation = search.matches[0];
      expect(citation.conversation.id).toBe(permitted);
      expect(citation.entry.at).toBe(at);
      expect(citation.entry.url).toBe(`/api/conversations/${permitted}/entries/${citation.entry.id}`);
      let offset = 0;
      do {
        const result = body(await request.tools!.call(`read-${offset}`, "conversation_read", { conversation: permitted, entry: Number(citation.entry.id), offset }, request.signal));
        expect(result.status).toBe("ok");
        recovered.push(result.record);
        offset = result.nextOffset;
      } while (offset !== null);
      const evidence = body(await request.tools!.call("next", "conversation_read", { conversation: permitted, after: Number(citation.entry.id) }, request.signal));
      const chunks = [evidence.record];
      let next = evidence.nextOffset;
      while (next !== null) {
        const part = body(await request.tools!.call(`evidence-${next}`, "conversation_read", { conversation: permitted, entry: Number(evidence.entry.id), offset: next }, request.signal));
        chunks.push(part.record);
        next = part.nextOffset;
      }
      expect(chunks.length).toBeGreaterThan(1);
      expect(JSON.parse(chunks.join("")).data).toEqual({ evidence: "Evidence ".repeat(5000), nested: { intact: true } });
      expect(evidence.entry.at).toBeNull();
      return "Earlier decision retrieved by citation.";
    });
    const allowed = await decision(host, "Permitted synthetic probe");
    permitted = allowed.id;
    const hidden = await decision(host, "HIDDEN_TITLE_MARKER", "local");
    await host.record(allowed.id, "long-evidence", "synthetic.evidence", { evidence: "Evidence ".repeat(5000), nested: { intact: true } });
    const before = await host.entries(allowed.id, 100, undefined);
    const hiddenBefore = await host.entries(hidden.id, 100, undefined);
    const reader = await create(host, "Reader");
    await turn(host, reader.id);
    expect(JSON.stringify(search)).not.toContain("HIDDEN_TITLE_MARKER");
    expect(JSON.stringify(search)).not.toContain(hidden.id);
    const record = JSON.parse(recovered.join(""));
    expect(record.id).toBe(Number(search.matches[0].entry.id));
    expect(record.data).toEqual({ text: "The earlier decision: choose the blue option.", at, evidence: "Original tool evidence" });
    expect(await host.entries(allowed.id, 100, undefined)).toEqual(before);
    expect(await host.entries(hidden.id, 100, undefined)).toEqual(hiddenBefore);
    await host.organize(allowed.id, { state: "archived" });
    await host.organize(hidden.id, { state: "archived" });
    expect((await host.meta(allowed.id)).state).toBe("archived");
    expect((await host.meta(hidden.id)).state).toBe("archived");
  });

  test("inaccessible conversations add no search title, snippet, match count or pagination", async () => {
    const searches: string[] = [];
    const reads: object[] = [];
    let forbidden = "";
    const host = await open(async request => {
      searches.push(JSON.stringify(body(await request.tools!.call("search", "conversation_search", { query: "earlier decision" }, request.signal))));
      for (const id of [forbidden, "00000000-0000-4000-8000-000000000000"]) reads.push(body(await request.tools!.call("read", "conversation_read", { conversation: id }, request.signal)));
      return "Checked history.";
    });
    await decision(host, "Visible");
    forbidden = (await decision(host, "FOREIGN_TITLE_MARKER", "cloud", "another-principal")).id;
    const reader = await create(host, "Reader");
    await turn(host, reader.id);
    for (let i = 0; i < 6; i++) await decision(host, `LOCAL_HIDDEN_${i}`, "local");
    await turn(host, reader.id);
    expect(searches[0]).toBe(searches[1]);
    expect(searches[0]).not.toContain("FOREIGN_TITLE_MARKER");
    expect(reads).toEqual(Array(4).fill({ status: "unavailable", message: "No accessible conversation was found. It may be missing, deleted or denied." }));
  });

  test("reading a seeded exchange retains every original message and evidence field", async () => {
    let target = "";
    let entry = 0;
    const host = await open(async request => {
      const result = body(await request.tools!.call("read", "conversation_read", { conversation: target, entry }, request.signal));
      const record = JSON.parse(result.record);
      expect(record).toEqual(await host.entry(target, entry));
      expect(record.model.map((message: { role: string }) => message.role)).toEqual(["user", "assistant"]);
      expect(record.data).toEqual({ nested: { original: ["evidence", "decision"] } });
      expect(result.entry.at).toBe(at);
      return "Original exchange read.";
    });
    const source = await host.create({ title: "Seeded earlier exchange", policy: "cloud", links: [], origin: { kind: "web" } }, principal, { entries: [{ kind: "synthetic.exchange", data: { nested: { original: ["evidence", "decision"] } }, messages: [{ role: "user", text: "Which option?", at: Date.parse(at) }, { role: "assistant", text: "Choose blue.", at: Date.parse(at) + 1000 }] }] });
    target = source.id;
    entry = Number(await host.latestEntryId(target));
    await turn(host, (await create(host, "Reader")).id);
  });

  test.each(["\n", "\t", "\r"])("credential redaction precedes snippets and record windows with %j whitespace while the original stays intact", async whitespace => {
    const secret = `ghp_${"a".repeat(40)}`;
    const bearer = "synthetic-bearer-token";
    const data = { text: `credential evidence:${whitespace}${secret}`, [secret]: true, nested: { authorization: `Bearer${whitespace}${bearer}`, items: [{ [`Bearer${whitespace}${bearer}`]: `Bearer${whitespace}${bearer}` }] } };
    let completed = false;
    let target = "";
    let entry = 0;
    const host = await open(async request => {
      const search = body(await request.tools!.call("search", "conversation_search", { query: "credential evidence" }, request.signal));
      expect(search.status).toBe("ok");
      expect(search.matches).toHaveLength(1);
      expect(search.matches[0].entry.id).toBe(String(entry));
      expect(search.matches[0].snippet).toContain("[redacted]");
      expect(JSON.stringify(search)).not.toContain(secret);
      expect(JSON.stringify(search)).not.toContain(bearer);
      const windows: string[] = [];
      let offset = 0;
      do {
        const result = body(await request.tools!.call(`window-${offset}`, "conversation_read", { conversation: target, entry, offset, limit: 7 }, request.signal));
        expect(result.redacted).toBe(true);
        windows.push(result.record);
        offset = result.nextOffset;
      } while (offset !== null);
      expect(windows.join("")).not.toContain(secret);
      expect(windows.join("")).not.toContain(bearer);
      expect(JSON.parse(windows.join("")).data).toEqual({ text: `credential evidence:${whitespace}[redacted]`, "[redacted]": true, nested: { authorization: "[redacted]", items: [{ "[redacted]": "[redacted]" }] } });
      expect(JSON.parse(windows.join("")).model[0].content).toBe(`credential message:${whitespace}[redacted]`);
      expect(await host.entry(target, entry)).toEqual(original);
      completed = true;
      return "Redacted evidence read.";
    });
    target = (await host.create({ title: "Synthetic credentials", policy: "cloud", links: [], origin: { kind: "web" } }, principal, { entries: [{ kind: "synthetic.evidence", data, messages: [{ role: "user", text: `credential message:${whitespace}${secret}`, at: Date.parse(at) }] }] })).id;
    entry = Number(await host.latestEntryId(target));
    const original = await host.entry(target, entry);
    const reader = await create(host, "Reader");
    await turn(host, reader.id);
    expect(completed).toBe(true);
    expect(JSON.stringify(await host.entries(reader.id, 100, undefined))).not.toContain(secret);
    expect(JSON.stringify(await host.entries(reader.id, 100, undefined))).not.toContain(bearer);
  });

  test.each([
    ["cloud", "web", false], ["local", "discord", false], ["cloud", "discord", false], ["local", "web", true],
  ] as const)("local-only history with %s policy over %s", async (policy, transport, allowed) => {
    let target = "";
    const outcomes: Record<string, any>[] = [];
    const host = await open(async request => {
      outcomes.push(body(await request.tools!.call("search", "conversation_search", { query: "earlier decision" }, request.signal)));
      outcomes.push(body(await request.tools!.call("read", "conversation_read", { conversation: target }, request.signal)));
      return "Checked.";
    });
    target = (await decision(host, "PRIVATE_TITLE_MARKER", "local")).id;
    const reader = await create(host, "Reader", policy);
    await turn(host, reader.id, transport);
    expect(outcomes[0]!.matches.length).toBe(allowed ? 1 : 0);
    expect(outcomes[1]!.status).toBe(allowed ? "ok" : "unavailable");
    if (!allowed) expect(JSON.stringify(await host.entries(reader.id, 100, undefined))).not.toContain("PRIVATE_TITLE_MARKER");
  });

  test("archived records remain searchable and missing entries and empty search are truthful", async () => {
    let target = "";
    const host = await open(async request => {
      const invoke = async (name: string, args: object) => body(await request.tools!.call(name, name, args, request.signal));
      const archived = await invoke("conversation_search", { query: "earlier decision", state: "archived" });
      expect(archived.matches).toHaveLength(1);
      expect(archived.matches[0].conversation.state).toBe("archived");
      expect((await invoke("conversation_search", { query: "no such text" })).status).toBe("no-match");
      expect((await invoke("conversation_search", { query: "earlier decision", state: "current" })).matches).toEqual([]);
      expect((await invoke("conversation_read", { conversation: target, entry: 99999999 })).status).toBe("entry-not-found");
      return "Archive checked.";
    });
    target = (await decision(host, "Archive")).id;
    await host.organize(target, { state: "archived" });
    await turn(host, (await create(host, "Reader")).id);
  });

  test("a linked policy change between search and read fences the next call and final answer", async () => {
    let target = "";
    let policy: Policy = "cloud";
    const outcomes: ToolOutcome[] = [];
    const host = await open(async request => {
      outcomes.push(await request.tools!.call("search", "conversation_search", { query: "earlier decision" }, request.signal));
      policy = "local";
      outcomes.push(await request.tools!.call("read", "conversation_read", { conversation: target }, request.signal));
      return "STALE_FINAL_MARKER";
    }, { resolvers: { "balance-task": async () => ({ state: "available", policy, title: "Synthetic source" }) } });
    target = await linkedDecision(host);
    const reader = await create(host, "Reader");
    await turn(host, reader.id);
    expect(outcomes.map(o => o.outcome)).toEqual(["done", "refused"]);
    expect(JSON.stringify(await host.entries(reader.id, 100, undefined))).not.toContain("STALE_FINAL_MARKER");
    expect((await host.meta(reader.id)).policy).toBe("local");
  });

  test.each(["revoked", "tightened"] as const)("%s history survives restart and fences native cloud continuation", async change => {
    let target = "";
    let state: SourceState = { state: "available", policy: "cloud", title: "Source" };
    const dir = await dirs.make();
    const resolvers = { "balance-task": async () => state };
    const host = await open(async request => {
      expect(request.resume).toBeNull();
      await request.tools!.call("read", "conversation_read", { conversation: target }, request.signal);
      return "Earlier evidence read.";
    }, { dir, resolvers });
    target = await linkedDecision(host);
    const reader = await create(host, "Reader");
    await turn(host, reader.id);
    await host.close();
    hosts.splice(hosts.indexOf(host), 1);
    state = change === "revoked" ? { state: "unavailable", reason: "unauthorized" } : { state: "available", policy: "local", title: "Source" };
    let invoked = false;
    const restarted = await open(async request => {
      invoked = true;
      expect(request.route).toBe("local");
      expect(request.resume).toBeNull();
      return "Continued locally.";
    }, { dir, resolvers });
    if (change === "revoked") {
      await expect(restarted.submit(reader.id, input("resume"))).rejects.toThrow("no longer authorized");
      expect(invoked).toBe(false);
    } else {
      await turn(restarted, reader.id);
      expect(invoked).toBe(true);
      expect((await restarted.meta(reader.id)).policy).toBe("local");
    }
  });

  test("a change during owner read withholds all target evidence", async () => {
    let calls = 0;
    let change = false;
    let target = "";
    const outcomes: Record<string, any>[] = [];
    const host = await open(async request => {
      calls = 0;
      change = true;
      outcomes.push(body(await request.tools!.call("read", "conversation_read", { conversation: target }, request.signal)));
      return "Checked.";
    }, { resolvers: { "balance-task": async () => ({ state: "available", policy: change && ++calls > 1 ? "local" : "cloud", title: "Source" }) } });
    target = (await create(host, "WITHHELD_TITLE_MARKER", "cloud", principal, [{ owner: "balance-task", id: "synthetic" }])).id;
    await host.record(target, "decision", DECISION_KIND, { text: "WITHHELD_CONTENT_MARKER", at });
    const reader = await create(host, "Reader");
    await turn(host, reader.id);
    expect(outcomes[0]!.status).toBe("unavailable");
    const record = JSON.stringify(await host.entries(reader.id, 100, undefined));
    expect(record).not.toContain("WITHHELD_TITLE_MARKER");
    expect(record).not.toContain("WITHHELD_CONTENT_MARKER");
  });

  test("search pages scan bounded windows and retain entry identity beyond the first window", async () => {
    let target = "";
    const seen: string[] = [];
    const host = await open(async request => {
      let cursor: object | null = null;
      let pages = 0;
      do {
        const page = body(await request.tools!.call(`page-${pages}`, "conversation_search", { query: "needle", ...(cursor ? { cursor } : {}) }, request.signal));
        if (pages === 0) expect(page.status).toBe("page-empty");
        expect(page.matches.length).toBeLessThanOrEqual(5);
        for (const match of page.matches) {
          expect(match.conversation.id).toBe(target);
          seen.push(match.entry.id);
        }
        cursor = page.next;
        pages++;
        expect(pages).toBeLessThan(6);
      } while (cursor);
      expect(pages).toBeGreaterThan(2);
      return "Paged.";
    });
    target = (await create(host, "Synthetic paging")).id;
    for (let i = 0; i < 108; i++) await host.record(target, `item-${i}`, DECISION_KIND, { text: i < 100 ? `filler-${i}` : `needle-${i}`, at });
    await turn(host, (await create(host, "Reader")).id);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  test("retrieving a conversation's grant record does not transfer its standing action authority", async () => {
    let source = "";
    let retrieved = false;
    const host = await open(async request => {
      const search = body(await request.tools!.call("grant-record", "conversation_search", { query: "granted" }, request.signal));
      expect(search.status).toBe("ok");
      const citation = search.matches.find((match: { conversation: { id: string }; entry: { kind: string } }) => match.conversation.id === source && match.entry.kind === "cortex.grant");
      expect(citation).toBeDefined();
      const read = body(await request.tools!.call("read-grant", "conversation_read", { conversation: source, entry: Number(citation.entry.id) }, request.signal));
      expect(read.status).toBe("ok");
      expect(JSON.parse(read.record).data).toMatchObject({ scope: "conversation", action: "granted", type: "desk-note" });
      retrieved = true;
      return "Read evidence only.";
    });
    const owner = fixtureOwner();
    await host.attachSources({ resolvers: {}, readbacks: {}, writers: { "desk-note": owner.writer } });
    const creation = new ConversationCreation(host);
    const actor = { principal, transport: "web" as const };
    source = (await create(host, "Source authority")).id;
    const proposed = await creation.propose(source, { proposalId: randomUUID(), type: "desk-note", fields: { text: "Synthetic note" } }, actor);
    await creation.confirm(source, proposed.view.proposal.proposalId, { revision: proposed.view.proposal.revision, digest: proposed.view.digest, grant: { scope: "conversation" } }, actor);
    expect(owner.effects).toHaveLength(1);
    const reader = await create(host, "Reader");
    await turn(host, reader.id);
    expect(retrieved).toBe(true);
    const next = await creation.propose(reader.id, { proposalId: randomUUID(), type: "desk-note", fields: { text: "Still needs confirmation" } }, actor);
    expect(next.view.feedback).toBe("proposed");
    expect(owner.effects).toHaveLength(1);
    expect((await creation.list(reader.id, actor)).grants).toEqual([]);
  });

  test("revoking a project used by retrieved evidence blocks transitive continuation", async () => {
    const config: ToolsConfig = { projects: [{ id: "source", root: "/tmp/synthetic-source", policy: "cloud", operations: ["repo.read"] }] };
    let target = "";
    let mode: "project" | "history" = "project";
    const host = await open(async request => {
      if (mode === "project") await request.tools!.call("repo", "fixture_read", { project: "source" }, request.signal);
      else await request.tools!.call("history", "conversation_read", { conversation: target }, request.signal);
      return "Evidence read.";
    }, { tools: { config: () => config, definitions: [{ name: "fixture_read", description: "Read synthetic evidence", operation: "repo.read", input: z.object({ project: z.string() }), run: async () => "Synthetic tool evidence" }] } });
    const original = await create(host, "Original tool evidence");
    await turn(host, original.id);
    target = original.id;
    mode = "history";
    const intermediate = await create(host, "Intermediate");
    await turn(host, intermediate.id);
    target = intermediate.id;
    const reader = await create(host, "Reader");
    await turn(host, reader.id);
    config.projects = [];
    await expect(host.submit(reader.id, input("after-revocation"))).rejects.toThrow("revoked or changed");
  });
});
