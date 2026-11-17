import assert from "node:assert/strict";
import { join } from "node:path";
import { openConversationHost, type HostStatus } from "../../src/conversations/host";
import type { TurnCall } from "../../src/conversations/model";

const answering = (): TurnCall => async request => ({ text: "ok", session: request.session, resumed: false });

export async function openProbeHost(root: string, label: string): Promise<Extract<HostStatus, { state: "ready" }>> {
  const status = await openConversationHost({ dir: join(root, "conversations"), stack: "test", label, expectedLabel: label, lanes: { local: { provider: "test", model: "test-model" }, cloud: { provider: "test", model: "test-model" } }, turns: answering() });
  assert.equal(status.state, "ready", status.state === "unavailable" ? status.reason : "the conversation host did not open");
  return status as Extract<HostStatus, { state: "ready" }>;
}
