import type { Database } from "bun:sqlite";
import { HOST_NAME_RE as HOST } from "../../../common/host-name";
import type { SourceMail } from "./sources/command";
import { isVip, listVips } from "./vips";

export const SUSPICION_CODES = ["dmarc", "spf", "dkim", "reply-to", "display-name", "link", "classifier"] as const;
export type SuspicionCode = (typeof SUSPICION_CODES)[number];

export interface SuspicionReason {
  code: SuspicionCode;
  text: string;
}

export interface SuspicionContext {
  vips: ReadonlySet<string>;
  vipNames: ReadonlyMap<string, string>;
  ownDomains: readonly string[];
}

export type SuspectMail = Pick<SourceMail, "from" | "headers" | "links">;

const SECOND_LEVEL = new Set(["co", "com", "net", "org", "gov", "ac", "edu", "ne", "or", "go", "gv", "ltd", "plc"]);
const HOST_IN_TEXT = /(?:^|[^a-z0-9@.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![a-z0-9-])/;
const ADDRESS_IN_TEXT = /[^\s<>"'(),;:@]+@((?:[a-z0-9-]+\.)+[a-z]{2,63})/;
const ADDRESS = /<?([^\s<>"'(),;:@]+@([a-z0-9.-]+\.[a-z]{2,63}))>?/;
const URL_LIKE = /^(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})\.?(?::\d{1,5})?(?:[/?#]\S*)?$/;
const FILE_LIKE = /^(?:[a-z0-9-]+\.)?[a-z0-9_-]+\.(?:md|zip|mov|py|sh|rs|pl|ps|tf|mp|sx)$/;
const MAX_LINK_REASONS = 2;

const domainOf = (address: string): string => {
  const a = address.trim().toLowerCase();
  return a.slice(a.lastIndexOf("@") + 1).replace(/\.$/, "");
};

/** The registrable part of a host, e.g. mail.example.co.uk → example.co.uk. A heuristic without the public suffix list. */
export function orgDomain(host: string): string {
  const labels = host.trim().toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1] ?? "";
  const second = labels[labels.length - 2] ?? "";
  const keep = tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-keep).join(".");
}

const sameOrg = (a: string, b: string): boolean => orgDomain(a) === orgDomain(b);

const isOwn = (domain: string, own: readonly string[]): boolean => own.some((d) => domain === d || domain.endsWith(`.${d}`));

const hostOf = (href: string): string | null => {
  if (!URL.canParse(href)) return null;
  const host = new URL(href).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host || null;
};

const normalName = (name: string): string =>
  name.normalize("NFKC").toLowerCase().replace(/["'`´’‘“”]/g, "").replace(/[^\p{L}\p{N}@.\s-]+/gu, " ").replace(/\s+/g, " ").trim();

const nameKey = (name: string): string => normalName(name).split(/[\s,]+/).filter(Boolean).sort().join(" ");

const textDomain = (text: string): string | null => {
  const host = HOST_IN_TEXT.exec(text.toLowerCase())?.[1];
  return host && HOST.test(host) && !/^\d+(\.\d+)+$/.test(host) ? host : null;
};

function authReasons(mail: SuspectMail): SuspicionReason[] {
  const auth = mail.headers?.authResults;
  if (!auth || (!auth.spf && !auth.dkim && !auth.dmarc && auth.dkimDomains === undefined)) return [];
  const from = domainOf(mail.from.address);
  const out: SuspicionReason[] = [];
  if (auth.dmarc === "fail") out.push({ code: "dmarc", text: `DMARC failed: ${from} did not authorize this mail.` });
  if (auth.spf === "fail") out.push({ code: "spf", text: `SPF failed: the server that sent it is not allowed to send for ${from}.` });
  if (auth.dkim === "fail" || auth.dkim === "permerror") {
    out.push({ code: "dkim", text: `Its DKIM signature did not verify (${auth.dkim}).` });
    return out;
  }
  const signers = auth.dkimDomains;
  const signed = signers !== undefined ? signers.some((d) => sameOrg(d, from)) : auth.dkim === "pass";
  const spfAligned = auth.spf === "pass" && auth.spfDomain !== undefined && sameOrg(auth.spfDomain, from);
  const otherwiseAuthenticated = auth.dmarc === "pass" || spfAligned;
  if (!signed && !otherwiseAuthenticated) {
    out.push({ code: "dkim", text: signers?.length ? `It is not signed by ${from} (DKIM), only by ${signers.slice(0, 2).join(" and ")}, and nothing else vouches for the sender.` : `It carries no DKIM signature from ${from}, and nothing else vouches for the sender.` });
  }
  return out;
}

function replyToReason(mail: SuspectMail): SuspicionReason[] {
  const raw = mail.headers?.replyTo;
  if (!raw) return [];
  const from = domainOf(mail.from.address);
  const other = raw
    .toLowerCase()
    .split(",")
    .flatMap((part) => ADDRESS.exec(part)?.[2] ?? [])
    .find((d) => !sameOrg(d, from));
  return other ? [{ code: "reply-to", text: `Replies go to ${other}, not to ${from}, the domain it claims to come from.` }] : [];
}

function displayNameReason(mail: SuspectMail, ctx: SuspicionContext): SuspicionReason[] {
  const name = mail.from.name?.trim();
  if (!name) return [];
  const address = mail.from.address.trim().toLowerCase();
  const from = domainOf(address);
  const lower = name.toLowerCase();
  const shown = ADDRESS_IN_TEXT.exec(lower);
  const shownAddress = shown?.[0];
  if (shownAddress && shown[1] && shownAddress !== address) {
    if (isOwn(shown[1], ctx.ownDomains) && !isOwn(from, ctx.ownDomains)) return [{ code: "display-name", text: `The sender's name shows an address at ${shown[1]}, your own domain, but the mail comes from ${from}.` }];
    if (isVip(ctx.vips, shownAddress) && !isVip(ctx.vips, address)) return [{ code: "display-name", text: `The sender's name shows ${shownAddress}, a VIP, but the mail comes from ${address}.` }];
  }
  const named = textDomain(lower.replace(ADDRESS_IN_TEXT, " "));
  if (named && isOwn(named, ctx.ownDomains) && !isOwn(from, ctx.ownDomains)) return [{ code: "display-name", text: `The sender's name says ${named}, your own domain, but the mail comes from ${from}.` }];
  const vip = ctx.vipNames.get(nameKey(name));
  if (vip && !isVip(ctx.vips, address)) return [{ code: "display-name", text: `The sender's name matches your VIP ${vip}, but ${address} is not on your VIP list.` }];
  return [];
}

const linkTextHost = (text: string): string | null => {
  const t = text.trim().toLowerCase();
  const host = URL_LIKE.exec(t)?.[1];
  if (!host || !HOST.test(host)) return null;
  const schemeOrWww = /^(?:https?:\/\/|www\.)/.test(t);
  return schemeOrWww || !FILE_LIKE.test(t) ? host : null;
};

function linkReasons(mail: SuspectMail): SuspicionReason[] {
  const seen = new Set<string>();
  const out: SuspicionReason[] = [];
  for (const link of mail.links ?? []) {
    const shown = linkTextHost(link.text);
    const target = hostOf(link.href);
    if (!shown || !target || sameOrg(shown, target)) continue;
    const pair = `${shown} ${target}`;
    if (seen.has(pair)) continue;
    seen.add(pair);
    if (out.length < MAX_LINK_REASONS) out.push({ code: "link", text: `A link shows ${shown} but leads to ${target}.` });
  }
  return out;
}

/**
 * Why a mail looks like phishing, in plain words; empty when nothing does. Deterministic over the headers, sender and
 * links the source reported. Verdicts come from an untrusted Authentication-Results header: a failing verdict always
 * counts, and a "pass" only excuses a missing DKIM signature; it never clears a finding from the sender, Reply-To or links.
 */
export function suspicionOf(mail: SuspectMail, ctx: SuspicionContext, classifierSuspicious = false): SuspicionReason[] {
  return [
    ...authReasons(mail),
    ...replyToReason(mail),
    ...displayNameReason(mail, ctx),
    ...linkReasons(mail),
    ...(classifierSuspicious ? [{ code: "classifier" as const, text: "The mail classifier judged it to look like phishing." }] : []),
  ];
}

export const isSuspicious = (mail: SuspectMail, ctx: SuspicionContext): boolean => suspicionOf(mail, ctx).length > 0;

const MIN_VIP_NAME = 5;

/** The VIP list and its names, from the Desk's VIP table, plus the stack's own domains. */
export function suspicionContext(db: Database, ownDomains: readonly string[] = []): SuspicionContext {
  const vips = listVips(db);
  const vipNames = new Map<string, string>();
  for (const v of vips) {
    const key = v.label ? nameKey(v.label) : "";
    if (v.label && key.replace(/\s/g, "").length >= MIN_VIP_NAME) vipNames.set(key, v.label);
  }
  return { vips: new Set(vips.map((v) => v.address)), vipNames, ownDomains: ownDomains.map((d) => d.toLowerCase()) };
}

export const suspicionLine = (reasons: readonly SuspicionReason[]): string =>
  `This may be phishing: ${reasons.map((r) => r.text.replace(/\.$/, "")).join("; ")}.`;
