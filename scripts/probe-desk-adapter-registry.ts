import assert from "node:assert/strict";
import { DomainAdapterRegistry } from "../src/conversations/domain-adapters/registry";
import { balanceDeclaration, fixtureBindings, graphDeclaration, objectRef, referenceDeclaration } from "../src/conversations/domain-adapters/fixtures";

const registry = new DomainAdapterRegistry();
for (const declaration of [balanceDeclaration(), graphDeclaration(), referenceDeclaration("query"), referenceDeclaration("observation")]) {
  const bindings = fixtureBindings(declaration);
  for (const capability of declaration.capabilities.filter(item => item.kind === "action")) assert.equal(Object.hasOwn(bindings.handlers, capability.capabilityId), false);
  assert.equal(registry.register(declaration, bindings).ok, true);
}
const inputSchemaRef = { schemaId: "balance.task.create.input", version: "1.0.0" };
const context = { connectionId: "connection-example" };
const input = { area: objectRef("balance", "area", "area-example"), title: 42 };
const invalid = registry.validateInput({ capabilityId: "balance.task.create", inputSchemaRef, input }, context);
assert.equal(invalid.ok, false);
if (!invalid.ok) {
  assert.equal(invalid.error.code, "invalid_input");
  assert.equal(invalid.error.issues?.[0]?.path, "/title");
}
const mismatch = registry.validateInput({ capabilityId: "balance.task.create", inputSchemaRef: { ...inputSchemaRef, version: "2.0.0" }, input: { ...input, title: "Example task" } }, context);
assert.equal(mismatch.ok, false);
if (!mismatch.ok) assert.equal(mismatch.error.code, "incompatible_schema");
const readOnly = registry.discover().filter(item => item.adapterId === "reference-library");
assert.equal(readOnly.length, 1);
assert.equal(readOnly[0]?.capability.kind, "query");
console.log(JSON.stringify({ registered: registry.discover().map(item => item.capability.capabilityId), readOnly: readOnly.map(item => item.capability.kind), invalid, mismatch, ownerCalls: 0 }, null, 2));
