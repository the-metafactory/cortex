# Internal Desk domain-adapter registry

This module validates declarations and typed boundaries for Desk domain adapters. It is independent of the transport surface SDK and does not authorize or execute owner operations.

Register an `AdapterDeclaration` with separate `AdapterBindings`. Registration stages and compiles the complete bundle before publishing anything; a failure returns a safe structured error and preserves previous registrations. Descriptors and discovery results are copies. Handlers are checked for presence and kind but never called by the registry.

`discover()` lists declared capabilities; `capability(id)` also represents unsupported capabilities explicitly. The host may supply connection-specific availability separately. Availability and successful validation are not access grants.

`validateInput(request, hostContext)` accepts exactly `{ capabilityId, inputSchemaRef, input }`. Host context is separate and cannot be supplied through the request envelope. An input schema reference selects an exact bundled version with the capability's declared input schema ID. It never substitutes a newer version. `validateOutput` and `validateError` validate the declared response schemas. Adapter errors must retain `{ code, message, issues? }` and an adapter-namespaced code; the complete error envelope is checked against `errorSchemaRef`.

Schema bundles use synchronous JSON Schema 2020-12 validation through AJV, with strict unknown-keyword/format checks and no remote schema loader. Defaults, coercion and property removal are disabled. `schemaKey({ schemaId, version })` supplies a stable bundle URI for cross-schema `$ref` values. Explicit bundled `$id` and local fragment references are also supported. A schema ID/version cannot be redefined with different content. Schema versions must be canonical exact semvers; contract ranges use strict semver validation.

Relationship fields must describe canonical object references with the four required identity fields, fixed target adapter/object type, nonempty string identity values and no extra identity fields. One/many cardinality follows object/array shape; optional and nullable fields retain their explicit schema behavior. Owners remain responsible for actual object existence and destination validity.

Synthetic conformance fixtures include Balance, work-graph, read-only and observation-only adapters. Their handlers throw if invoked. The isolated tests include a legacy catalogue mapping fixture that preserves saved proposals, edited fields, receipts and source links; it does not migrate production records.

Run the standalone boundary demonstration with:

```sh
bun scripts/probe-desk-adapter-registry.ts
```

It prints discovery, an invalid title with `/title`, a pinned-version mismatch and zero owner calls. Live connections, owner mutations, operation receipts/lifecycle, package loading, conversation drafting and UI hosting remain separate slices.
