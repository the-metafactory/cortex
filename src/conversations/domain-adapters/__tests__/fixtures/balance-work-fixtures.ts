import { BALANCE_CONNECTION, type BalanceReadRig } from "./balance-read-fixtures";
import { balanceWorkQuery, balanceWorkSchemaRef } from "../../../../surface/mc/desk/balance-work-reader";
import type { ToolSession } from "../../../tools/capabilities";
import type { WorkReader } from "../../../tools/work-context";

export const sessionOf = (rig: BalanceReadRig, policy: "local" | "cloud", transport: "web" | "discord" = "web"): ToolSession => ({
  principal: "principal-example",
  conversationId: rig.rig.approval.snapshot.provenance.conversationId,
  transport,
  route: "local",
  policy,
  scope: [],
});

export const queryFor = (rig: BalanceReadRig, policy: "local" | "cloud" = "cloud") => balanceWorkQuery({
  connectionId: BALANCE_CONNECTION,
  areas: rig.areas.map(area => ({ ...area, policy })),
  runner: rig.runner,
  context: rig.rig.context,
  sink: rig.rig.sink,
  sends: rig.rig.calls.sends,
  inputSchemaRef: balanceWorkSchemaRef({ taskQuery: rig.taskQueryBinding.inputSchemaRef, taskRead: rig.taskReadBinding.inputSchemaRef, projectQuery: rig.adapter.readBindings.find(binding => binding.capabilityId === "balance.project.query")!.inputSchemaRef, projectRead: rig.adapter.readBindings.find(binding => binding.capabilityId === "balance.project.read")!.inputSchemaRef }),
});

export const legacyTask: WorkReader = {
  search: async () => ({ items: [{ kind: "balance-task", id: "task-legacy", title: "Legacy task", status: "open", summary: "Legacy summary", policy: "cloud", area: "Lab", url: "?desk=balance&balance-item=task-legacy", observedAt: Date.now() }], more: false }),
  read: async id => ({ state: "available", object: { kind: "balance-task", id, title: "Legacy task", status: "open", summary: "Legacy summary", policy: "cloud", area: "Lab", url: `?desk=balance&balance-item=${encodeURIComponent(id)}`, observedAt: Date.now() } }),
};
