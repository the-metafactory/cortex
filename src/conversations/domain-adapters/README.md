# Internal Desk domain-adapter registry

This module validates declarations and typed boundaries for Desk domain adapters. It is independent of the transport surface SDK and does not authorize or execute owner operations.

Register an `AdapterDeclaration` with separate `AdapterBindings`. Registration stages and compiles the complete bundle before publishing anything; a failure returns a safe structured error and preserves previous registrations. Descriptors and discovery results are copies. Each `query` requires an entry in `bindings.handlers`; each `observation` requires an entry in `bindings.observations`. A missing binding returns `missing_handler`. An `action` requires no registry handler: actions dispatch only through the registered connector, which is their single binding. An entry in `bindings.handlers` naming an action returns `invalid_registration` without publishing any of that declaration. The registry never calls handlers.

`discover()` lists declared capabilities; `capability(id)` also represents unsupported capabilities explicitly. The host may supply connection-specific availability separately. Availability and successful validation are not access grants.

`validateInput(request, hostContext)` accepts exactly `{ capabilityId, inputSchemaRef, input }`. Host context is separate and cannot be supplied through the request envelope. An input schema reference selects an exact bundled version with the capability's declared input schema ID. It never substitutes a newer version. `validateOutput` and `validateError` validate the declared response schemas. Adapter errors must retain `{ code, message, issues? }` and an adapter-namespaced code; the complete error envelope is checked against `errorSchemaRef`.

Schema bundles use synchronous JSON Schema 2020-12 validation through AJV, with strict unknown-keyword/format checks and no remote schema loader. Defaults, coercion and property removal are disabled. `schemaKey({ schemaId, version })` supplies a stable bundle URI for cross-schema `$ref` values. Explicit bundled `$id` and local fragment references are also supported. A schema ID/version cannot be redefined with different content. Schema versions must be canonical exact semvers; contract ranges use strict semver validation.

Relationship fields must describe canonical object references with the four required identity fields, fixed target adapter/object type, nonempty string identity values and no extra identity fields. One/many cardinality follows object/array shape; optional and nullable fields retain their explicit schema behavior. Owners remain responsible for actual object existence and destination validity.

Synthetic conformance fixtures include Balance, work-graph, read-only and observation-only adapters. The action adapters have no registry handlers; query handlers throw if invoked. The isolated tests include a legacy catalogue mapping fixture that preserves saved proposals, edited fields, receipts and source links; it does not migrate production records.

Run the standalone boundary demonstration with:

```sh
bun scripts/probe-desk-adapter-registry.ts
```

It prints discovery, an invalid title with `/title`, a pinned-version mismatch and zero owner calls. Live connections, owner mutations, operation receipts/lifecycle, package loading, conversation drafting and UI hosting remain separate slices.

## Inactive writer cutover

<!-- glossary-ignore: host, owner, instance, message, run, path -->

`ConversationHost.lifecycleWriters()` owns `cortex.writer-authority/1` in the
configured host durable store. `begin(plan, expectedRevision)` is an explicit
principal-only invocation; it immediately fences lifecycle admission and the
connection-unqualified legacy owner route. Use the existing legacy `OwnerType`
as `binding.owner` when covering that route, and the same host-registered
`TrustedConnector.writerOwner` for lifecycle dispatch and cancellation. The
five-part binding and active epoch/instance/receipt must match at connector entry.
This module does not activate any production consumer.

`resume(bindingKey, steps)` records disable, stop, drain, stopped verification,
source-hashed import, epoch acquisition and guarded enablement separately.
Retries use the persisted plan and revision. A failed step retains its stage and
failure evidence with mutation disabled; no rollback starts the old writer.
Unknown versions are unavailable to mutation. Existing journals and read-only
readers remain available without acquiring a writer lease.

The host must supply a complete managed-entrypoint inventory, including known
PIDs, jobs and calls. An unmanaged entry or unavailable process inspection
refuses activation with an actionable reason. Every uncertain call must appear in
the import inventory. `readLegacyImportWatermark` verifies each durable imported
journal against its source digest and returns a deterministic aggregate hash;
it never infers completion from a printed importer message.

`ManagedWriterSupervisor` checks command outcomes independently of the existing
best-effort upgrade/reload helpers. Launchd retirement disables and boots out
labels, removes startup definitions and verifies disabled jobs/PIDs. Systemd
retirement stops and persistently masks units and verifies cgroup descendants,
known PIDs and pending jobs. The approved service uses a distinct label and
`renderGuardedWriterService`; the installed launcher and implementation manifest
live under the persistent state root, outside the package upgrade tree.

The persistent manifest is monotonic and retains retired digests. The launcher
resolves the selected executable, checks its SHA-256 and approved version before
starting it, and refuses missing, disabled, unknown or changed manifest state.
Service renderers retain the guarded route and skip retired launchd definitions;
masking continues to fence retired systemd instances. Upgrading to another writer
requires another explicit verified cutover, never an automatic floor reduction.
Deleting or editing the persistent fence is not a supported rollback procedure.

This boundary fences supported managed entrypoints. It does not prevent an
unrestricted OS owner from deliberately running an old executable or editing
protected state. The principal-approved inventory and process inspection are trusted host
bindings; they are never adapter/model input. No live cutover is authorized here.

Run `bun scripts/probe-desk-writer-fence.ts` for the checked-in synthetic probe:
temporary store/manifest, fake launchd supervisor and harmless executable files.
It retires the old executable, closes/reopens the store, refuses its restart
through the stable path, and executes only the approved digest once.

## Schema-guided drafting

<!-- glossary-ignore: draft, binding, manifest, host, owner, user, path, data, run -->

`drafting.ts` is the internal durable drafting service (`ConversationHost.drafts(deps)`). `DraftingBindings` registers separate strict drafting binding 1.0.0 documents keyed by exact `adapterId`/`capabilityId`/`inputSchemaRef`; field hints are limited to `pointer`, `role`, optional `resolveWith` and optional `widget: "long"`. Registration fails closed on unknown fields or versions, unresolved pointers, duplicates and relationship mismatches. It does not touch registry 1.0.0 or the surface SDK.

`make` creates or reopens a draft per conversation, entry and capability; `newDraft` creates a distinct one and several matches return a selection. Every mutation is a compare-and-swap on the draft revision. Edits own whole top-level fields (including `null`, omission and compound subtrees); `refresh` changes only untouched generated or suggested fields, and `regenerateField` is the one way to release a user-owned field. Model output supplies candidate values and citations only: citations are checked against the captured manifest, references resolve through the host-supplied destination resolver, and structured values are marked suggested. Host policy is rechecked before model input and before output release; local-only sources never reach a cloud lane. `handoff` validates the exact current revision and returns the data for the existing approval path. Nothing here calls an owner.

Run the vertical demonstration with `bun scripts/probe-desk-drafting.ts`.
