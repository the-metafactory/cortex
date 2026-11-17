import { BALANCE_INBOX_TASK_CONTRACT } from "../../../conversations/domain-adapters/balance/inbox-binding";
import { createBalanceBinding } from "../../../conversations/domain-adapters/balance/create-binding";
import type { ListedMail } from "./mail-actions";
import { balanceCreateRoute, createBalanceLifecycleWriter, type BalanceCreateCutoverActive, type BalanceCreateLifecycleOptions, type BalanceCreateWriterAuthority } from "./balance-create-cutover";
import type { DeskItem } from "./types";

export const balanceInboxRoute = (writers: BalanceCreateWriterAuthority, stack: string) => balanceCreateRoute(writers, stack, BALANCE_INBOX_TASK_CONTRACT);
interface BalanceInboxLifecycleOptions extends BalanceCreateLifecycleOptions {
  deskItems: () => Promise<DeskItem[]>;
  listedMail?: (key: string) => ListedMail | null;
}
export function createBalanceInboxLifecycleWriter(options: BalanceInboxLifecycleOptions) {
  const binding = (route: BalanceCreateCutoverActive) => options.binding?.(route) ?? createBalanceBinding({ stack: options.stack, connectionId: route.connectionId, db: options.db, desk: options.desk, areas: options.areas, journal: options.journal, deskItems: options.deskItems, ...(options.listedMail ? { listedMail: options.listedMail } : {}), supportDeclarationId: options.supportDeclarationId, ...(options.now ? { now: options.now } : {}) }, BALANCE_INBOX_TASK_CONTRACT);
  return createBalanceLifecycleWriter({ ...options, binding }, BALANCE_INBOX_TASK_CONTRACT);
}
export type { BalanceCreateCutover as BalanceInboxCutover } from "./balance-create-cutover";
