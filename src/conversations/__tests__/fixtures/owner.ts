import type { CreateRequest, CreateResult, OperationRecord, OwnerWriter, ReadbackResult } from "../../types";

export type FixtureMode = "create" | "fail" | "hang" | "lose-answer" | "accept" | "no-id";
export interface FixtureOwner {
  writer: OwnerWriter;
  effects: CreateRequest[];
  calls: CreateRequest[];
  mode: FixtureMode;
  objects: Map<string, string>;
}

const urlOf = (id: string): string => `fixture://owner/${id}`;

export function fixtureOwner(prefix = "fixture"): FixtureOwner {
  const owner: FixtureOwner = {
    effects: [],
    calls: [],
    mode: "create",
    objects: new Map(),
    writer: {
      create: async (request: CreateRequest): Promise<CreateResult> => {
        owner.calls.push(request);
        const known = owner.objects.get(request.operationId);
        if (known) return { state: "created", canonicalId: known, url: urlOf(known) };
        const effect = (): string => {
          const id = `${prefix}-${owner.effects.length + 1}`;
          owner.effects.push(request);
          owner.objects.set(request.operationId, id);
          return id;
        };
        if (owner.mode === "fail") return { state: "failed", error: "The fixture owner refused this payload." };
        if (owner.mode === "hang") { effect(); return new Promise<never>(() => undefined); }
        if (owner.mode === "lose-answer") { effect(); throw new Error("connection reset after write"); }
        if (owner.mode === "accept") return { state: "accepted", receipt: "queued" };
        const id = effect();
        if (owner.mode === "no-id") return { state: "created", canonicalId: " " };
        return { state: "created", canonicalId: id, url: urlOf(id) };
      },
      readback: (operation: OperationRecord): Promise<ReadbackResult> => {
        const id = owner.objects.get(operation.operationId);
        return Promise.resolve(id ? { found: true, canonicalId: id, url: urlOf(id) } : { found: false });
      },
    },
  };
  return owner;
}
