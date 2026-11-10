import type { TrustedConnector } from "../../../src/conversations/authority";

export type Fault =
  | { kind: "timeout" }
  | { kind: "invalid-output" }
  | { kind: "exit"; code: number }
  | { kind: "hold"; gate: Promise<void>; reached: () => void };

export interface FaultPlan {
  dispatch?: Fault;
  query?: Fault;
}

/** A gate whose owner call is in flight until the scenario lets it finish, or never. */
export interface Hold {
  fault: Fault;
  reached: Promise<void>;
  release(): void;
}

export function hold(): Hold {
  let reached!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { fault: { kind: "hold", gate, reached }, reached: entered, release };
}

const EXIT_AFTER_EFFECT = (code: number): Error => Object.assign(new Error(`The owner process exited with code ${String(code)} after the call.`), { exitCode: code });

async function apply(fault: Fault | undefined, delegate: () => Promise<unknown>): Promise<unknown> {
  if (fault === undefined) return delegate();
  if (fault.kind === "timeout") {
    void delegate().catch(() => undefined);
    return new Promise<never>(() => undefined);
  }
  if (fault.kind === "exit") {
    await delegate();
    throw EXIT_AFTER_EFFECT(fault.code);
  }
  if (fault.kind === "invalid-output") {
    await delegate();
    return { nonsense: true };
  }
  const answer = await delegate();
  fault.reached();
  await fault.gate;
  return answer;
}

/** Wraps a package connector so a scenario can fail one owner call at a time without touching the package. */
export function faultyConnector(connector: TrustedConnector, plan: FaultPlan): TrustedConnector {
  return {
    ...connector,
    dispatch: (request, signal) => apply(plan.dispatch, () => connector.dispatch(request, signal)),
    ...(connector.query ? { query: (request, signal) => apply(plan.query, () => connector.query ? connector.query(request, signal) : Promise.resolve(undefined)) } : {}),
  };
}
