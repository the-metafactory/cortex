import type { HostContext } from "../../../conversations/authority";
import type { ReleaseSink } from "../../../conversations/authority-records";
import type { Json } from "../../../conversations/domain-adapters/operations/types";
import type { QueryRunner } from "../../../conversations/domain-adapters/reads/query";
import type { QuerySource, QueryResult } from "../../../conversations/domain-adapters/reads/query-types";

export interface HostQueryRun {
  readonly result: QueryResult;
  readonly released?: Json;
}

export interface HostQueryRunner {
  readonly runner: Pick<QueryRunner, "create" | "run">;
  readonly context: HostContext;
  readonly sink: ReleaseSink;
}

export async function runHostQuery(host: HostQueryRunner, source: QuerySource & { adapterId: string }): Promise<HostQueryRun> {
  const created = await host.runner.create(host.context, [source], host.sink);
  let released: Json | undefined;
  const result = await host.runner.run(host.context, created, host.sink, undefined, undefined, { released: value => { released = value; } });
  return { result, ...(released === undefined ? {} : { released }) };
}
