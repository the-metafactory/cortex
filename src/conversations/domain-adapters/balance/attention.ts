import type { ReadBinding, RowCapability } from "../reads/types";

export type BalanceTaskAttention = NonNullable<ReadBinding["attention"]>;

export const BALANCE_TASK_ATTENTION: BalanceTaskAttention = {
  pointer: "/why",
  badge: "/badge",
  owner: "/owner",
};

export const BALANCE_TASK_ROW_CAPABILITIES: readonly RowCapability[] = [];

export function balanceTaskRowCapabilities(): readonly RowCapability[] {
  return BALANCE_TASK_ROW_CAPABILITIES;
}
