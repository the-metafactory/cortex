import { BALANCE_CONNECTION, type BalanceReadRig } from "./balance-read-fixtures";
import { balanceWorkQuery, type BalanceWorkArea } from "../../../../surface/mc/desk/balance-work-reader";
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

export const connectedAreas = (rig: BalanceReadRig, policy: "local" | "cloud"): BalanceWorkArea[] =>
  rig.rig.connection.readDestinations.flatMap(destination => {
    const area = rig.areas.find(candidate => candidate.id === destination.canonicalId);
    return area ? [{ id: area.id, label: area.label, policy }] : [];
  });

export const queryFor = (rig: BalanceReadRig, policy: "local" | "cloud" = "cloud") => balanceWorkQuery({
  connectionId: BALANCE_CONNECTION,
  areas: connectedAreas(rig, policy),
  runner: rig.runner,
  context: rig.rig.context,
  sink: rig.rig.sink,
  inputSchemaRef: {
    "balance.task.query": rig.taskQueryBinding.inputSchemaRef,
    "balance.task.read": rig.taskReadBinding.inputSchemaRef,
    "balance.project.query": rig.adapter.readBindings.find(binding => binding.capabilityId === "balance.project.query")!.inputSchemaRef,
    "balance.project.read": rig.adapter.readBindings.find(binding => binding.capabilityId === "balance.project.read")!.inputSchemaRef,
  },
});

export const legacyTask: WorkReader = {
  search: async () => ({ items: [{ kind: "balance-task", id: "task-legacy", title: "Legacy task", status: "open", summary: "Legacy summary", policy: "cloud", area: "Lab", url: "?desk=balance&balance-item=task-legacy", observedAt: Date.now() }], more: false }),
  read: async id => ({ state: "available", object: { kind: "balance-task", id, title: "Legacy task", status: "open", summary: "Legacy summary", policy: "cloud", area: "Lab", url: `?desk=balance&balance-item=${encodeURIComponent(id)}`, observedAt: Date.now() } }),
};
