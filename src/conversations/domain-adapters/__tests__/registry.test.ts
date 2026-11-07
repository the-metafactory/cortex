import { describe, expect, test } from "bun:test";
import { DomainAdapterRegistry } from "../registry";
import { balanceDeclaration, fixtureBindings, objectRef, referenceDeclaration, graphDeclaration } from "../fixtures";

interface MutableFixtureSchema {
  properties: Record<string, { type?: string | string[]; $ref?: string; properties?: Record<string, { minLength?: number }> }>;
  required: string[];
}
const fixtureInputSchema = (declaration: ReturnType<typeof balanceDeclaration>): MutableFixtureSchema => declaration.schemas[0]!.schema as unknown as MutableFixtureSchema;

const schemaRegistration = (schema: unknown) => {
  const declaration = balanceDeclaration();
  declaration.schemas[0]!.schema = JSON.parse(JSON.stringify(schema));
  const registry = new DomainAdapterRegistry();
  return { registry, result: registry.register(declaration, fixtureBindings(declaration)) };
};

const registerBalance = () => {
  const registry = new DomainAdapterRegistry();
  expect(registry.register(balanceDeclaration(), fixtureBindings(balanceDeclaration())).ok).toBe(true);
  return registry;
};
const request = (input: unknown, version = "1.0.0") => ({ capabilityId: "balance.task.create", inputSchemaRef: { schemaId: "balance.task.create.input", version }, input });
const input = () => ({ area: objectRef("balance", "area", "area-example"), title: "Edited task" });

function code(result: ReturnType<DomainAdapterRegistry["register"]>): string | undefined {
  return result.ok ? undefined : result.error.code;
}

describe("Desk domain adapter registry", () => {
  test("discovers distinct adapters, read-only and source-only declarations without calling handlers", () => {
    const registry = registerBalance();
    const graph = graphDeclaration();
    const library = referenceDeclaration("query");
    const feed = referenceDeclaration("observation");
    for (const declaration of [graph, library, feed]) expect(registry.register(declaration, fixtureBindings(declaration)).ok).toBe(true);
    const found = registry.discover();
    expect(found.map(item => item.capability.capabilityId)).toEqual(["balance.task.create", "work-graph.node.create", "reference-library.document.get", "reference-feed.document.observe"]);
    expect(found.filter(item => item.adapterId.startsWith("reference")).every(item => item.capability.kind !== "action")).toBe(true);
    expect(registry.capability("reference-library.document.create")).toEqual({ support: "unsupported", capabilityId: "reference-library.document.create" });
    expect(registry.capability("balance.task.create", { state: "unavailable", code: "unavailable", message: "Connection is offline." })).toMatchObject({ support: "declared", availability: { state: "unavailable" } });
  });

  test.each([
    ["duplicate_id", (d: ReturnType<typeof balanceDeclaration>) => { d.capabilities.push(structuredClone(d.capabilities[0]!)); }],
    ["invalid_registration", (d: ReturnType<typeof balanceDeclaration>) => { d.capabilities[0]!.objectTypes = ["missing"]; }],
    ["incompatible_contract", (d: ReturnType<typeof balanceDeclaration>) => { d.contractRange = "^2.0.0"; }],
    ["incompatible_contract", (d: ReturnType<typeof balanceDeclaration>) => { d.contractRange = "not semver"; }],
    ["invalid_registration", (d: ReturnType<typeof balanceDeclaration>) => { d.objectTypes[0]!.relationships[0]!.targetObjectType = "missing"; }],
    ["invalid_registration", (d: ReturnType<typeof balanceDeclaration>) => { d.capabilities[0]!.inputSchemaRef.version = "9.0.0"; }],
  ])("rejects malformed registration as %s atomically", (expected, mutate) => {
    const registry = new DomainAdapterRegistry();
    const declaration = balanceDeclaration();
    mutate(declaration);
    expect(code(registry.register(declaration, fixtureBindings(declaration)))).toBe(expected);
    expect(registry.discover()).toEqual([]);
  });

  test("rejects duplicate adapters, unknown descriptor fields and missing or undeclared handlers", () => {
    const registry = registerBalance();
    expect(code(registry.register(balanceDeclaration(), fixtureBindings(balanceDeclaration())))).toBe("duplicate_id");
    const graph = graphDeclaration();
    expect(code(registry.register({ ...graph, authority: "write" }, fixtureBindings(graph)))).toBe("invalid_registration");
    expect(code(registry.register(graph, { handlers: {}, observations: {} }))).toBe("missing_handler");
    const bindings = fixtureBindings(graph);
    bindings.handlers.extra = () => undefined;
    expect(code(registry.register(graph, bindings))).toBe("invalid_registration");
    expect(registry.discover()).toHaveLength(1);
  });

  test("requires observation bindings and does not accept a handler in their place", () => {
    const feed = referenceDeclaration("observation");
    const registry = new DomainAdapterRegistry();
    expect(code(registry.register(feed, { handlers: {}, observations: {} }))).toBe("missing_handler");
    expect(registry.discover()).toEqual([]);
  });

  test.each([
    { $schema: "http://json-schema.org/draft-07/schema#", type: "object" },
    { type: "object", unknownAssertion: true },
    { $ref: "https://schemas.example.invalid/not-bundled" },
    { type: "string", format: "unknown-format" },
  ])("rejects unsupported or unresolved schema without fetching", schema => {
    const { registry, result } = schemaRegistration(schema);
    expect(code(result)).toBe("invalid_registration");
    expect(registry.discover()).toEqual([]);
  });

  test("validates input with JSON Pointer issues and keeps host context separate", () => {
    const registry = registerBalance();
    expect(registry.validateInput(request({ ...input(), title: 42 }), { connectionId: "host-only" })).toMatchObject({ ok: false, error: { code: "invalid_input", issues: [{ path: "/title" }] } });
    expect(registry.validateInput({ ...request(input()), connectionId: "forged" }, {})).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    const context = { connectionId: "host-only", provenance: { source: "example" } };
    expect(registry.validateInput(request(input()), context)).toEqual({ ok: true, value: { input: input(), context } });
    expect(registry.validateInput({ ...request(input()), capabilityId: "balance.task.teleport" }, {})).toMatchObject({ ok: false, error: { code: "unknown_capability" } });
  });

  test.each([
    { title: "" }, { title: null }, { due: null }, { due: "2026-02-30" }, { extra: "unapproved" },
    { area: { ...objectRef("balance", "area", "a"), canonicalId: "" } },
    { area: { ...objectRef("balance", "area", "a"), objectType: "task" } },
  ])("rejects invalid typed values %j", patch => {
    expect(registerBalance().validateInput(request({ ...input(), ...patch }), {})).toMatchObject({ ok: false, error: { code: "invalid_input" } });
  });

  test("preserves missing, empty, null, booleans and numbers without applying schema defaults", () => {
    const registry = registerBalance();
    const payload = { ...input(), note: "", done: false, estimate: 0, tags: [] };
    const copy = structuredClone(payload);
    expect(registry.validateInput(request(payload), {}).ok).toBe(true);
    expect(payload).toEqual(copy);
    expect("priority" in payload).toBe(false);
  });

  test("validates output and exact namespaced error envelopes without assuming effects", () => {
    const registry = registerBalance();
    expect(registry.validateOutput("balance.task.create", { ref: objectRef("balance", "task", "task-example") }).ok).toBe(true);
    expect(registry.validateOutput("balance.task.create", { ref: objectRef("balance", "task", "") })).toMatchObject({ ok: false, error: { code: "invalid_output" } });
    expect(registry.validateError("balance.task.create", { code: "balance.project_not_found", message: "Project is unavailable." }).ok).toBe(true);
    for (const error of [{ code: "invalid_input", message: "x" }, { code: "other.denied", message: "x" }, { code: "balance.denied", message: "x", details: "extra" }, { code: "balance.denied", message: 42 }]) {
      expect(registry.validateError("balance.task.create", error)).toMatchObject({ ok: false, error: { code: "invalid_output" } });
    }
  });

  test("supports exact immutable versions and refuses schema substitution", () => {
    const declaration = balanceDeclaration();
    const v1 = structuredClone(declaration.schemas.find(s => s.schemaId === "balance.task.create.input")!);
    const v11 = { ...structuredClone(v1), version: "1.1.0" };
    declaration.schemas.push(v11);
    const registry = new DomainAdapterRegistry();
    expect(registry.register(declaration, fixtureBindings(declaration)).ok).toBe(true);
    expect(registry.validateInput(request(input(), "1.0.0"), {}).ok).toBe(true);
    expect(registry.validateInput(request(input(), "1.1.0"), {}).ok).toBe(true);
    const saved = request(input());
    expect(registry.validateInput({ ...saved, inputSchemaRef: { ...saved.inputSchemaRef, version: "2.0.0" } }, {})).toMatchObject({ ok: false, error: { code: "incompatible_schema" } });
    expect(saved).toEqual(request(input()));
    declaration.schemas[0]!.schema = false;
    declaration.capabilities[0]!.label = "Changed outside the registry";
    expect(registry.validateInput(saved, {}).ok).toBe(true);
    expect(registry.discover()[0]!.capability.label).not.toBe("Changed outside the registry");
  });
});

describe("Desk adapter adversarial boundaries", () => {
  test("returned descriptors and discovery objects cannot mutate registered schema or capability", () => {
    const registry = new DomainAdapterRegistry();
    const declaration = balanceDeclaration();
    const registered = registry.register(declaration, fixtureBindings(declaration));
    expect(registered.ok).toBe(true);
    if (registered.ok) registered.value.capabilities[0]!.inputSchemaRef.schemaId = "forged";
    const found = registry.discover();
    found[0]!.capability.inputSchemaRef.schemaId = "forged";
    found[0]!.availability.state = "unavailable";
    expect(registry.validateInput(request(input()), {}).ok).toBe(true);
    expect(registry.discover()[0]).toMatchObject({ capability: { inputSchemaRef: { schemaId: "balance.task.create.input" } }, availability: { state: "available" } });
  });

  test("bundled cross-schema references validate locally and unresolved references never publish", () => {
    const declaration = balanceDeclaration();
    const inputSchema = fixtureInputSchema(declaration);
    const titleRef = { schemaId: "balance.task.title", version: "1.0.0" };
    declaration.schemas.push({ ...titleRef, schema: { type: "string", minLength: 4 } });
    inputSchema.properties.title = { $ref: "urn:desk-schema:balance.task.title:1.0.0" };
    const registry = new DomainAdapterRegistry();
    expect(registry.register(declaration, fixtureBindings(declaration)).ok).toBe(true);
    expect(registry.validateInput(request({ ...input(), title: "x" }), {})).toMatchObject({ ok: false, error: { code: "invalid_input", issues: [{ path: "/title" }] } });
    expect(registry.validateInput(request(input()), {}).ok).toBe(true);
  });

  test.each(["one", "many"] as const)("rejects inconsistent relationship cardinality %s", cardinality => {
    const declaration = cardinality === "one" ? graphDeclaration() : balanceDeclaration();
    const relationship = declaration.objectTypes[0]!.relationships.at(-1)!;
    relationship.cardinality = cardinality;
    expect(code(new DomainAdapterRegistry().register(declaration, fixtureBindings(declaration)))).toBe("invalid_registration");
  });

  test("rejects a capability outside its adapter namespace and a cross-adapter duplicate schema redefinition", () => {
    const registry = registerBalance();
    const foreign = graphDeclaration();
    foreign.capabilities[0]!.capabilityId = "other.node.create";
    expect(code(registry.register(foreign, fixtureBindings(foreign)))).toBe("invalid_registration");
    const changed = graphDeclaration();
    changed.schemas.push({ schemaId: "balance.task.create.input", version: "1.0.0", schema: false });
    expect(code(registry.register(changed, fixtureBindings(changed)))).toBe("invalid_registration");
    expect(registry.discover()).toHaveLength(1);
  });

  test.each([
    { $async: true, type: "object" },
    { $defs: { deferred: { $async: true, type: "object" } }, $ref: "#/$defs/deferred" },
  ])("rejects async schemas before any payload validation", schema => {
    const { registry, result } = schemaRegistration(schema);
    expect(code(result)).toBe("invalid_registration");
    expect(registry.discover()).toEqual([]);
    expect(registry.validateInput(request({ title: 42 }), {})).toMatchObject({ ok: false, error: { code: "unknown_capability" } });
  });
});

test.each(["1.0.0-01", "1.0.0-..", "01.0.0", "v1.0.0"])("rejects noncanonical exact schema version %s", version => {
  const declaration = balanceDeclaration();
  declaration.schemas[0]!.version = version;
  expect(code(new DomainAdapterRegistry().register(declaration, fixtureBindings(declaration)))).toBe("invalid_registration");
});

test("a schema explicitly allowing null keeps it distinct from missing and empty", () => {
  const declaration = balanceDeclaration();
  const schema = fixtureInputSchema(declaration);
  schema.properties.note = { type: ["string", "null"] };
  const registry = new DomainAdapterRegistry();
  expect(registry.register(declaration, fixtureBindings(declaration)).ok).toBe(true);
  for (const patch of [{}, { note: null }, { note: "" }]) {
    const payload = { ...input(), ...patch };
    expect(registry.validateInput(request(payload), {})).toEqual({ ok: true, value: { input: payload, context: {} } });
  }
});

test("nullable relationships preserve absent, null and valid values and reject malformed references", () => {
  const declaration = graphDeclaration();
  const schema = fixtureInputSchema(declaration);
  schema.properties.parent!.type = ["object", "null"];
  schema.properties.parent!.properties!.canonicalId!.minLength = 2;
  schema.properties.dependencies!.type = ["array", "null"];
  schema.required = ["repository", "title", "checkpoint"];
  const registry = new DomainAdapterRegistry();
  expect(registry.register(declaration, fixtureBindings(declaration)).ok).toBe(true);
  const base = { repository: "example/repository", title: "Example node", checkpoint: "example-checkpoint" };
  const validate = (patch: Record<string, unknown>) => registry.validateInput({ capabilityId: "work-graph.node.create", inputSchemaRef: declaration.capabilities[0]!.inputSchemaRef, input: { ...base, ...patch } }, {});
  for (const patch of [{}, { parent: null, dependencies: null }, { parent: objectRef("work-graph", "node", "node-example"), dependencies: [objectRef("work-graph", "node", "another-example")] }]) expect(validate(patch).ok).toBe(true);
  for (const patch of [{ parent: objectRef("work-graph", "node", "x") }, { parent: {} }, { dependencies: [null] }, { dependencies: [objectRef("other", "node", "wrong-adapter")] }]) expect(validate(patch).ok).toBe(false);
});

test("an optional schema addition stays pinned and a v2-only adapter preserves the old request", () => {
  const declaration = balanceDeclaration();
  const original = declaration.schemas[0]!;
  const newer = structuredClone(original);
  newer.version = "1.1.0";
  const schema = newer.schema as unknown as MutableFixtureSchema;
  schema.properties.priority = { type: "string" };
  const base = fixtureInputSchema(declaration);
  delete base.properties.priority;
  declaration.schemas.push(newer);
  const registry = new DomainAdapterRegistry();
  expect(registry.register(declaration, fixtureBindings(declaration)).ok).toBe(true);
  expect(registry.validateInput(request({ ...input(), priority: "high" }), {}).ok).toBe(false);
  expect(registry.validateInput(request({ ...input(), priority: "high" }, "1.1.0"), {}).ok).toBe(true);
  const v2 = balanceDeclaration();
  for (const item of v2.schemas) if (item.schemaId === "balance.task.create.input") item.version = "2.0.0";
  v2.objectTypes[0]!.schemaRef.version = "2.0.0";
  v2.capabilities[0]!.inputSchemaRef.version = "2.0.0";
  const onlyV2 = new DomainAdapterRegistry();
  expect(onlyV2.register(v2, fixtureBindings(v2)).ok).toBe(true);
  const saved = request(input());
  const copy = structuredClone(saved);
  expect(onlyV2.validateInput(saved, {})).toMatchObject({ ok: false, error: { code: "incompatible_schema" } });
  expect(saved).toEqual(copy);
});

test("schema identity equality ignores key ordering but remains immutable", () => {
  const registry = registerBalance();
  const shared = balanceDeclaration().schemas[0]!;
  const declaration = graphDeclaration();
  const schema = shared.schema as Record<string, unknown>;
  const reordered = Object.fromEntries(Object.entries(schema).reverse());
  declaration.schemas.push({ ...shared, schema: reordered as typeof shared.schema });
  expect(registry.register(declaration, fixtureBindings(declaration)).ok).toBe(true);
});

test.each(["depth", "width"])("oversized %s schema fails atomically with safe diagnostics", shape => {
  let schema: Record<string, unknown> = { type: "object" };
  if (shape === "depth") for (let i = 0; i < 70; i++) schema = { not: schema };
  else schema = { enum: Array.from({ length: 4097 }, (_, index) => index) };
  const { registry, result } = schemaRegistration(schema);
  expect(result).toMatchObject({ ok: false, error: { code: "invalid_registration", message: "Declaration exceeds supported JSON bounds." } });
  expect(registry.discover()).toEqual([]);
});

test("permissive output schemas still reject non-JSON adapter responses safely", () => {
  const declaration = balanceDeclaration();
  declaration.schemas.find(schema => schema.schemaId === "balance.task.create.output")!.schema = true;
  const registry = new DomainAdapterRegistry();
  expect(registry.register(declaration, fixtureBindings(declaration)).ok).toBe(true);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [undefined, () => "not JSON", 1n, new Date(), { invalid: undefined }, cycle]) expect(registry.validateOutput("balance.task.create", value)).toMatchObject({ ok: false, error: { code: "invalid_output", message: "Data is not a supported JSON value." } });
  expect(registry.validateOutput("balance.task.create", { complete: true, items: [null, "ok", 1] })).toEqual({ ok: true, value: { complete: true, items: [null, "ok", 1] } });
});

test("exact schema versions retain valid build metadata", () => {
  const declaration = balanceDeclaration();
  const version = "1.0.0-alpha.1+example.01";
  declaration.schemas[0]!.version = version;
  declaration.capabilities[0]!.inputSchemaRef.version = version;
  declaration.objectTypes[0]!.schemaRef.version = version;
  const registry = new DomainAdapterRegistry();
  expect(registry.register(declaration, fixtureBindings(declaration)).ok).toBe(true);
  expect(registry.validateInput(request(input(), version), {}).ok).toBe(true);
});
