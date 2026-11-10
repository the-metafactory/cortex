import { defineDoc, type JsonObject, type Session } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { z } from "zod";
import { QueryRequestSchema, QUERY_LIMITS } from "./query-types";
import { authorityJson } from "../../authority-records";

const sourceState = z.object({ head: z.string().nullable(), cursor: z.string().optional(), snapshotId: z.string().optional(), exhausted: z.boolean(), incomplete: z.boolean(), seen: z.record(z.string(), z.string()), position: z.number().int().nonnegative() }).strict();
const storedQuery = z.object({ request: QueryRequestSchema, expiresAt: z.number(), cancelled: z.boolean(), busy: z.boolean(), token: z.uuid().nullable(), started: z.boolean(), states: z.array(sourceState) }).strict();
export type StoredQuery = z.infer<typeof storedQuery>;
const stateSchema = z.record(z.string(), storedQuery);
const QueryDoc = defineDoc<{ queries: JsonObject }>({ kind: "cortex.read-queries", version: 1, scope: "session", initial: () => ({ queries: {} }), checkpointWhen: () => true });
export class QueryStore {
  constructor(private readonly engine: Pick<Session, "commit" | "snapshot">, private readonly now: () => number = Date.now, private readonly context: Context = BACKGROUND_CONTEXT) {}

  async change<T>(change: (queries: Record<string, StoredQuery>) => T): Promise<T> {
    return this.engine.commit(async tx => {
      const doc = await tx.doc(QueryDoc);
      const queries = stateSchema.parse(doc.queries);
      for (const [id, query] of Object.entries(queries)) if (query.expiresAt <= this.now()) Reflect.deleteProperty(queries, id);
      const result = change(queries);
      if (Object.keys(queries).length > 1000) throw new Error("Query store capacity exhausted.");
      for (const query of Object.values(queries)) if (query.states.some(state => Object.keys(state.seen).length > 1000)) throw new Error("Query identity budget exhausted.");
      doc.queries = authorityJson(stateSchema.parse(queries));
      return structuredClone(result);
    }, this.context);
  }

  async create(request: StoredQuery["request"], heads: (string | null)[]): Promise<void> {
    await this.change(queries => {
      if (queries[request.queryId]) throw new Error("Query identity already exists.");
      queries[request.queryId] = { request, expiresAt: this.now() + QUERY_LIMITS.continuationMs, cancelled: false, busy: false, token: null, started: false, states: heads.map(head => ({ head, exhausted: false, incomplete: false, seen: {}, position: 0 })) };
    });
  }

  async sweep(): Promise<void> { await this.change(() => undefined); }
}
