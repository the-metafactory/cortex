import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { answering, scratchHosts } from "./fixtures/scratch";
import { openConversationHost, type ConversationHost, type HostOptions } from "../host";
import type { TurnCall, TurnRequest } from "../model";
import { WorkspaceView } from "../../surface/mc/dashboard-v2/components/desk-conversation";
import { entryViews } from "../../surface/mc/dashboard-v2/lib/conversations";

const LABEL = "ai.meta-factory.cortex.test";
const lane = { provider: "test", model: "cloud-model" };
const { dirs, hosts } = scratchHosts("conversations-pi-record-");

async function open(extra: Partial<HostOptions>): Promise<ConversationHost> {
  const status = await openConversationHost({ dir: await dirs.make(), stack: "test", label: LABEL, expectedLabel: LABEL, lanes: { cloud: lane }, turns: answering(() => "ok"), ...extra });
  if (status.state !== "ready") throw new Error(status.reason);
  hosts.push(status.host);
  return status.host;
}

const input = (inputId: string, text: string) => ({ inputId, transport: "web" as const, text, mode: "queue" as const });
const create = (host: ConversationHost) => host.create({ title: "Synthetic", links: [], origin: { kind: "web" }, policy: "cloud" }, "local-principal@loopback");

describe("pi turns in the conversation record", () => {
  test("every tool call of a turn is recorded as tool activity between the input and the reply", async () => {
    const turns: TurnCall = async request => {
      await request.activity({ callId: "t1", tool: "soma_context", args: { action: "memory_recall", query: "Field Notes" }, outcome: "done", result: "G7" });
      await request.activity({ callId: "t2", tool: "bash", args: { command: "touch /tmp/x" }, outcome: "refused", result: "Tool bash not found" });
      return { text: "G7 is the Field Notes goal.", session: request.session, resumed: false };
    };
    const host = await open({ turns });
    const conversation = await create(host);
    await host.submit(conversation.id, input("in-1", "Which of my goals is about Field Notes?"));
    await host.waitForIdle(conversation.id);
    const entries = (await host.entries(conversation.id, 100, undefined)).entries.filter(e => e.kind !== "pi.system");
    expect(entries.map(e => e.kind)).toEqual(["cortex.input", "cortex.tool-activity", "cortex.tool-activity", "pi.assistant"]);
    expect(entries[1]?.data).toMatchObject({ tool: "soma_context", outcome: "done", result: "G7" });
    expect(entries[2]?.data).toMatchObject({ tool: "bash", outcome: "refused" });
    expect(entryViews(entries[1] ?? { id: "", kind: "" })).toEqual([{ kind: "activity", text: "Read with soma_context (memory_recall · Field Notes)." }]);
    expect(entryViews(entries[2] ?? { id: "", kind: "" })[0]?.text).toBe("Refused bash: it is not on the read-only tool allowlist, so nothing ran.");
  });

  test("a failed pi turn shows an explicit failure with Retry, keeps the input and tries no other engine", async () => {
    let calls = 0;
    const turns: TurnCall = () => { calls += 1; return Promise.reject(new Error("pi was not found at /nowhere/pi. No other engine is used.")); };
    const host = await open({ turns });
    const conversation = await create(host);
    await host.submit(conversation.id, input("in-1", "hello"));
    await host.waitForIdle(conversation.id);
    expect(calls).toBe(1);
    const entries = (await host.entries(conversation.id, 100, undefined)).entries;
    expect(entries.filter(e => e.role === "user").map(e => e.text)).toEqual(["hello"]);
    const failed = entries.find(e => e.error);
    expect(failed?.error).toBe("pi was not found at /nowhere/pi. No other engine is used.");
    const detail = await host.detail(conversation.id);
    const html = renderToStaticMarkup(<WorkspaceView detail={{ ...detail, studio: null }} entries={entries} draft="" ready busy={false} sending={false} retrying={false} error={null} onDraft={() => undefined} onSend={() => undefined} onRetry={() => undefined} onLeave={() => undefined} onSaved={() => undefined} organizing={false} onOrganize={() => undefined} />);
    expect(html).toContain("Ivy could not answer on test/cloud-model: pi was not found at /nowhere/pi.");
    expect(html).toContain(">Retry</button>");
  });

  test("the next turn resumes the previous pi session natively; a lost session is reconstructed and recorded", async () => {
    const seen: TurnRequest[] = [];
    let resumes = true;
    const turns: TurnCall = request => { seen.push(request); return Promise.resolve({ text: `answer ${seen.length}`, session: request.resume && resumes ? request.resume : request.session, resumed: Boolean(request.resume && resumes) }); };
    const host = await open({ turns });
    const conversation = await create(host);
    for (const [i, text] of ["one", "two"].entries()) {
      await host.submit(conversation.id, input(`in-${i}`, text));
      await host.waitForIdle(conversation.id);
    }
    expect(seen[0]).toMatchObject({ resume: null, history: [], prompt: "one", conversationId: conversation.id, route: "cloud" });
    expect(seen[0]?.session.startsWith(`${conversation.id}.cloud.0.`)).toBe(true);
    expect(seen[1]?.resume).toBe(seen[0]?.session);
    const kinds = async (): Promise<string[]> => (await host.entries(conversation.id, 100, undefined)).entries.map(e => e.kind);
    expect(await kinds()).not.toContain("cortex.continuation");
    resumes = false;
    await host.submit(conversation.id, input("in-3", "three"));
    await host.waitForIdle(conversation.id);
    expect(seen[2]?.history.map(t => t.content)).toEqual(["one", "answer 1", "two", "answer 2"]);
    const continuation = (await host.entries(conversation.id, 100, undefined)).entries.find(e => e.kind === "cortex.continuation");
    expect(continuation?.data).toMatchObject({ mode: "reconstructed", reason: "session-missing", to: "cloud" });
    expect(entryViews(continuation ?? { id: "", kind: "" })[0]?.text).toBe("Ivy's earlier pi session was not found, so the working context was rebuilt from this conversation's record.");
  });
});
