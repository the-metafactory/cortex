import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { openConversationHost, type ConversationHost, type HostStatus } from "../../../conversations/host";
import { scratchDirs } from "../../../conversations/__tests__/fixtures/scratch";
import type { ConversationDetail, ConversationMeta, LinkResolvers, OverviewRow, SourceState } from "../../../conversations/types";
import { handleConversations } from "../api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../api/mutation-guard";
import { WorkspaceView } from "../dashboard-v2/components/desk-conversation";
import { OverviewView, type OverviewProps } from "../dashboard-v2/components/desk-conversations";

const LABEL = "ai.meta-factory.cortex.overview-test";
const OTHER = { "cf-access-authenticated-user-email": "someone-else@example.invalid" };
const dirs = scratchDirs("conversation-overview-");
const hosts: ConversationHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  await dirs.clean();
});

interface Reply { ok: boolean; error?: string; rows: OverviewRow[]; next?: string; conversation: ConversationMeta; duplicate: boolean }

async function rig() {
  let clock = Date.parse("2026-11-01T08:00:00.000Z");
  const tasks = new Map<string, SourceState>();
  const resolvers: LinkResolvers = { "balance-task": ref => Promise.resolve(tasks.get(ref.id) ?? { state: "unavailable", reason: "gone" }) };
  const endpoint = { baseUrl: "http://model.invalid/v1", model: "test-model", timeoutSeconds: 5 };
  const status: HostStatus = await openConversationHost({
    dir: await dirs.make(), stack: "test", label: LABEL, expectedLabel: LABEL, endpoints: { local: endpoint, cloud: endpoint }, resolvers,
    chat: (_endpoint, turns) => Promise.resolve(`Ivy heard: ${turns.at(-1)?.content ?? ""}`), now: () => new Date(clock),
  });
  if (status.state !== "ready") throw new Error(status.reason);
  const host = status.host;
  hosts.push(host);
  const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() };
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Reply; text: string }> => {
    const res = await handleConversations(new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:8767${path}`), guard, () => status);
    const text = await res.text();
    return { status: res.status, body: JSON.parse(text) as Reply, text };
  };
  const tick = (minutes: number): void => { clock += minutes * 60_000; };
  const make = async (title: string, said: string[], links: { owner: "balance-task"; id: string }[] = [], titleFromSource = false): Promise<string> => {
    const meta = await host.create({ title, links, origin: { kind: "web" }, policy: "cloud" }, "local-principal@loopback", { titleFromSource });
    for (const [i, text] of said.entries()) {
      tick(1);
      await host.submit(meta.id, { inputId: `${meta.id}-${i}`, transport: "web", text, mode: "queue" });
      await host.waitForIdle(meta.id);
    }
    tick(10);
    return meta.id;
  };
  const overview = (query: string) => call("GET", `/api/conversations/overview${query}`);
  return { host, call, tick, make, tasks, overview };
}

describe("Ivy conversation overview", () => {
  test("rows carry title, latest exchange, linked work, status and activity; recent first, pinned on top, paged by cursor", async () => {
    const r = await rig();
    r.tasks.set("task-1", { state: "available", policy: "cloud", title: "Prepare the glider workshop" });
    const oldest = await r.make("Paper glider wings", ["Which wing shape flies farther?"]);
    const middle = await r.make("Kite festival", ["When does the festival open?"], [{ owner: "balance-task", id: "task-1" }]);
    const newest = await r.make("Weekend bread", ["How long should rye proof?"]);
    const first = await r.overview("?limit=2");
    expect(first.status).toBe(200);
    expect(first.body.rows.map(row => row.conversation.id)).toEqual([newest, middle]);
    const kite = first.body.rows[1];
    expect(kite?.conversation).toMatchObject({ title: "Kite festival", state: "current", pinned: false, activity: { status: "waiting" } });
    expect(kite?.latest?.who).toBe("assistant");
    expect(kite?.latest?.text).toContain("When does the festival open?");
    expect(kite?.linked).toEqual([{ owner: "balance-task", title: "Prepare the glider workshop" }]);
    expect(kite?.conversation.activity.lastAt).toBe("2026-11-01T08:12:00.000Z");
    expect(first.body.next).toBeString();
    const second = await r.overview(`?limit=2&cursor=${first.body.next ?? ""}`);
    expect(second.body.rows.map(row => row.conversation.id)).toEqual([oldest]);
    expect(second.body.next).toBeUndefined();
    expect((await r.overview("?cursor=not-a-cursor")).status).toBe(400);
    expect((await r.overview("?limit=0")).status).toBe(400);
    const pinned = await r.call("PATCH", `/api/conversations/${oldest}`, { pinned: true });
    expect(pinned.body.conversation.pinned).toBe(true);
    expect((await r.call("PATCH", `/api/conversations/${oldest}`, { pinned: true })).body.conversation).toEqual(pinned.body.conversation);
    expect((await r.overview("")).body.rows.map(row => row.conversation.id)).toEqual([oldest, newest, middle]);
    expect((await r.call("PATCH", `/api/conversations/${oldest}`, { pinned: "yes" })).status).toBe(400);
    expect((await r.call("PATCH", `/api/conversations/${oldest}`, {})).status).toBe(400);
  });

  test("search finds an older phrase and titles, pages server-side, and never matches or shows attachment names", async () => {
    const r = await rig();
    const older = await r.make("Garden plans", ["The quince tree needs pruning in late winter.", "What about the roses?"]);
    for (let i = 0; i < 3; i++) await r.make(`Errand ${i}`, [`Errand number ${i}`]);
    const found = await r.overview("?q=quince%20pruning");
    expect(found.body.rows.map(row => row.conversation.id)).toEqual([older]);
    expect(found.body.rows[0]?.match).toEqual({ who: "user", text: "The quince tree needs pruning in late winter." });
    expect(found.body.rows[0]?.latest?.text).toContain("roses");
    expect((await r.overview("?q=garden")).body.rows.map(row => row.conversation.id)).toEqual([older]);
    expect((await r.overview("?q=quince%20tulips")).body.rows).toEqual([]);
    const paged = await r.overview("?q=errand&limit=2");
    expect(paged.body.rows).toHaveLength(2);
    expect((await r.overview(`?q=errand&limit=2&cursor=${paged.body.next ?? ""}`)).body.rows).toHaveLength(1);
    const attached = await r.host.storeAttachment(older, { name: "salary-review.pdf", mediaType: "application/pdf", base64: Buffer.from("synthetic").toString("base64") });
    await r.host.submit(older, { inputId: "with-file", transport: "web", text: "Here is the file", attachments: [attached], mode: "queue" });
    await r.host.waitForIdle(older);
    expect((await r.overview("?q=salary-review")).body.rows).toEqual([]);
    const listed = await r.overview("");
    expect(listed.text).not.toContain("salary-review");
    expect(listed.text).toContain("Here is the file");
  });

  test("archive hides without deleting; an archived conversation refuses input until restored, then continues with the same identity", async () => {
    const r = await rig();
    const id = await r.make("Glider log", ["First flight went left."]);
    const archived = await r.call("PATCH", `/api/conversations/${id}`, { state: "archived" });
    expect(archived.body.conversation).toMatchObject({ id, state: "archived" });
    expect((await r.call("PATCH", `/api/conversations/${id}`, { state: "archived" })).status).toBe(200);
    expect((await r.overview("")).body.rows).toEqual([]);
    expect((await r.overview("?state=archived")).body.rows.map(row => row.conversation.id)).toEqual([id]);
    expect((await r.overview("?state=archived&q=went%20left")).body.rows.map(row => row.conversation.id)).toEqual([id]);
    const refused = await r.call("POST", `/api/conversations/${id}/inputs`, { inputId: "late", transport: "web", text: "One more thing" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toContain("Restore it to continue");
    expect((await r.call("POST", `/api/conversations/${id}/inputs`, { inputId: `${id}-0`, transport: "web", text: "First flight went left." })).body.duplicate).toBe(true);
    const restored = await r.call("PATCH", `/api/conversations/${id}`, { state: "current" });
    expect(restored.body.conversation).toMatchObject({ id, state: "current" });
    expect((await r.call("POST", `/api/conversations/${id}/inputs`, { inputId: "late", transport: "web", text: "One more thing" })).status).toBe(202);
    await r.host.waitForIdle(id);
    const said = (await r.host.entries(id, 100, undefined)).entries.filter(e => e.role === "user").map(e => e.text);
    expect(said).toEqual(["First flight went left.", "One more thing"]);
    expect((await r.call("PATCH", "/api/conversations/00000000-0000-4000-8000-000000000000", { state: "archived" })).status).toBe(404);
  });

  test("an unauthorized actor gets no rows or snippets, and an unavailable source leaks neither its name, id nor source-derived title", async () => {
    const r = await rig();
    r.tasks.set("hidden-task-77", { state: "available", policy: "local", title: "Confidential merger prep" });
    const id = await r.make("Confidential merger prep", ["Draft the zebra memo."], [{ owner: "balance-task", id: "hidden-task-77" }], true);
    const denied = await r.call("GET", "/api/conversations/overview?q=zebra", undefined, OTHER);
    expect(denied.status).toBe(403);
    expect(denied.text).not.toContain("zebra");
    expect(denied.text).not.toContain("merger");
    expect((await r.call("PATCH", `/api/conversations/${id}`, { pinned: true }, OTHER)).status).toBe(403);
    expect((await r.host.meta(id)).pinned).toBe(false);
    r.tasks.set("hidden-task-77", { state: "unavailable", reason: "unauthorized" });
    const listed = await r.overview("");
    expect(listed.body.rows[0]?.conversation.title).toBe("Conversation about work that is no longer available");
    expect(listed.body.rows[0]?.conversation.links).toEqual([]);
    expect(listed.body.rows[0]?.linked).toEqual([{ owner: "balance-task", title: null }]);
    expect(listed.body.rows[0]?.conversation.policy).toBe("local");
    expect(listed.text).not.toContain("merger");
    expect(listed.text).not.toContain("hidden-task-77");
    expect((await r.overview("?q=merger")).body.rows).toEqual([]);
    expect((await r.overview("?q=no%20longer%20available")).body.rows.map(row => row.conversation.id)).toEqual([id]);
  });
});

describe("Ivy conversation overview view", () => {
  const noop = (): void => undefined;
  const base: OverviewProps = { shelf: "current", search: "", selected: null, rows: [], next: null, loadedAt: null, error: null, loading: false, onShelf: noop, onSearch: noop, onOpen: noop, onMore: noop, onRetry: noop };
  const meta = (over: Partial<ConversationMeta> = {}): ConversationMeta => ({ id: "11111111-1111-4111-8111-111111111111", stack: "test", title: "Paper glider wings", links: [], policy: "cloud", state: "current", pinned: true, activity: { lastAt: "2026-11-01T08:00:00.000Z", status: "waiting" }, origin: { kind: "web" }, ...over });

  test("a failed first fetch says so instead of showing an empty history; a failed refresh keeps the rows and says they are stale", () => {
    const failed = renderToStaticMarkup(<OverviewView {...base} error="HTTP 503." />);
    expect(failed).toContain("Conversations could not be loaded: HTTP 503. This is not an empty history.");
    expect(failed).toContain(">Retry</button>");
    expect(failed).not.toContain("No current conversations.");
    const row: OverviewRow = { conversation: meta(), linked: [{ owner: "balance-task", title: null }], latest: { who: "assistant", text: "Broad wings glide." }, match: { who: "user", text: "Which wing shape flies farther?" } };
    const stale = renderToStaticMarkup(<OverviewView {...base} rows={[row]} loadedAt={Date.parse("2026-11-01T08:00:00.000Z")} error="HTTP 500." search="wing" next="c" />);
    expect(stale).toContain("The list could not be refreshed: HTTP 500.");
    expect(stale).toContain("Pinned · ");
    expect(stale).toContain("You: Which wing shape flies farther?");
    expect(stale).toContain("Balance task: unavailable");
    expect(stale).toContain("Waiting for you");
    expect(stale).toContain("Show older");
    const empty = renderToStaticMarkup(<OverviewView {...base} loadedAt={1} search="zebra" />);
    expect(empty).toContain("earlier Studio sessions appear once opened");
  });

  test("an archived conversation opens read-only with Restore and no way to send", () => {
    const detail: ConversationDetail = { conversation: meta({ state: "archived" }), sources: [], draft: "", pending: [], studio: null };
    const html = renderToStaticMarkup(<WorkspaceView detail={detail} entries={[]} draft="" ready busy={false} sending={false} retrying={false} error={null} onDraft={noop} onSend={noop} onLeave={noop} onSaved={noop} organizing={false} onOrganize={noop} />);
    expect(html).toContain(">Restore</button>");
    expect(html).toContain(">Unpin</button>");
    expect(html).toContain("Archived · read-only until you restore it");
    expect(html).toMatch(/<textarea[^>]*disabled=""/);
    expect(html).toMatch(/<button class="desk-btn pri" disabled="">Send<\/button>/);
  });
});
