import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { ConversationHost } from "../../host";

export async function exerciseCloudWorkSource(host: ConversationHost, title: string): Promise<string> {
  const { id } = await host.create({ title, policy: "cloud", links: [], origin: { kind: "web" } }, "principal-example");
  await host.submit(id, { inputId: randomUUID(), transport: "web", text: "Read the related work.", mode: "queue" });
  await host.waitForIdle(id);
  assert.equal((await host.meta(id)).policy, "cloud");
  return id;
}
