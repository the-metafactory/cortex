import { defineDoc, defineDocFamily, type JsonObject, type Session, type Tx } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import { QueryRequestSchema, QUERY_LIMITS } from "./query-types";
import { authorityJson } from "../../authority-records";

const sourceState = z.object({ head: z.string().nullable(), cursor: z.string().optional(), snapshotId: z.string().optional(), exhausted: z.boolean(), incomplete: z.boolean(), seen: z.record(z.string(), z.string()), position: z.number().int().nonnegative() }).strict();
const storedQuery = z.object({ request: QueryRequestSchema, expiresAt: z.number(), cancelled: z.boolean(), busy: z.boolean(), token: z.uuid().nullable(), started: z.boolean(), states: z.array(sourceState) }).strict();
export type StoredQuery = z.infer<typeof storedQuery>;
const QueryDoc = defineDocFamily<{ record: JsonObject | null }, string>({ kind: "cortex.read-query", version: 1, scope: "session", family: true, initial: () => ({ record: null }), checkpointWhen: () => true });
const IndexDoc = defineDoc<{ expiries: Record<string, number> }>({ kind: "cortex.read-query-index", version: 1, scope: "session", initial: () => ({ expiries: {} }), checkpointWhen: () => true });
export class QueryStore {
  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly now: () => number = Date.now, private readonly context: Context = BACKGROUND_CONTEXT) {}

  private async expire(tx: Tx): Promise<Record<string, number>> {
    const { expiries } = await tx.doc(IndexDoc);
    for (const [id, expiry] of Object.entries(expiries)) if (expiry <= this.now()) {
      await tx.retireDoc(QueryDoc, id);
      Reflect.deleteProperty(expiries, id);
    }
    return expiries;
  }

  async change<T>(queryId: string, change: (query: StoredQuery | undefined) => T): Promise<{ value: T; nextExpiry: number }> {
    return this.engine.commit(async tx => {
      const expiries = await this.expire(tx);
      const doc = expiries[queryId] === undefined ? undefined : await tx.doc(QueryDoc, queryId, queryId);
      const query = doc?.record ? storedQuery.parse(doc.record) : undefined;
      const value = change(query);
      if (query && doc) {
        if (query.states.some(state => Object.keys(state.seen).length > 1000)) throw new Error("Query identity budget exhausted.");
        doc.record = authorityJson(storedQuery.parse(query));
      }
      return { value: structuredClone(value), nextExpiry: Math.min(...Object.values(expiries)) };
    }, this.context);
  }

  async create(request: StoredQuery["request"], heads: (string | null)[]): Promise<number> {
    return this.engine.commit(async tx => {
      const expiries = await this.expire(tx);
      if (expiries[request.queryId] !== undefined) throw new Error("Query identity already exists.");
      if (Object.keys(expiries).length >= 1000) throw new Error("Query store capacity exhausted.");
      const expiresAt = this.now() + QUERY_LIMITS.continuationMs;
      const query = storedQuery.parse({ request, expiresAt, cancelled: false, busy: false, token: null, started: false, states: heads.map(head => ({ head, exhausted: false, incomplete: false, seen: {}, position: 0 })) });
      const doc = await tx.doc(QueryDoc, request.queryId, request.queryId);
      doc.record = authorityJson(query);
      expiries[request.queryId] = expiresAt;
      return Math.min(...Object.values(expiries));
    }, this.context);
  }

  async sweep(): Promise<number> { return this.engine.commit(async tx => Math.min(...Object.values(await this.expire(tx))), this.context); }
}
