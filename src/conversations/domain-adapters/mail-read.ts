import type { DeskAdapterConnection, DeskListedMail, DeskMailHealth, DeskMailListing, DeskMailReadBridge } from "../../desk-sdk";
import type { RestrictionRecord } from "../authority-records";
import { DeskBackendUnavailableError } from "./package-backend";
import type { ObjectReference } from "./types";

/** One mail as a Mail source listed it. A native `SourceReading` mail entry satisfies this shape. */
export interface MailSourceItem {
  readonly id: string;
  readonly account?: string;
  readonly from: { readonly name?: string; readonly address: string };
  readonly subject: string;
  readonly receivedAt: string;
  readonly unread: boolean;
  readonly firstParagraph?: string;
}

/** One Mail source's last listing, as the host's source cache holds it; `error` is set when that run failed. */
export interface MailSourceListing {
  readonly id: string;
  readonly readAt: number;
  readonly error: string | null;
  readonly mail: readonly MailSourceItem[];
}

/** The host's binding of one adapter connection to one Mail source and one account (cortex#3294 Q7). */
export interface MailConnectionBinding {
  readonly adapterId: string;
  readonly connectionId: string;
  readonly sourceId: string;
  readonly account: string;
  readonly dataPolicy?: "local" | "cloud";
}

/** What the host supplies the loader so out-of-tree adapters can read listed mail. */
export interface MailReadSource {
  connections(): readonly MailConnectionBinding[];
  listings(): readonly MailSourceListing[];
}

export const MAIL_FIRST_PARAGRAPH_MAX = 1000;
const PARAGRAPH_BREAK = /\r?\n[^\S\r\n]*\r?\n/;
const ADAPTER_UNAVAILABLE = { code: "adapter_unavailable", message: "This adapter generation is not published; it reads no mail." } as const;
const NOT_LISTED: DeskMailHealth = { state: "stale", code: "not_listed" };
const PROVIDER_FAILURE: DeskMailHealth = { state: "stale", code: "provider_failure" };

const firstParagraph = (text: string): string => (text.split(PARAGRAPH_BREAK)[0] ?? "").trim().slice(0, MAIL_FIRST_PARAGRAPH_MAX);

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
 * adapter, only mail the bound source listed under the bound account, and refuses once the generation is fenced.
 */
export function mailReadBridge(source: MailReadSource | undefined, adapterId: string, published: () => boolean): DeskMailReadBridge {
  return {
    listed(connection) {
      if (!published()) return Promise.reject(new DeskBackendUnavailableError(ADAPTER_UNAVAILABLE));
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
