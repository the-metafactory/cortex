import type { Database } from "bun:sqlite";
import { lookup as dnsLookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { ListedMail, TrashLedger } from "./mail-actions";
import { logMailDecision, mailFeatures, queryMailLog, type MailLogAction } from "./mail-log";
import { refuse, type MoveResult } from "./mail-move";
import { createRule, listRules, matchesRule, type MailRule, type RuleChange } from "./mail-rules";
import { suspicionOf, type SuspicionContext } from "./mail-suspicion";
import type { SourceMail } from "./sources/command";
import { DEFAULT_UNSUBSCRIBE, type UnsubscribeConfig } from "./mail-unsubscribe-schema";
import { isVip } from "./vips";

export { DEFAULT_UNSUBSCRIBE, UNSUBSCRIBE_SQL, type UnsubscribeConfig } from "./mail-unsubscribe-schema";

export type UnsubscribeMethod = { kind: "one-click"; url: string } | { kind: "page"; url: string };

export type UnsubscribeOffer =
  | { kind: "one-click"; url: string; host: string; dismissed: number; failed?: string }
  | { kind: "page"; url: string; host: string; dismissed: number }
  | { kind: "rule"; at: number; host: string };

export interface UnsubscribeView {
  kind: UnsubscribeOffer["kind"];
  host: string;
  url?: string;
}

const ONE_CLICK = "list-unsubscribe=one-click";
const URI_RE = /<([^>]{1,2000})>/g;

const uriOf = (raw: string): URL | null => {
  const text = raw.replace(/\s+/g, "");
  if (!URL.canParse(text)) return null;
  const url = new URL(text);
  return ["https:", "http:", "mailto:"].includes(url.protocol) ? url : null;
};

/** The unsubscribe the List-Unsubscribe headers offer (RFC 2369, RFC 8058): One-Click needs an HTTPS URI and the exact List-Unsubscribe-Post value. */
export function unsubscribeMethod(headers: SourceMail["headers"]): UnsubscribeMethod | null {
  const raw = headers?.listUnsubscribe;
  if (!raw) return null;
  const uris: URL[] = [];
  URI_RE.lastIndex = 0;
  for (let m = URI_RE.exec(raw); m !== null; m = URI_RE.exec(raw)) {
    const url = m[1] === undefined ? null : uriOf(m[1]);
    if (url) uris.push(url);
  }
  const secure = uris.find((u) => u.protocol === "https:");
  const post = headers.listUnsubscribePost?.replace(/\s+/g, "").toLowerCase();
  if (secure && post === ONE_CLICK) return { kind: "one-click", url: secure.href };
  const page = secure ?? uris.find((u) => u.protocol === "http:") ?? uris.find((u) => u.protocol === "mailto:");
  return page ? { kind: "page", url: page.href } : null;
}

const hostOf = (url: string): string => {
  const u = new URL(url);
  return u.protocol === "mailto:" ? u.pathname.slice(u.pathname.lastIndexOf("@") + 1) || u.pathname : u.hostname;
};

const listIdOf = (mail: Pick<SourceMail, "headers">): string | null => {
  const id = mail.headers?.listId?.trim();
  return id === undefined || id === "" ? null : id;
};

/** One list, by List-Id when the mail has one, otherwise by sender address. */
export const listKey = (mail: Pick<SourceMail, "from" | "headers">): string => {
  const id = listIdOf(mail);
  return id ? `list:${id.toLowerCase()}` : `sender:${mail.from.address.trim().toLowerCase()}`;
};

const DISMISSED = new Set<MailLogAction>(["archive", "trash", "unimportant"]);

/**
 * How many of the list's mails the principal last archived or deleted without reading them, on the Desk or in the mail
 * client (rules and corrections do not count). The Desk lists unread mail only, and the client log records a move as
 * such only when the mail left the list unread, so each counted move was of an unread mail.
 */
export function unreadDismissals(db: Database, mail: Pick<SourceMail, "from" | "headers">): number {
  const listId = listIdOf(mail);
  const entries = queryMailLog(db, { ...(listId ? { listId } : { sender: mail.from.address }), limit: 5000 }).filter((e) => e.where === "desk" || e.where === "client" || e.where === "conversation");
  const latest = new Map<string, MailLogAction>();
  for (const e of entries) if (!latest.has(e.messageId)) latest.set(e.messageId, e.action);
  return [...latest.values()].filter((a) => DISMISSED.has(a)).length;
}

interface AttemptRow {
  status: string;
  host: string;
  http_status: number | null;
  error: string | null;
  created_at: number;
}

const attempt = (db: Database, key: string, onlyOk: boolean): AttemptRow | null =>
  db.query<AttemptRow, [string]>(`SELECT status, host, http_status, error, created_at FROM desk_mail_unsubscribes WHERE list_key = ?${onlyOk ? " AND status = 'ok'" : ""} ORDER BY created_at DESC, id DESC LIMIT 1`).get(key);

interface ListFacts {
  done: () => AttemptRow | null;
  last: () => AttemptRow | null;
  dismissed: () => number;
}

const once = <T>(read: () => T): (() => T) => {
  let known: { value: T } | null = null;
  return () => {
    known ??= { value: read() };
    return known.value;
  };
};

const listFacts = (db: Database, mail: SourceMail): ListFacts => {
  const key = listKey(mail);
  return { done: once(() => attempt(db, key, true)), last: once(() => attempt(db, key, false)), dismissed: once(() => unreadDismissals(db, mail)) };
};

export interface OfferContext {
  config: UnsubscribeConfig;
  suspicion: SuspicionContext;
  rules: readonly MailRule[];
  flagged?: ReadonlySet<string>;
}

/**
 * What a mail's card offers: "Unsubscribe" (One-Click) or "Open unsubscribe page" once the principal has archived or
 * deleted at least `after` of the list's mails unread; after a successful unsubscribe, an archive rule for what still
 * arrives, until one exists. Never for a VIP or a mail that looks suspicious.
 */
export function unsubscribeOffer(db: Database, mail: SourceMail, ctx: OfferContext, facts: (m: SourceMail) => ListFacts = (m) => listFacts(db, m)): UnsubscribeOffer | null {
  if (!ctx.config.enabled) return null;
  if (isVip(ctx.suspicion.vips, mail.from.address)) return null;
  if (suspicionOf(mail, ctx.suspicion, ctx.flagged?.has(mail.id) === true).length > 0) return null;
  const known = facts(mail);
  const done = known.done();
  if (done) return ctx.rules.some((r) => r.on && r.action !== "digest" && matchesRule(r, mail)) ? null : { kind: "rule", at: done.created_at, host: done.host };
  const method = unsubscribeMethod(mail.headers);
  if (!method) return null;
  const dismissed = known.dismissed();
  if (dismissed < ctx.config.after) return null;
  const host = hostOf(method.url);
  if (method.kind === "page") return { kind: "page", url: method.url, host, dismissed };
  const last = known.last();
  return { kind: "one-click", url: method.url, host, dismissed, ...(last?.status === "failed" && last.error ? { failed: last.error } : {}) };
}

/** Offers for many mails, reading the log and the attempts once per list rather than once per mail. */
export function unsubscribeOffers(db: Database, mails: readonly SourceMail[], ctx: OfferContext): Map<string, UnsubscribeOffer> {
  const byList = new Map<string, ListFacts>();
  const facts = (m: SourceMail): ListFacts => {
    const key = listKey(m);
    const known = byList.get(key) ?? listFacts(db, m);
    byList.set(key, known);
    return known;
  };
  const out = new Map<string, UnsubscribeOffer>();
  for (const m of mails) {
    const offer = unsubscribeOffer(db, m, ctx, facts);
    if (offer) out.set(m.id, offer);
  }
  return out;
}

export const unsubscribeView = (offer: UnsubscribeOffer): UnsubscribeView =>
  offer.kind === "page" ? { kind: "page", host: offer.host, url: offer.url } : { kind: offer.kind, host: offer.host };

const V4_BLOCKED: [number, number][] = [
  [0x00000000, 8], [0x0a000000, 8], [0x64400000, 10], [0x7f000000, 8], [0xa9fe0000, 16], [0xac100000, 12], [0xc0000000, 24], [0xc0000200, 24],
  [0xc0a80000, 16], [0xc6120000, 15], [0xc6336400, 24], [0xcb007100, 24], [0xe0000000, 4], [0xf0000000, 4],
];

const v4Number = (ip: string): number | null => {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return parts.reduce((n, p) => n * 256 + p, 0);
};

const publicV4 = (ip: string): boolean => {
  const n = v4Number(ip);
  if (n === null) return false;
  return !V4_BLOCKED.some(([base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)));
};

const v6Words = (ip: string): number[] | null => {
  const halves = ip.toLowerCase().split("::");
  if (halves.length > 2) return null;
  const words = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const part of s.split(":")) {
      if (part.includes(".")) {
        const n = v4Number(part);
        if (n === null) return null;
        out.push(Math.floor(n / 65536), n % 65536);
      } else if (/^[0-9a-f]{1,4}$/.test(part)) out.push(Number.parseInt(part, 16));
      else return null;
    }
    return out;
  };
  const head = words(halves[0] ?? "");
  const tail = halves.length === 2 ? words(halves[1] ?? "") : [];
  if (!head || !tail) return null;
  const fill = 8 - head.length - tail.length;
  if (halves.length === 1 ? fill !== 0 : fill < 1) return null;
  return [...head, ...Array<number>(Math.max(0, fill)).fill(0), ...tail];
};

/** True for a public unicast address: IPv4 outside private, loopback, link-local, shared and reserved ranges; IPv6 in 2000::/3 outside documentation, 6to4 and Teredo. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return publicV4(ip);
  if (family !== 6) return false;
  const w = v6Words(ip.replace(/%.*$/, ""));
  if (!w) return false;
  const [a = 0, b = 0] = w;
  if ((a & 0xe000) !== 0x2000) return false;
  if (a === 0x2001 && (b === 0x0db8 || b < 0x0200)) return false;
  return a !== 0x2002;
}

export type ResolveAll = (hostname: string, options: LookupAllOptions, callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;

/** A DNS lookup for the request that refuses any host with a private or local address, so the checked address is the one connected to. */
export const guardedLookup = (resolve: ResolveAll): LookupFunction => (hostname, options, callback) => {
  resolve(hostname, { all: true }, (err, addresses) => {
    if (err) {
      callback(err, "", 4);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [];
    const bad = list.find((a) => !isPublicAddress(a.address));
    const first = list[0];
    if (bad || !first) callback(new Error(`${hostname} resolves to ${bad ? `a private or local address (${bad.address})` : "no address"}, so the Desk does not send it anything`), "", 4);
    else if (options.all) callback(null, list);
    else callback(null, first.address, first.family);
  });
};

export const publicLookup: LookupFunction = guardedLookup(dnsLookup);

export interface OneClickAnswer {
  status: number;
}

export type OneClickPost = (url: URL, timeoutMs: number) => Promise<OneClickAnswer>;

const ONE_CLICK_BODY = "List-Unsubscribe=One-Click";

/** The RFC 8058 POST over HTTPS, through `publicLookup`, without cookies and without following redirects. */
export const postOneClick: OneClickPost = (url, timeoutMs) =>
  new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        lookup: publicLookup,
        timeout: timeoutMs,
        headers: { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": String(ONE_CLICK_BODY.length), "User-Agent": "Cortex-Desk (RFC 8058 one-click unsubscribe)" },
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode ?? 0 });
      },
    );
    const late = (): void => { req.destroy(new Error(`did not answer within ${Math.round(timeoutMs / 1000)} s`)); };
    const timer = setTimeout(late, timeoutMs);
    req.on("timeout", late);
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    req.on("close", () => { clearTimeout(timer); });
    req.end(ONE_CLICK_BODY);
  });

/** Why the Desk will not POST to this URL, or null: HTTPS on the default port, a host name (no IP literal), no user info. */
export function oneClickRefusal(raw: string): string | null {
  if (!URL.canParse(raw)) return "the unsubscribe address is not a valid URL";
  const url = new URL(raw);
  if (url.protocol !== "https:") return "One-Click unsubscribe needs an https address";
  if (url.username || url.password) return "the unsubscribe address carries a user name or password";
  if (url.port && url.port !== "443") return "the unsubscribe address uses a port other than 443";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0) return "the unsubscribe address is an IP address, not a host name";
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || !host.includes(".")) return "the unsubscribe address is a local host name";
  return null;
}

const record = (db: Database, key: string, mail: ListedMail, host: string, status: "ok" | "failed", httpStatus: number | null, error: string | null, now: number): void => {
  db.query("INSERT INTO desk_mail_unsubscribes (list_key, message_id, host, status, http_status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(key, mail.id, host, status, httpStatus, error, now);
};

export interface UnsubscribeDeps {
  db: Database;
  ledger: TrashLedger;
  now: number;
  post?: OneClickPost;
}

const listName = (mail: ListedMail): string => mail.from.name ?? mail.from.address;

/**
 * Sends the One-Click POST for the list of one listed mail, after the principal confirmed it on the card. The offer is
 * checked again here (threshold, headers, VIP, suspicion), one list is unsubscribed at most once, and every attempt is
 * recorded. A failed attempt keeps the offer with its error; a successful one logs `unsubscribe` and makes the card offer
 * an archive rule for anything that still arrives. Nothing is fetched for a page or mailto unsubscribe.
 */
export async function unsubscribeMail(mail: ListedMail, ctx: OfferContext, deps: UnsubscribeDeps): Promise<MoveResult> {
  const offer = unsubscribeOffer(deps.db, mail, ctx);
  if (!offer) return refuse(409, "The Desk does not offer to unsubscribe from this mail.");
  if (offer.kind === "rule") return refuse(409, `You already unsubscribed from ${listName(mail)}.`);
  if (offer.kind === "page") return refuse(409, `This list has no one-click unsubscribe. Open its unsubscribe page yourself: ${offer.url}`);
  const key = listKey(mail);
  const claim = `unsubscribe:${key}`;
  if (!deps.ledger.claim(claim)) return refuse(409, "The Desk is already unsubscribing from this list.");
  const failed = (code: number, error: string, httpStatus: number | null = null): MoveResult => {
    record(deps.db, key, mail, offer.host, "failed", httpStatus, error, deps.now);
    return refuse(code, code === 422 ? `The Desk did not unsubscribe: ${error}.` : `The unsubscribe did not go through: ${error}.`);
  };
  try {
    const refusal = oneClickRefusal(offer.url);
    if (refusal) return failed(422, refusal);
    const features = mailFeatures(deps.db, mail);
    let status: number;
    try {
      status = (await (deps.post ?? postOneClick)(new URL(offer.url), ctx.config.timeoutSeconds * 1000)).status;
    } catch (err) {
      return failed(502, `${offer.host} could not be reached: ${err instanceof Error ? err.message : String(err)}`.slice(0, 300));
    }
    if (status < 200 || status > 299) {
      return failed(502, status >= 300 && status < 400 ? `${offer.host} answered with a redirect (HTTP ${status}), which One-Click unsubscribe must not use` : `${offer.host} answered HTTP ${status}`, status);
    }
    record(deps.db, key, mail, offer.host, "ok", status, null, deps.now);
    logMailDecision(deps.db, features, "unsubscribe", "desk", deps.now);
    return { ok: true, message: `Unsubscribed from ${listName(mail)}: ${offer.host} accepted it (HTTP ${status}). If its mail still arrives, the card offers to archive it for you.` };
  } finally {
    deps.ledger.release(claim);
  }
}

/** After a successful unsubscribe, an archive rule (by List-Id, else sender) for whatever the list still sends. */
export function archiveWhatArrives(db: Database, mail: ListedMail, now: number): RuleChange {
  if (!attempt(db, listKey(mail), true)) return refuse(409, "Unsubscribe from this list first.");
  const listId = listIdOf(mail);
  return createRule(db, listId ? { match: "list", value: listId, action: "archive" } : { match: "sender", value: mail.from.address, action: "archive" }, now);
}

export const offerContext = (db: Database, config: UnsubscribeConfig | undefined, suspicion: SuspicionContext, flagged?: ReadonlySet<string>): OfferContext => ({
  config: config ?? DEFAULT_UNSUBSCRIBE,
  suspicion,
  rules: listRules(db),
  ...(flagged ? { flagged } : {}),
});
