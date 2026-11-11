import { openBalanceReadRig, seedStudioThread } from "../../../../conversations/domain-adapters/__tests__/fixtures/balance-read-fixtures";
import { HandledLedger } from "../actions";
import { composeDesk, type AdapterCapabilityAdmission, type DeskOptions, type DeskRuntime } from "../compose";
import { SourceCache, type SourceMail } from "../sources/command";
import { attentionRig, type AttentionOptions } from "./adapter-attention-fixtures";

export const BALANCE_ATTENTION_MAIL: SourceMail = { kind: "mail", id: "budget@example.org", from: { name: "Ada Boss", address: "boss@example.org" }, subject: "Budget", receivedAt: "2026-11-01T08:00:00.000Z", unread: true, url: "message://%3Cbudget%3E", account: "work" };

export async function openBalanceAttentionStack(now: number, options: AttentionOptions = {}, studioLink = true) {
  const balance = await openBalanceReadRig();
  let synthetic: Awaited<ReturnType<typeof attentionRig>> | undefined;
  try {
    const active = await attentionRig("local", options);
    synthetic = active;
    const db = balance.db;
    if (studioLink) seedStudioThread(db);
    const desk: DeskOptions = {
      enabled: true, displayName: "Probe", topN: 5, rangerUrl: "",
      areas: balance.areas.map(area => ({ ...area, repos: [], goals: [] })),
      sources: [{ id: "work-mail", command: ["desk-mail"], everySeconds: 300, timeoutSeconds: 30 }],
      mailActions: { trash: ["/opt/adapters/bin/desk-mail-trash.ts"], timeoutSeconds: 20 },
    };
    const sourceCache = new SourceCache(() => Promise.resolve(JSON.stringify({ items: [BALANCE_ATTENTION_MAIL] })));
    const attention = [() => balance.attentionAccess(), active.feature];
    const runtime: DeskRuntime = {
      options: desk, ledger: new HandledLedger(), sourceCache,
      adapterAttention: () => Promise.resolve({ feature: active.feature, close: () => undefined }),
      adapterCapability: async (request): Promise<AdapterCapabilityAdmission> => (await active.rig.service.admitRowCapability(active.rig.context, request)).kind === "allowed" ? { kind: "allowed" } : { kind: "denied", reason: "The host authority does not permit this change." },
    };
    return {
      balance, synthetic: active, db, desk, runtime,
      compose: (at = now) => composeDesk(db, desk, undefined, { now: at, sourceCache, handled: runtime.ledger, adapterDay: () => balance.reader(), adapterAttention: attention }),
      async close() { await Promise.all([balance.close(), active.rig.close()]); },
    };
  } catch (error) {
    await Promise.all([balance.close(), synthetic?.rig.close()]);
    throw error;
  }
}
