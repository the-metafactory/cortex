import type { Database } from "bun:sqlite";
import { z } from "zod";
import { isLoopbackSideband } from "../../../common/sideband/loopback";
import { MissingKey, PREDICTED_ACTIONS, readApiKey, SIMILARITY_BASES, type KeyReader, type MailPrecedent, type MailPrecedents, type PredictedAction } from "./classify";
import { MAIL_VECTORS_SQL } from "./mail-log-schema";
import { queryMailLog, senderDomain, type MailLogAction, type MailLogEntry, type MailLogWhere } from "./mail-log";
import { DAY_MS } from "./time";

export { MAIL_VECTORS_SQL, PREDICTED_ACTIONS, SIMILARITY_BASES, type PredictedAction };

export type SimilarityBasis = (typeof SIMILARITY_BASES)[number];

export interface EmbedderAccess {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  caFile?: string;
  timeoutSeconds: number;
}

export interface EmbedderConfig extends EmbedderAccess {
  local?: EmbedderAccess;
  threshold: number;
  neighbours: number;
  windowDays: number;
  maxPerPass: number;
}

export const DEFAULT_SIMILARITY = { threshold: 0.65, neighbours: 8, windowDays: 90, maxPerPass: 64 } as const;

export const CORRECTION_WEIGHT = 2;

const LEARNED: Partial<Record<MailLogAction, PredictedAction>> = {
  archive: "archive",
  junk: "junk",
  trash: "trash",
  draft: "reply",
  plan: "plan",
  todo: "todo",
  kept: "keep",
  restore: "keep",
};

const LEARNED_ACTIONS = Object.keys(LEARNED) as MailLogAction[];

export const learnedAction = (action: MailLogAction): PredictedAction | undefined => LEARNED[action];

const LOGGED: Record<PredictedAction, MailLogAction> = { archive: "archive", junk: "junk", trash: "trash", reply: "draft", plan: "plan", todo: "todo", keep: "kept" };

export const loggedAction = (action: PredictedAction): MailLogAction => LOGGED[action];

export const decisionWeight = (where: MailLogWhere): number => (where === "correction" ? CORRECTION_WEIGHT : 1);

export interface Neighbour {
  entry: MailLogEntry;
  action: PredictedAction;
  similarity: number;
  weight: number;
}

export interface SimilarDecisions {
  basis: SimilarityBasis;
  neighbours: Neighbour[];
  note?: string;
}

export interface MailText {
  messageId: string;
  sourceId: string | null;
  sender: string;
  listId: string | null;
  subject: string | null;
  summary: string | null;
}

export const mailText = (m: Pick<MailText, "subject" | "summary">): string => [m.subject ?? "", m.summary ?? ""].join("\n").trim();

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The newest decision per message, keeping only actions the triage learns from. */
export function latestDecisions(entries: readonly MailLogEntry[]): MailLogEntry[] {
  const out = new Map<string, MailLogEntry>();
  for (const e of entries) {
    if (!learnedAction(e.action)) continue;
    const seen = out.get(e.messageId);
    if (!seen || e.at > seen.at || (e.at === seen.at && e.id > seen.id)) out.set(e.messageId, e);
  }
  return [...out.values()];
}

const neighbour = (entry: MailLogEntry, similarity: number): Neighbour[] => {
  const action = learnedAction(entry.action);
  return action ? [{ entry, action, similarity, weight: decisionWeight(entry.where) }] : [];
};

const byScore = (a: Neighbour, b: Neighbour): number => b.similarity * b.weight - a.similarity * a.weight || b.entry.at - a.entry.at;

/** The closest past decisions to a query vector: at or above the threshold, weighted (a correction counts more), at most `limit`. */
export function nearestDecisions(query: ArrayLike<number>, candidates: readonly { entry: MailLogEntry; vector: ArrayLike<number> }[], limit: number, threshold: number): Neighbour[] {
  return candidates
    .flatMap((c) => {
      const s = cosine(query, c.vector);
      return s >= threshold ? neighbour(c.entry, s) : [];
    })
    .sort(byScore)
    .slice(0, limit);
}

/** Without content vectors: past decisions on mail from the same List-Id, or else the same sender domain. */
export function senderDecisions(mail: Pick<MailText, "sender" | "listId">, entries: readonly MailLogEntry[], limit: number): Neighbour[] {
  const list = mail.listId?.trim().toLowerCase();
  const domain = senderDomain(mail.sender);
  return entries
    .flatMap((e) => {
      if (list && e.listId?.trim().toLowerCase() === list) return neighbour(e, 1);
      return domain && e.senderDomain === domain ? neighbour(e, list ? 0.9 : 1) : [];
    })
    .sort(byScore)
    .slice(0, limit);
}

/** Groups items whose vectors are at least `threshold` alike; each group starts at its first item, in input order. */
export function groupBySimilarity<T>(items: readonly { item: T; vector: ArrayLike<number> }[], threshold: number): T[][] {
  const groups: { head: ArrayLike<number>; members: T[] }[] = [];
  for (const { item, vector } of items) {
    const home = groups.find((g) => cosine(g.head, vector) >= threshold);
    if (home) home.members.push(item);
    else groups.push({ head: vector, members: [item] });
  }
  return groups.map((g) => g.members);
}


export const textHash = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const toBlob = (v: ArrayLike<number>): Uint8Array => new Uint8Array(Float32Array.from(v).buffer);
const fromBlob = (b: Uint8Array): Float32Array => new Float32Array(Uint8Array.from(b).buffer);

export function readVectors(db: Database, model: string, hashes: readonly string[], now: number): Map<string, Float32Array> {
  const out = new Map<string, Float32Array>();
  if (hashes.length === 0) return out;
  const list = JSON.stringify([...new Set(hashes)]);
  const rows = db.query<{ text_hash: string; vector: Uint8Array }, [string, string]>("SELECT text_hash, vector FROM desk_mail_vectors WHERE model = ? AND text_hash IN (SELECT value FROM json_each(?))").all(model, list);
  db.query("UPDATE desk_mail_vectors SET used_at = ? WHERE model = ? AND text_hash IN (SELECT value FROM json_each(?))").run(now, model, list);
  for (const r of rows) out.set(r.text_hash, fromBlob(r.vector));
  return out;
}

export function saveVector(db: Database, model: string, hash: string, vector: ArrayLike<number>, now: number): void {
  db.query("INSERT INTO desk_mail_vectors (text_hash, model, vector, used_at) VALUES (?, ?, ?, ?) ON CONFLICT(text_hash, model) DO UPDATE SET vector = excluded.vector, used_at = excluded.used_at").run(hash, model, toBlob(vector), now);
}

export function purgeVectors(db: Database, before: number): number {
  return db.query("DELETE FROM desk_mail_vectors WHERE used_at < ?").run(before).changes;
}

export type Embed = (access: EmbedderAccess, texts: string[]) => Promise<number[][]>;

const EmbeddingsSchema = z.object({ data: z.array(z.object({ index: z.number().int().min(0).optional(), embedding: z.array(z.number()) })).min(1) });

export function embeddings(fetchImpl: typeof fetch = fetch, readKey: KeyReader = readApiKey): Embed {
  return async (access, texts) => {
    const key = await readKey(access);
    if ((access.apiKeyEnv ?? access.apiKeyFile) && !key) throw new MissingKey("the embedder key was not found");
    const ca = access.caFile ? await Bun.file(access.caFile).text() : null;
    const res = await fetchImpl(`${access.baseUrl.replace(/\/+$/, "")}/embeddings`, {
      ...(ca ? { tls: { ca } } : {}),
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: access.model, input: texts }),
      signal: AbortSignal.timeout(access.timeoutSeconds * 1000),
    });
    if (!res.ok) throw new Error(`the embedder answered HTTP ${res.status}`);
    const body = EmbeddingsSchema.safeParse(await res.json());
    if (!body.success || body.data.data.length !== texts.length) throw new Error("the embedder sent an answer the Desk does not accept");
    const sorted = body.data.data.map((d, i) => ({ at: d.index ?? i, v: d.embedding })).sort((a, b) => a.at - b.at);
    return sorted.map((d) => d.v);
  };
}

export const accessPaths = <T extends EmbedderAccess>(access: T, expand: (path: string) => string): T => ({
  ...access,
  ...(access.apiKeyFile ? { apiKeyFile: expand(access.apiKeyFile) } : {}),
  ...(access.caFile ? { caFile: expand(access.caFile) } : {}),
});

export function resolveEmbedder(config: EmbedderConfig, expand: (path: string) => string): EmbedderConfig {
  return { ...accessPaths(config, expand), ...(config.local ? { local: accessPaths(config.local, expand) } : {}) };
}

const isLocal = (access: EmbedderAccess): boolean => isLoopbackSideband(access.baseUrl);

/** The endpoint that may read a mail: a local-policy area only ever goes to a local endpoint. */
export function embedderFor(config: EmbedderConfig, local: boolean): EmbedderAccess | null {
  if (!local) return config;
  if (config.local && isLocal(config.local)) return config.local;
  return isLocal(config) ? config : null;
}

export const vectorModel = (access: EmbedderAccess): string => `${access.baseUrl.replace(/\/+$/, "")}#${access.model}`;

export const NO_EMBEDDER_NOTE = "matched by sender and mailing list, because no embedder is set up";
export const EMBEDDER_DOWN_NOTE = "matched by sender and mailing list, because the embedder did not answer";
export const LOCAL_ONLY_NOTE = "matched by sender and mailing list, because this area allows only a local embedder";

const BATCH = 32;
const RETRY_MS = 5 * 60_000;

export interface SimilarityContext {
  similar(mail: MailText): Promise<SimilarDecisions>;
}

/**
 * Finds past decisions like a mail. With an embedder it compares content vectors (cached per text and model);
 * without one, or when the embedder fails, it falls back to sender domain and List-Id and says why.
 */
export class MailSimilarity {
  private downUntil = 0;

  constructor(
    private readonly config: EmbedderConfig | undefined,
    private readonly embed: Embed = embeddings(),
    private readonly log: (message: string) => void = console.error,
  ) {}

  get limits(): { neighbours: number; windowDays: number } {
    return { neighbours: this.config?.neighbours ?? DEFAULT_SIMILARITY.neighbours, windowDays: this.config?.windowDays ?? DEFAULT_SIMILARITY.windowDays };
  }

  load(db: Database, now: number, localSources: ReadonlySet<string> = new Set()): SimilarityContext {
    const { neighbours, windowDays } = this.limits;
    purgeVectors(db, now - windowDays * DAY_MS);
    const entries = latestDecisions(queryMailLog(db, { since: now - windowDays * DAY_MS, actions: LEARNED_ACTIONS, limit: 5000 }));
    const hashes = new Map(entries.map((e) => [e, textHash(mailText(e))]));
    const hashOf = (e: MailLogEntry): string => hashes.get(e) ?? textHash(mailText(e));
    const fallback = (mail: MailText, note: string): SimilarDecisions => ({ basis: "sender", neighbours: senderDecisions(mail, others(entries, mail), neighbours), note });
    const config = this.config;
    if (!config) return { similar: (mail) => Promise.resolve(fallback(mail, NO_EMBEDDER_NOTE)) };
    const isLocalSource = (sourceId: string | null): boolean => sourceId !== null && localSources.has(sourceId);
    const stores = new Map<string, Map<string, Float32Array>>();
    const storeFor = (access: EmbedderAccess): Map<string, Float32Array> => {
      const model = vectorModel(access);
      const known = stores.get(model) ?? readVectors(db, model, [...hashes.values()], now);
      stores.set(model, known);
      return known;
    };
    const vectorsFor = async (access: EmbedderAccess, texts: string[], budget: number): Promise<number> => {
      const known = storeFor(access);
      const missing = [...new Map(texts.map((t) => [textHash(t), t] as const).filter(([h]) => !known.has(h))).entries()].slice(0, budget);
      for (let i = 0; i < missing.length; i += BATCH) {
        const batch = missing.slice(i, i + BATCH);
        const vectors = await this.embed(access, batch.map(([, t]) => t));
        batch.forEach(([h], j) => {
          const v = vectors[j];
          if (!v) return;
          saveVector(db, vectorModel(access), h, v, now);
          known.set(h, Float32Array.from(v));
        });
      }
      return missing.length;
    };
    const ready = async (access: EmbedderAccess): Promise<boolean> => {
      if (now < this.downUntil) return false;
      try {
        const local = isLocal(access);
        await vectorsFor(access, entries.filter((e) => local || !isLocalSource(e.sourceId)).map(mailText), config.maxPerPass);
        return true;
      } catch (err) {
        this.fail(err, now);
        return false;
      }
    };
    const checked = new Map<EmbedderAccess, boolean>();
    return {
      similar: async (mail) => {
        const access = embedderFor(config, isLocalSource(mail.sourceId));
        if (!access) return fallback(mail, LOCAL_ONLY_NOTE);
        const ok = checked.get(access) ?? (await ready(access));
        checked.set(access, ok);
        if (!ok || now < this.downUntil) return fallback(mail, EMBEDDER_DOWN_NOTE);
        const text = mailText(mail);
        try {
          await vectorsFor(access, [text], 1);
        } catch (err) {
          this.fail(err, now);
          return fallback(mail, EMBEDDER_DOWN_NOTE);
        }
        const known = storeFor(access);
        const query = known.get(textHash(text));
        if (!query) return fallback(mail, EMBEDDER_DOWN_NOTE);
        const candidates = others(entries, mail).flatMap((entry) => {
          const vector = known.get(hashOf(entry));
          return vector ? [{ entry, vector }] : [];
        });
        return { basis: "content", neighbours: nearestDecisions(query, candidates, neighbours, config.threshold) };
      },
    };
  }

  private fail(err: unknown, now: number): void {
    this.downUntil = now + RETRY_MS;
    this.log(`desk: mail embedder: ${err instanceof Error ? err.message : String(err)}; matching by sender for 5 minutes`);
  }
}

const others = (entries: readonly MailLogEntry[], mail: MailText): MailLogEntry[] => entries.filter((e) => e.messageId !== mail.messageId || e.where === "correction");

export const ACTION_LABEL: Record<PredictedAction, string> = {
  archive: "archived",
  junk: "moved to Spam",
  trash: "deleted",
  reply: "answered",
  plan: "planned",
  todo: "made a to-do",
  keep: "kept in the inbox",
};

const names = (senders: string[]): string => {
  const unique = [...new Set(senders)];
  if (unique.length <= 3) return unique.length <= 1 ? (unique[0] ?? "") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1) ?? ""}`;
  return `${unique.slice(0, 2).join(", ")} and ${unique.length - 2} others`;
};

const past = (action: PredictedAction): string => `${ACTION_LABEL[action].charAt(0).toUpperCase()}${ACTION_LABEL[action].slice(1)}`;

export const WOULD: Record<PredictedAction, string> = {
  archive: "would archive it",
  junk: "would mark it as spam",
  trash: "would delete it",
  reply: "would reply to it",
  plan: "would plan it",
  todo: "would make it a to-do",
  keep: "would keep it in the inbox",
};

/** One plain sentence naming the precedents of a predicted action, or null when none agree with it. */
export function precedentLine(action: PredictedAction, precedents: Pick<MailPrecedents, "basis" | "note"> & { items: readonly Pick<MailPrecedent, "action" | "sender">[] }): string | null {
  const agreeing = precedents.items.filter((n) => n.action === action);
  if (agreeing.length === 0) return null;
  const n = agreeing.length;
  const mails = n === 1 ? "mail" : "mails";
  if (precedents.basis === "sender") return `${past(action)} like the last ${n === 1 ? "" : `${n} `}${mails} from this sender (${precedents.note ?? "matched by sender and mailing list"}).`;
  return `${past(action)} like ${n} similar ${mails} from ${names(agreeing.map((a) => a.sender))}.`;
}
