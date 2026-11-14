// glossary-ignore: host, run, data, message, body
import type { DeskAdapterConnection, DeskListedMail, DeskMailHealth, DeskMailListing, DeskMailReadBridge } from "../../desk-sdk";
import type { RestrictionRecord } from "../authority-records";
import { admittedCallKey, connectionKey, DeskBackendUnavailableError } from "./package-backend";
import type { ObjectReference } from "./types";
import type { MailConnectionBinding, MailReadSource, MailSourceItem, MailSourceListing } from "./mail-read-source";

export type { MailConnectionBinding, MailReadSource, MailSourceItem, MailSourceListing } from "./mail-read-source";

export const MAIL_FIRST_PARAGRAPH_MAX = 1000;
const PARAGRAPH_BREAK = /\r?\n[^\S\r\n]*\r?\n/;
const ADAPTER_UNAVAILABLE = { code: "adapter_unavailable", message: "This adapter generation is not published; it reads no mail." } as const;
const OUTSIDE_ADMITTED_CALL = { code: "mail_read_unadmitted", message: "Mail is read only inside a call the Cortex runtime admitted for that same connection." } as const;

const NOT_LISTED: DeskMailHealth = { state: "stale", code: "not_listed" };
const PROVIDER_FAILURE: DeskMailHealth = { state: "stale", code: "provider_failure" };

const firstParagraph = (text: string): string => (text.trim().split(PARAGRAPH_BREAK)[0] ?? "").trim().slice(0, MAIL_FIRST_PARAGRAPH_MAX);

function bindingFor(source: MailReadSource, adapterId: string, connection: DeskAdapterConnection): MailConnectionBinding | null {
  if (connection.adapterId !== adapterId) return null;
  const matches = source.connections().filter(binding => binding.adapterId === adapterId && binding.connectionId === connection.connectionId);
  const [binding] = matches;
  return matches.length === 1 && binding && binding.account.trim() !== "" && binding.sourceId !== "" ? binding : null;
}

function listedMail(binding: MailConnectionBinding, item: MailSourceItem): DeskListedMail {
  const paragraph = item.firstParagraph === undefined ? undefined : firstParagraph(item.firstParagraph);
  return {
    ref: { connection: binding.connectionId, messageId: item.id },
    account: binding.account,
    from: { ...(item.from.name === undefined ? {} : { name: item.from.name }), address: item.from.address },
    subject: item.subject,
    receivedAt: item.receivedAt,
    unread: item.unread,
    ...(paragraph ? { firstParagraph: paragraph } : {}),
  };
}

function listingOf(binding: MailConnectionBinding, listing: MailSourceListing | undefined): DeskMailListing {
  const connection = { adapterId: binding.adapterId, connectionId: binding.connectionId };
  if (!listing) return { connection, account: binding.account, health: NOT_LISTED, mail: [] };
  const seen = new Set<string>();
  const mail = listing.mail.filter(item => {
    if (item.account !== binding.account || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  }).map(item => listedMail(binding, item));
  const health: DeskMailHealth = listing.error === null ? { state: "fresh", listedAt: new Date(listing.readAt).toISOString() } : PROVIDER_FAILURE;
  return { connection, account: binding.account, health, mail };
}

/**
 * Builds the Mail read bridge one adapter generation receives. It serves only connections the host binds to this
 * adapter, only from inside a backend call the host admitted for that same connection, only mail the bound source
 * listed under the bound account, and refuses once the generation is fenced.
 */
export function mailReadBridge(source: MailReadSource | undefined, adapterId: string, published: () => boolean): DeskMailReadBridge {
  return {
    listed(connection) {
      if (!published()) return Promise.reject(new DeskBackendUnavailableError(ADAPTER_UNAVAILABLE));
      if (admittedCallKey() !== connectionKey(connection)) return Promise.reject(new DeskBackendUnavailableError(OUTSIDE_ADMITTED_CALL));
      const binding = source ? bindingFor(source, adapterId, connection) : null;
      if (!source || !binding) return Promise.resolve(null);
      return Promise.resolve(listingOf(binding, source.listings().find(listing => listing.id === binding.sourceId)));
    },
  };
}

/** The read restriction the host publishes for a Mail connection's destination. A connection with no explicit data policy is local. */
export function mailReadRestriction(binding: MailConnectionBinding, destination: ObjectReference, metadata: Omit<RestrictionRecord, "source" | "egress">): RestrictionRecord {
  if (destination.adapterId !== binding.adapterId || destination.connectionId !== binding.connectionId) throw new Error("The destination does not belong to this Mail connection.");
  return { ...metadata, source: destination, egress: binding.dataPolicy ?? "local" };
}
