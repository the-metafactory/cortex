import { expect, test } from "bun:test";
import { CREATION_CATALOG } from "../../catalog";
import { balanceDeclaration, fixtureBindings, objectRef } from "../fixtures";
import { DomainAdapterRegistry } from "../registry";
import type { ObjectReference } from "../types";

interface LegacyProposal { proposalId: string; revision: number; type: "balance-task"; fields: Record<string, string>; sourceLink: string; receipts: { operationId: string; canonicalId: string }[] }
const legacy = (): LegacyProposal => ({ proposalId: "proposal-example", revision: 3, type: "balance-task", fields: { area: "Example area", project: "Example project", title: "Edited title", note: "User-edited note" }, sourceLink: "?desk=conversation&conversation=conversation-example", receipts: [{ operationId: "operation-example", canonicalId: "existing-task" }] });

function mapBalanceFixture(saved: LegacyProposal, destinations: Record<string, ObjectReference[]>): { review: true } | { review: false; input: Record<string, unknown> } {
  const fields = CREATION_CATALOG[saved.type].fields;
  if (Object.keys(saved.fields).some(key => !fields.some(field => field.name === key))) return { review: true };
  const input: Record<string, unknown> = { ...saved.fields };
  for (const field of fields.filter(item => item.destination)) {
    const value = saved.fields[field.name];
    if (value === undefined) continue;
    const matches = destinations[value] ?? [];
    if (matches.length !== 1) return { review: true };
    const target = matches[0];
    if (target?.adapterId !== "balance" || target.objectType !== field.name || target.connectionId !== "connection-example") return { review: true };
    input[field.name] = structuredClone(target);
  }
  return { review: false, input };
}

const destinations = () => ({ "Example area": [objectRef("balance", "area", "area-example")], "Example project": [objectRef("balance", "project", "project-example")] });

test("explicit legacy mapping preserves proposal identity, edits, receipts and links without owner calls", () => {
  const saved = legacy();
  const before = structuredClone(saved);
  const mapped = mapBalanceFixture(saved, destinations());
  expect(mapped.review).toBe(false);
  if (mapped.review) throw new Error("Fixture mapping unexpectedly needs review.");
  const adapter = balanceDeclaration();
  const registry = new DomainAdapterRegistry();
  expect(registry.register(adapter, fixtureBindings(adapter)).ok).toBe(true);
  expect(registry.validateInput({ capabilityId: "balance.task.create", inputSchemaRef: adapter.capabilities[0]!.inputSchemaRef, input: mapped.input }, { connectionId: "connection-example" }).ok).toBe(true);
  expect(mapped.input).toMatchObject({ title: "Edited title", note: "User-edited note", area: { canonicalId: "area-example" }, project: { canonicalId: "project-example" } });
  expect(saved).toEqual(before);
});

test("ambiguous or cross-connection legacy references require review without changing saved data", () => {
  const saved = legacy();
  const before = structuredClone(saved);
  for (const refs of [[], [objectRef("balance", "area", "a"), objectRef("balance", "area", "b")], [{ ...objectRef("balance", "area", "a"), connectionId: "another-connection" }]]) {
    expect(mapBalanceFixture(saved, { ...destinations(), "Example area": refs })).toEqual({ review: true });
  }
  expect(saved).toEqual(before);
});
