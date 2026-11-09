import { afterEach, expect, test } from "bun:test";
import { openConversationHost, type HostStatus } from "../../../conversations/host";
import { answering, scratchDirs } from "../../../conversations/__tests__/fixtures/scratch";
import { handleConversations } from "../api/conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../api/mutation-guard";

const dirs = scratchDirs("conversation-request-id-");
const statuses: HostStatus[] = [];
afterEach(async () => {
  for (const status of statuses.splice(0)) if (status.state === "ready") await status.host.close();
  await dirs.clean();
});
const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() };

test("a repeated requestId returns 200 and the same conversation; no requestId starts a new one each time", async () => {
  const dir = await dirs.make();
  const status = await openConversationHost({ dir, stack: "request-id-test", label: "request-id-test", expectedLabel: "request-id-test", lanes: { cloud: { provider: "test", model: "m" } }, turns: answering(() => "ok") });
  statuses.push(status);
  const post = (body: unknown) => {
    const request = new Request("http://127.0.0.1:8767/api/conversations", { method: "POST", headers: { host: "127.0.0.1:8767", "content-type": "application/json" }, body: JSON.stringify(body) });
    return handleConversations(request, new URL(request.url), guard, () => status);
  };
  const requestId = crypto.randomUUID();
  const body = { title: "Routine from Daily digest", origin: { kind: "web" }, requestId };
  const first = await post(body);
  const second = await post(body);
  expect(first.status).toBe(201);
  expect(second.status).toBe(200);
  const a = await first.json() as { conversation: { id: string } };
  const b = await second.json() as { conversation: { id: string } };
  expect(b.conversation.id).toBe(a.conversation.id);
  const plain = { title: "Plain", origin: { kind: "web" } };
  const [p1, p2] = [await post(plain), await post(plain)];
  expect([p1.status, p2.status]).toEqual([201, 201]);
  expect((await post({ ...plain, requestId: "nope" })).status).toBe(400);
});
