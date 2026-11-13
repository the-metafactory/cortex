import { BALANCE_PROJECT_CONTRACT } from "../../../conversations/domain-adapters/balance/project-binding";
import { balanceCreateRoute, balanceCreateRouteOf, createBalanceLifecycleWriter, type BalanceCreateLifecycleOptions, type BalanceCreateWriterAuthority } from "./balance-create-cutover";
import type { WriterState } from "../../../conversations/domain-adapters/operations/writer-authority";

export const BALANCE_PROJECT_OWNER = "balance-project";
export const balanceProjectRouteOf = (state: Pick<WriterState, "records">, stack: string) => balanceCreateRouteOf(state, stack, BALANCE_PROJECT_OWNER);
export const balanceProjectRoute = (writers: BalanceCreateWriterAuthority, stack: string) => balanceCreateRoute(writers, stack, BALANCE_PROJECT_OWNER);
export const createBalanceProjectLifecycleWriter = (options: BalanceCreateLifecycleOptions) => createBalanceLifecycleWriter(options, BALANCE_PROJECT_CONTRACT);
export { routedBalanceCreateWriter as routedBalanceProjectWriter } from "./balance-create-cutover";
export type { BalanceCreateCutoverActive as BalanceProjectCutoverActive, BalanceCreateRoute as BalanceProjectRoute, BalanceCreateCutover as BalanceProjectCutover, BalanceCreateWriterAuthority as BalanceProjectWriterAuthority, BalanceCreateLifecycleOptions as BalanceProjectLifecycleOptions } from "./balance-create-cutover";
