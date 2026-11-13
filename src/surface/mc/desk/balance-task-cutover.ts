import { BALANCE_TASK_CONTRACT } from "../../../conversations/domain-adapters/balance/task-binding";
import { balanceCreateRoute, balanceCreateRouteOf, createBalanceLifecycleWriter, type BalanceCreateLifecycleOptions, type BalanceCreateWriterAuthority } from "./balance-create-cutover";
import type { WriterState } from "../../../conversations/domain-adapters/operations/writer-authority";

export const BALANCE_TASK_OWNER = BALANCE_TASK_CONTRACT.owner;
export const balanceTaskRouteOf = (state: Pick<WriterState, "records">, stack: string) => balanceCreateRouteOf(state, stack, BALANCE_TASK_CONTRACT);
export const balanceTaskRoute = (writers: BalanceCreateWriterAuthority, stack: string) => balanceCreateRoute(writers, stack, BALANCE_TASK_CONTRACT);
export const createBalanceTaskLifecycleWriter = (options: BalanceCreateLifecycleOptions) => createBalanceLifecycleWriter(options, BALANCE_TASK_CONTRACT);
export { routedBalanceCreateWriter as routedBalanceTaskWriter } from "./balance-create-cutover";
export type { BalanceCreateCutoverActive as BalanceTaskCutoverActive, BalanceCreateRoute as BalanceTaskRoute, BalanceCreateCutover as BalanceTaskCutover, BalanceCreateWriterAuthority as BalanceTaskWriterAuthority, BalanceCreateLifecycleOptions as BalanceTaskLifecycleOptions } from "./balance-create-cutover";
