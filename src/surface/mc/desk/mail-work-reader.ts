import type { Policy } from "../../../conversations/types";
import type { ObjectReference } from "../../../conversations/domain-adapters/types";
import { QUERY_LIMITS, type QuerySource } from "../../../conversations/domain-adapters/reads/query-types";
import { SEARCH_MAX_LIMIT, SEARCH_MAX_OFFSET, type WorkObject, type WorkPage, type WorkRead, type WorkReader } from "../../../conversations/tools/work-context";
import { runCreatedHostQuery, runHostQuery, type HostQueryRunner } from "./query-run";
import { observedAtOf, releasedObjects, type ReleasedObject } from "./work-released";

interface MailWorkConnection {
  readonly destination: ObjectReference;
  readonly policy?: Policy;
}
interface MailWorkRunner extends HostQueryRunner {
  readonly connections: () => readonly MailWorkConnection[];
}

const MAX_PAGES = Math.ceil((SEARCH_MAX_OFFSET + SEARCH_MAX_LIMIT + 1) / QUERY_LIMITS.pageItems);
const COVERAGE = `Search covers only connection-listed Mail fields and first paragraphs, never full bodies or provider-wide search. Each search inspects at most ${QUERY_LIMITS.connections} connections and ${MAX_PAGES} pages of ${QUERY_LIMITS.pageItems} messages.`;
const text = (value: unknown): string => typeof value === "string" ? value : "";
const workId = (connectionId: string, messageId: string): string => JSON.stringify([connectionId, messageId]);
const source = (connection: MailWorkConnection, messageId?: string): QuerySource => ({
  adapterId: "mail", connectionId: connection.destination.connectionId, capabilityId: "mail.message.query",
  inputSchemaRef: { schemaId: "mail.message.query.input", version: "1.0.0" },
  destinations: [connection.destination], input: messageId === undefined ? {} : { messageId },
});
const objectsOf = (connection: MailWorkConnection, released: Parameters<typeof releasedObjects>[0] | undefined): ReleasedObject[] => released === undefined ? [] : releasedObjects(released).filter(object =>
  object.ref.adapterId === "mail" && object.ref.connectionId === connection.destination.connectionId && object.ref.objectType === "message"
  && object.destination.adapterId === "mail" && object.destination.connectionId === connection.destination.connectionId
  && object.destination.objectType === connection.destination.objectType && object.destination.canonicalId === connection.destination.canonicalId
);
const toObject = (connection: MailWorkConnection, object: ReleasedObject): WorkObject => ({
  kind: "mail", id: workId(object.ref.connectionId, object.ref.canonicalId), title: text(object.value.subject), status: "listed",
  summary: [
    `Account: ${text(object.value.account)}`,
    `From: ${JSON.stringify(object.value.from)}`,
    `Received: ${text(object.value.receivedAt)}`,
    text(object.value.firstParagraph).slice(0, 1000),
  ].join("\n"),
  policy: connection.policy ?? "local", area: null,
  url: `?desk=day&item=${encodeURIComponent(`mail:${workId(object.ref.connectionId, object.ref.canonicalId)}`)}`, observedAt: observedAtOf(object, Date.now()),
});

function mailSearchStatus({ found, restricted, incomplete, failed }: { found: number; restricted: boolean; incomplete: boolean; failed: boolean }): NonNullable<WorkPage["status"]> {
  if (found > 0) return restricted || incomplete || failed ? "partial" : "ok";
  if (restricted) return "denied";
  if (failed) return "unavailable";
  if (incomplete) return "partial";
  return "ok";
}

export function mailWorkReaders(config: MailWorkRunner): { mail: WorkReader } {
  const connections = () => config.connections().filter(connection => connection.destination.adapterId === "mail" && connection.destination.objectType === "mailbox");
  const read = async (id: string): Promise<WorkRead> => {
    let key: unknown;
    try { key = JSON.parse(id); }
    catch { return { state: "unavailable", reason: "unavailable" }; }
    if (!Array.isArray(key) || key.length !== 2 || key.some(part => typeof part !== "string" || !part)) return { state: "unavailable", reason: "unavailable" };
    const [connectionId, messageId] = key as [string, string];
    const matches = connections().filter(connection => connection.destination.connectionId === connectionId);
    const connection = matches[0];
    if (matches.length !== 1 || !connection) return { state: "unavailable", reason: "unauthorized" };
    const run = await runHostQuery(config, source(connection, messageId));
    if (run.result.restricted || run.result.status === "denied") return { state: "unavailable", reason: "unauthorized" };
    const object = objectsOf(connection, run.released).find(candidate => candidate.ref.canonicalId === messageId);
    if (run.result.status === "ok" && object) return { state: "available", object: toObject(connection, object) };
    return { state: "unavailable", reason: run.result.status === "ok" && run.released !== undefined && run.result.noMatch ? "not-found" : "unavailable" };
  };
  const search = async (needle: string, limit: number, offset: number): Promise<WorkPage> => {
    const all = connections();
    const items: WorkObject[] = [];
    const wanted = needle.trim().toLowerCase();
    let restricted = false;
    let incomplete = all.length > QUERY_LIMITS.connections;
    let failed = false;
    let pages = 0;
    scan: for (const connection of all.slice(0, QUERY_LIMITS.connections)) {
      const request = await config.runner.create(config.context, [source(connection)], config.sink);
      let continuation: string | undefined;
      do {
        if (pages++ >= MAX_PAGES) { incomplete = true; break; }
        const run = await runCreatedHostQuery(config, { ...request, ...(continuation ? { continuation } : {}) });
        if (run.result.restricted || run.result.status === "denied") { restricted = true; break; }
        if (run.released === undefined || run.result.status !== "ok" && run.result.status !== "partial") { failed = true; break; }
        const objects = objectsOf(connection, run.released).map(object => toObject(connection, object));
        items.push(...objects.filter(object => [object.title, object.summary].some(field => field.toLowerCase().includes(wanted))));
        if (items.length > offset + limit) { incomplete = true; break scan; }
        continuation = run.result.continuation;
        incomplete ||= run.result.status === "partial" && !continuation;
      } while (continuation);
      if (pages >= MAX_PAGES) { incomplete = true; break; }
    }
    return {
      items: items.slice(offset, offset + limit), more: incomplete || items.length > offset + limit, restricted,
      status: mailSearchStatus({ found: items.length, restricted, incomplete, failed }),
      coverage: (incomplete || failed) ? "incomplete" : "exhausted", noMatch: !restricted && !incomplete && !failed && items.length === 0,
      coverageLimit: COVERAGE,
    };
  };
  return { mail: { search, read } };
}
