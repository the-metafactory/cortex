import { describe, expect, test } from "bun:test";
import { balanceDeclaration, fixtureBindings, graphDeclaration, referenceDeclaration } from "../fixtures";
import { DomainAdapterRegistry } from "../registry";

function seededRegistry() {
  const registry = new DomainAdapterRegistry();
  const earlier = balanceDeclaration();
  expect(registry.register(earlier, fixtureBindings(earlier)).ok).toBe(true);
  return { registry, before: registry.discover() };
}

describe("Desk registry action bindings", () => {
  test.each([balanceDeclaration, graphDeclaration])("discovers action capabilities without registry handlers", declarationFactory => {
    const registry = new DomainAdapterRegistry();
    const declaration = declarationFactory();
    const bindings = fixtureBindings(declaration);
    expect(bindings).toEqual({ handlers: {}, observations: {} });
    expect(registry.register(declaration, bindings)).toEqual({ ok: true, value: declaration });
    expect(registry.discover()).toEqual(declaration.capabilities.map(capability => ({
      support: "declared", adapterId: declaration.adapterId, capability, availability: { state: "available" },
    })));
  });

  test.each(["query", "observation"] as const)("retains earlier discovery when a %s binding is missing", kind => {
    const { registry, before } = seededRegistry();
    const declaration = referenceDeclaration(kind);
    expect(registry.register(declaration, { handlers: {}, observations: {} })).toMatchObject({ ok: false, error: { code: "missing_handler" } });
    expect(registry.discover()).toEqual(before);
    expect(registry.register(declaration, fixtureBindings(declaration)).ok).toBe(true);
  });

  test("rejects an action handler without publishing any part of a mixed declaration", () => {
    const { registry, before } = seededRegistry();
    const declaration = graphDeclaration();
    const action = declaration.capabilities[0]!;
    declaration.capabilities.unshift({ ...action, capabilityId: "work-graph.node.get", kind: "query" });
    declaration.capabilities.push({ ...action, capabilityId: "work-graph.node.observe", kind: "observation" });
    const bindings = fixtureBindings(declaration);
    let calls = 0;
    bindings.handlers[action.capabilityId] = () => { calls++; };
    expect(registry.register(declaration, bindings)).toMatchObject({ ok: false, error: { code: "invalid_registration" } });
    expect(calls).toBe(0);
    expect(registry.discover()).toEqual(before);
    expect(registry.register(declaration, fixtureBindings(declaration))).toEqual({ ok: true, value: declaration });
    expect(registry.discover().map(item => item.capability.capabilityId)).toEqual([
      "balance.task.create", "work-graph.node.get", "work-graph.node.create", "work-graph.node.observe",
    ]);
  });
});
