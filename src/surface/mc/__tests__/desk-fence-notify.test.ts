import { expect, test } from "bun:test";
import { broadcastDeskFence, deskFenceNotice } from "../notifications";
import type { WsClientRegistry } from "../ws/client-registry";
import type { PrincipalNotice } from "../../../conversations/domain-adapters/operations/triggers";

const notice: PrincipalNotice = {
  version: 1, notificationId: "notice-example", at: "2026-11-09T00:00:00.000Z", effect: "mutation-off", trigger: "duplicate_owner_object",
  target: { adapterId: "balance", connectionId: "connection-example", capabilityId: "balance.task.create", stack: "test", owner: "synthetic-owner" },
  targetKey: "[\"balance\",\"connection-example\",\"balance.task.create\"]",
  title: "An owner lookup returned two objects for one operation.",
  body: "The binding's mutation is off, its drafts are kept and its reads continue.",
  delivered: true,
};

test("a desk fence notice reaches the dashboard as an opaque identification-only frame", () => {
  const sent: unknown[] = [];
  const registry = { broadcast: (message: unknown) => { sent.push(message); } } as unknown as WsClientRegistry;
  broadcastDeskFence(registry, deskFenceNotice(notice));
  expect(sent).toEqual([{ type: "desk.fence", notice: { notificationId: "notice-example", binding: "balance/balance.task.create", effect: "mutation-off", trigger: "duplicate_owner_object", at: "2026-11-09T00:00:00.000Z", title: notice.title, body: notice.body } }]);
});
