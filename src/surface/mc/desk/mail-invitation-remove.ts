import { oneLine } from "./actions";
import type { WriterRunner } from "./create";
import type { ListedMail } from "./mail-actions";
import type { InvitationsConfig } from "./mail-invitation-schema";
import { CommandTimeout } from "./spawn";

export interface DeclinedCopyRequest {
  action: "remove-declined";
  account: string;
  uid: string;
  start: string;
  end?: string;
  recurring?: true;
}

export function declinedCopyRequest(mail: ListedMail): DeclinedCopyRequest | null {
  const inv = mail.invitation;
  if (!mail.account || !inv) return null;
  return { action: "remove-declined", account: mail.account, uid: inv.uid, start: inv.start, ...(inv.end ? { end: inv.end } : {}), ...(inv.recurring ? { recurring: true } : {}) };
}

const KEPT = "The calendar still holds the tentative copy";

const REMOVED = "The tentative copy is removed from your calendar.";

function removedMessage(stdout: string): string {
  let out: unknown;
  try {
    out = JSON.parse(stdout);
  } catch {
    return REMOVED;
  }
  const message = typeof out === "object" && out !== null && "message" in out && typeof out.message === "string" ? out.message.trim() : "";
  return message && message.length <= 300 ? oneLine(message, REMOVED) : REMOVED;
}

export async function removeDeclined(mail: ListedMail, config: InvitationsConfig | undefined, run: WriterRunner): Promise<string | null> {
  const entry = config?.removeOnDecline?.find((e) => e.account === mail.account);
  const req = declinedCopyRequest(mail);
  if (!entry || !req || !config) return null;
  try {
    const out = await run(entry.command, JSON.stringify(req), config.timeoutSeconds * 1000);
    if (out.code !== 0) return `${KEPT}: ${oneLine(out.stderr || out.stdout, `the remove command exited with code ${out.code}.`)}`;
    return removedMessage(out.stdout);
  } catch (err) {
    if (err instanceof CommandTimeout) return `${KEPT}: the remove command ${err.message}.`;
    return `${KEPT}: ${err instanceof Error ? err.message : String(err)}`;
  }
}
