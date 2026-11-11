# Write a Desk domain adapter

Use this guide to build a package that lists destinations, queries objects, publishes observations, and creates objects from confirmed drafts. The example manages a fictional archive. You can author the package with this guide and the [portable Desk SDK types](../../src/desk-sdk/generated/desk-sdk.d.ts), without reading or changing host code.

A domain adapter owns its objects, schemas, and provider operations. Desk owns drafts, confirmation, policy admission, and receipts. For a chat transport such as Discord, use the separate [surface plugin SDK](../plugin-sdk.md), which defines `PlatformAdapter` and renderers. For a command that prints calendar events or mail items, use [Write a source](write-a-source.md). That command source prints one reading. It does not register domain capabilities or action connectors.

## Choose a bounded package

Start with a local, synthetic owner that needs no credentials or network access. Keep its state inside the package instance. The conformance harness supplies a synthetic connection and runs real host admission, drafting, dispatch, and release paths. It does not connect to your provider.

Choose stable names for the adapter, object types, and capabilities. An object reference contains `adapterId`, `connectionId`, `objectType`, and `canonicalId`. Preserve the owner's canonical ID. Take the connection ID from the request or connector factory. Never hard-code the harness connection ID or choose an account by list position.

Use exact semantic versions for schema references. Use JSON Schema 2020-12 for schema bodies. Reference a declared schema with `urn:desk-schema:<schemaId>:<version>`. Declare each relationship with its JSON Pointer, target adapter, target object type, and cardinality. A destination field contains an object reference, not its display label.

For a read-only adapter, omit action capabilities, connector registration, and drafting bindings. Declare only capabilities that you implement. Every query needs a handler, and every observation needs an observation binding. Actions register through `host.registerConnector`.

## Describe the package

Create a directory for your package. Save the following as `definition.mjs`. Replace the archive vocabulary and schemas with your own domain.

The declaration describes capabilities. The separate `readBindings` map their results to Desk reads. The `draftingBindings` describe how Desk prepares action inputs. These package metadata shapes are strict. Keep the field names and version strings shown here.

```js
const adapterId = "archive";
const version = "1.0.0";
const schemaRef = name => ({ schemaId: `${adapterId}.${name}`, version });
const string = { type: "string", minLength: 1 };
const object = properties => ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const reference = object({ adapterId: { const: adapterId, type: "string" }, connectionId: string, objectType: { const: "shelf", type: "string" }, canonicalId: string });
const schemas = {
	empty: object({}),
	error: object({ code: string, message: string }),
	shelf: object({ title: string }),
	record: object({ title: string, shelf: reference }),
	shelves: object({ items: { type: "array", items: { $ref: "urn:desk-schema:archive.shelf:1.0.0" } } }),
	records: object({ items: { type: "array", items: { $ref: "urn:desk-schema:archive.record:1.0.0" } } }),
	created: object({ ref: object({ ...reference.properties, objectType: { type: "string", const: "record" } }) }),
};
const capability = (name, kind, objectType, input, output) => ({ capabilityId: `${adapterId}.${name}`, label: name, kind, objectTypes: [objectType], inputSchemaRef: schemaRef(input), outputSchemaRef: schemaRef(output), errorSchemaRef: schemaRef("error") });

export const declaration = {
	adapterId, label: "Archive", contractRange: "^1.0.0",
	schemas: Object.entries(schemas).map(([name, schema]) => ({ ...schemaRef(name), schema })),
	objectTypes: [
		{ objectType: "shelf", label: "Shelf", schemaRef: schemaRef("shelf"), relationships: [] },
		{ objectType: "record", label: "Record", schemaRef: schemaRef("record"), relationships: [{ fieldPath: "/shelf", cardinality: "one", targetAdapterId: adapterId, targetObjectType: "shelf" }] },
	],
	capabilities: [
		capability("shelf.list", "query", "shelf", "empty", "shelves"),
		capability("record.list", "query", "record", "empty", "records"),
		capability("record.watch", "observation", "record", "empty", "records"),
		capability("record.create", "action", "record", "record", "created"),
	],
};
const read = (name, mode, objectType, output) => ({ version, adapterId, capabilityId: `${adapterId}.${name}`, mode, objectType, inputSchemaRef: schemaRef("empty"), outputSchemaRef: schemaRef(output), display: { title: "/title" } });
export const readBindings = [
	read("shelf.list", "destinations", "shelf", "shelves"),
	{ ...read("record.list", "query", "record", "records"), destinationType: "shelf", query: { objectsPointer: "/items", ordering: "provider", stableSnapshot: true, limits: { items: 2 } } },
	{ ...read("record.watch", "poll", "record", "records"), destinationType: "shelf", observation: { modes: ["poll"], objectsPointer: "/items", resumable: false } },
];
export const draftingBindings = [{
	bindingVersion: version, adapterId, capabilityId: "archive.record.create", inputSchemaRef: schemaRef("record"),
	guidance: { guidanceId: "archive.record.guidance", version, instructions: "Draft an archive record from the conversation. Ask which shelf to use." },
	fieldHints: [{ pointer: "/title", role: "title" }, { pointer: "/shelf", role: "destination", resolveWith: "archive.shelf.list" }],
}];
export const setup = {
	version, schemas: [{ schemaId: "archive.settings", version, schema: object({}) }],
	configurationSchemaRef: { schemaId: "archive.settings", version }, accountScopeSchemaRef: { schemaId: "archive.settings", version },
	authMethods: [{ kind: "local" }],
};
```

Keep each read binding's schema references equal to its capability's references. For list results, put object values in `payload.items`. Set `objectsPointer` to `/items`. Map `display.title` to a string inside each object. Use `destinationType` to restrict object reads to a declared destination type.

For conversation drafting, bind the action's exact input schema. Add a `destination` hint for each relationship field. Set `resolveWith` to its destinations query. Use `title`, `summary`, or `detail` for other top-level fields. For a multiline string editor, add `widget: "long"`. Guidance proposes values. Guidance does not grant permission to write.

For connection settings, declare configuration and account-scope schemas inside `setup.schemas`. Reference those schemas through `configurationSchemaRef` and `accountScopeSchemaRef`. Use empty object schemas if there are no settings. Keep secrets out of schemas, defaults, package files, and diagnostic output.

For an actual provider, select the authentication method supported by the shipped connection settings: `local`, `token`, or `broker`. A token method contains `slots: [{ name, label, required }]`. A broker method contains `brokerId`. The conformance harness runs only packages that offer `local` authentication. Token-only or broker-only packages report `not-run` and exit 2. Do not add a fake local method to a production package to bypass setup.

## Implement the backend

Save the following as `adapter.mjs`. The build step bundles its declaration into one ESM file. The exported factory returns the same declaration as the manifest and supplies runtime bindings.

```js
import { declaration } from "./definition.mjs";

const now = () => new Date().toISOString();
const schemaRef = name => ({ schemaId: `archive.${name}`, version: "1.0.0" });
const ref = (connectionId, objectType, canonicalId) => ({ adapterId: "archive", connectionId, objectType, canonicalId });

export function createDeskAdapter(host) {
	const records = new Map(["Index", "Ledger", "Register"].map((title, index) => [`record-${index + 1}`, { title, shelf: "main" }]));
	const value = (record, connectionId) => ({ title: record.title, shelf: ref(connectionId, "shelf", record.shelf) });
	const scoped = destinations => [...records].filter(([, record]) => destinations.some(destination => destination.canonicalId === record.shelf && destination.objectType === "shelf"));
	const annotation = (connectionId, id, index, destination, objectType) => ({ pointer: `/items/${index}`, ref: ref(connectionId, objectType, id), schemaRef: schemaRef(objectType), destination, position: index, evidence: { evidenceId: `read-${id}`, revision: "1", observedAt: now() } });
	const listShelves = request => {
		const connectionId = request.destinations[0].connectionId;
		const shelf = ref(connectionId, "shelf", "main");
		return { readVersion: "1.0.0", payload: { items: [{ title: "Main shelf" }] }, annotations: [annotation(connectionId, "main", 0, shelf, "shelf")], observedAt: now(), ordering: "provider", snapshot: { kind: "stable", id: "shelves-1" } };
	};
	const listRecords = request => {
		const connectionId = request.destinations[0].connectionId;
		const matching = scoped(request.destinations);
		const offset = Number(request.cursor ?? 0);
		const page = matching.slice(offset, offset + request.limit);
		const next = offset + page.length;
		return { readVersion: "1.0.0", payload: { items: page.map(([, record]) => value(record, connectionId)) }, annotations: page.map(([id, record], index) => ({ ...annotation(connectionId, id, index, ref(connectionId, "shelf", record.shelf), "record"), position: offset + index })), observedAt: now(), ordering: "provider", snapshot: { kind: "stable", id: `records-${records.size}` }, ...(next < matching.length ? { cursor: String(next) } : {}) };
	};
	host.registerConnector("archive.record.create", connection => ({
		kind: "action", ...connection, capabilityId: "archive.record.create", writerOwner: "archive-owner",
		support: { lifecycleVersion: "1.0.0", ...connection, capabilityId: "archive.record.create", declarationId: "archive-support-1", dedup: { kind: "none" }, operationLookup: "none", conditionalUpdate: "none", cancellation: "none" },
		readbackCapabilityId: "archive.record.list",
		dispatch(request, signal) {
			signal.throwIfAborted();
			const input = request.snapshot.input;
			if (input.shelf.adapterId !== connection.adapterId || input.shelf.connectionId !== connection.connectionId || input.shelf.objectType !== "shelf" || input.shelf.canonicalId !== "main") throw new Error("Unknown archive shelf");
			const id = `record-${records.size + 1}`;
			records.set(id, { title: input.title, shelf: input.shelf.canonicalId });
			const created = ref(connection.connectionId, "record", id);
			return { lifecycleVersion: "1.0.0", operationId: request.operationId, attemptId: request.attemptId, snapshotDigest: request.snapshot.digest, resultId: `created-${id}`, reportedAt: now(), result: { kind: "succeeded", output: { ref: created }, evidence: { kind: "effect", evidenceId: `effect-${id}`, observedAt: now(), ownerRequestId: request.ownerRequestId, receipt: { id }, refs: [created] } } };
		},
		readback(request, signal) {
			signal.throwIfAborted();
			const record = records.get(request.ref.canonicalId);
			const envelope = { lifecycleVersion: "1.0.0", ref: request.ref, checkedAt: now(), provenance: { ...connection, evidenceId: `readback-${request.ref.canonicalId}` } };
			return record ? { ...envelope, result: { kind: "present", schemaRef: schemaRef("record"), value: value(record, connection.connectionId), ownerRevision: "1", links: [] } } : { ...envelope, result: { kind: "unknown", reason: { code: "archive.unknown", message: "The owner cannot find this record." } } };
		},
	}));
	return { declaration, bindings: {
		handlers: { "archive.shelf.list": listShelves, "archive.record.list": listRecords },
		observations: { "archive.record.watch": { modes: ["poll"], fetch(request, signal) {
			signal.throwIfAborted();
			const connectionId = request.source.connectionId;
			const page = scoped(request.source.destinations);
			return { version: "1.0.0", payload: { items: page.map(([, record]) => value(record, connectionId)) }, events: page.map(([id, record], index) => ({ kind: "present", pointer: `/items/${index}`, ref: ref(connectionId, "record", id), schemaRef: schemaRef("record"), destination: ref(connectionId, "shelf", record.shelf), observedAt: now(), revision: "1", evidenceId: `observed-${id}` })), gap: false, coverage: "objects" };
		} } },
	} };
}
```

Keep factory construction free of provider effects. The host passes only `sdkVersion` and `registerConnector` to `createDeskAdapter`. Register a factory for each action capability. The host calls that factory with `{ adapterId, connectionId }` after a connection exists. The Desk SDK exports the corresponding `CreateDeskAdapter`, `DeskActionConnector`, `QueryPage`, `ObservationBatch`, `OwnerResult`, and `ObjectReadback` types. Use type-only imports when you author in TypeScript.

For a destination listing, return at least one synthetic destination in the harness. It calls the handler with a root seed reference. Derive the connection ID from that seed. Return each listed destination's reference in its annotation. Use the destination itself as the annotation's `destination`.

For a query, return a `QueryPage`, not a bare array. Use `readVersion: "1.0.0"`. Include one annotation for each object at `/items/<index>`. Each annotation names the object's reference, exact schema reference, destination, provider position, and evidence. Use a nonempty evidence ID and revision, plus an ISO timestamp. The annotation's destination must equal one of the admitted request destinations. Filter by those destinations before you return values.

Respect `request.limit` and `signal`. Keep pages within the binding's bounds: at most 20 objects, 1 MiB, and 10 seconds per page. Return an opaque `cursor` only when another page exists. Retain the same stable snapshot ID across pages. If the owner cannot retain a snapshot, declare `stableSnapshot: false` and return `{ kind: "live" }`. The example's immutable seed data spans two pages. Replace its size-based snapshot ID with an owner revision or retained snapshot before supporting updates.

For observations, implement `{ modes: ["poll"], fetch(request, signal) }`. Return `version: "1.0.0"`, a schema-valid payload, and events that identify each object. Read scope comes from `request.source.destinations`. Mark `gap` when continuity is lost. With `coverage: "objects"`, an absent object does not mean deletion. Report deletion only with owner evidence. Use the SDK's `ObservationBatch` union for tombstones and other coverage modes.

For an action, name `writerOwner` and provide `support` for the exact adapter, connection, and capability. Advertise only owner guarantees that you implement. The example declares no deduplication, operation lookup, conditional update, or cancellation. Desk cannot infer safe retries from a successful HTTP status or an adapter-generated key.

Perform the effect only inside `dispatch`. Use the authorized `request.snapshot.input` and destinations. Preserve `operationId`, `attemptId`, `snapshotDigest`, and `ownerRequestId` in the returned owner result. A successful result needs schema-valid `output` and effect evidence, including the created reference. An uncertain provider response must use the SDK's uncertain result instead of reporting success or retrying blindly.

For canonical readback, set `readbackCapabilityId` to a declared query capability for the same object type. Implement `readback` separately from the query handler. Echo the requested reference and return current owner evidence in `ObjectReadback`. The host checks current policy before release. A historic success receipt does not prove that the object still exists. The example returns `unknown` when its in-memory owner cannot find a record.

## Build a verified package

Save the following as `build.mjs`. Run it with Bun from your package directory.

```js
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { declaration, draftingBindings, readBindings, setup } from "./definition.mjs";

const dir = import.meta.dir;
const built = await Bun.build({ entrypoints: [`${dir}/adapter.mjs`], target: "bun", format: "esm", minify: true });
if (!built.success) throw new AggregateError(built.logs, "Archive adapter build failed");
await writeFile(`${dir}/backend.mjs`, await built.outputs[0].text());
const sha256 = createHash("sha256").update(await readFile(`${dir}/backend.mjs`)).digest("hex");
await writeFile(`${dir}/desk-adapter.json`, `${JSON.stringify({
	format: "desk-adapter-package/1", packageId: "example.archive", packageVersion: "1.0.0", deskSdkRange: "^1.2.0", domainContractVersion: "1.0.0",
	backend: { entry: "backend.mjs", sha256 }, declaration, draftingBindings, readBindings, setup,
}, null, 2)}\n`);
```

```sh
bun build.mjs
```

The command writes `backend.mjs` and `desk-adapter.json`. Ship those two files for this example. Rebuild after every source edit. The loader checks the SHA-256 of the exact backend bytes and compares the factory's declaration with the manifest declaration.

Keep `format: "desk-adapter-package/1"` and `domainContractVersion: "1.0.0"`. Choose a namespaced `packageId`, such as `example.archive`, and an exact `packageVersion`. Set `deskSdkRange` to the SDK versions you support. This guide targets Desk SDK 1.2.0. The domain contract, package version, setup version, read version, and lifecycle version are separate contracts.

Bundle runtime dependencies into the `.mjs` entry. Keep files inside the package directory. The loader rejects filesystem and process imports, escaped paths, and dependencies outside its allowlist. Type-only SDK imports disappear during bundling. Do not import Cortex internals. If your adapter requires a host fact or runtime seam that this guide and the SDK do not supply, report the missing contract before changing host code.

For an adapter-owned view, add the optional `ui` manifest object with `protocolVersion: "1.0.0"`, an HTML `entry`, `views: [{ objectType, view: "result" }]`, and `files: [{ path, sha256, mediaType }]`. Use `view: "editor"` for an editor. Declare and hash every asset. Deliver the entry as one self-contained HTML document with inline code and styles. Treat the frame as isolated. Request host-mediated reads and actions through the versioned UI protocol. The backend conformance command does not prove browser containment or editor behavior. Complete those UI checks separately before claiming a view works.

## Run conformance

Give your package directory to a host principal with the conformance harness. From the Cortex checkout, the principal runs:

```sh
bun scripts/desk-adapter-conformance.ts /path/to/your-package
bun scripts/desk-adapter-conformance.ts /path/to/your-package --json
```

For the committed example, run:

```sh
bun scripts/desk-adapter-conformance.ts docs/desk/examples/domain-adapter
```

Expect `CONFORMANT example.archive` and conformant rows for `destinations`, `query`, `observation`, `draft`, `action`, and `readback`. The query follows two pages. Dispatch and readback each make one synthetic owner call. Network requests and credential requests remain zero. Exit 0 means conformant, exit 1 means refused, and exit 2 means not run. Usage errors exit 64.

Inspect every declared capability in the report. A capability without a read binding might not receive a query probe. Do not treat an absent row as a pass. The example's test checks the expected probes and declared capability coverage.

The harness creates an authorized synthetic connection named `conformance-connection`. It lists destinations first, builds valid inputs from declared schemas, and uses a synthetic conversation model for drafts. Use ordinary schema constraints, defaults, or enums for deterministic inputs. It does not supply provider-specific fixture IDs. It follows at most eight query pages and tests successful action dispatch with owner evidence followed by canonical readback.

If the report says `digest_mismatch`, rebuild the manifest after the backend. For `module_incompatible`, compare the returned declaration with the manifest. For `missing_handler`, supply the binding for every declared query and observation. For `invalid_annotations`, inspect pointers, annotation counts, schema references, and admitted destinations. For `draft_blocked`, inspect required fields and destination resolvers. For `readback_unavailable`, check the connector's declared query capability and its readback method.

To exercise injected failures, run the same command with `--failures`. A successful baseline proves the backend contract against synthetic data. It does not approve installation, credentials, production writes, UI behavior, or migration cutover.

## Repeat the blind authoring check

Freeze the guide and SDK types for a fresh authoring session. Supply only those files and a new-domain task. Do not supply this repository's example package, host source, or harness implementation. Have the author return a package and record every fact that was missing. Let the host principal run the harness and preserve the JSON report.

If the author needs a missing fact, correct the guide. Discard that attempt as acceptance evidence. Repeat from an empty package directory in a new session, using the corrected guide and the same SDK boundary. If completion requires host source or an SDK change, stop and escalate the unmet contract on the node.

Preserve the successful package, exact input digests, harness command, and report at a pinned commit. Link that commit from the node's close prose. Keep the [authoring evidence](evidence/domain-adapter-authoring.md) with the guide so a later author can rerun the check.
