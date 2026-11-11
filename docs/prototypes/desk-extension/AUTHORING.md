# Writing a Desk adapter package (prototype contract)

Throwaway prototype for #3292. An adapter package is a directory that Desk discovers. Desk knows nothing about its domain. The types are in `src/conversations/domain-adapters/extension-prototype/contract.ts`, `../types.ts` and `../operations/types.ts`.

## Files

- `desk-adapter.json`: the manifest, matching `PackageManifestSchema` exactly. Unknown fields are refused.
- A prebuilt ESM `.mjs` backend named by `backend.entry`, with its lowercase hex SHA-256 in `backend.sha256`. It may import only Node builtins.
- Optional UI: an HTML entry plus listed HTML, JS or CSS files, each with a SHA-256, and `ui.views` naming the object types it can show.

## Backend

Export `createDeskAdapter(host)`. It returns `{ declaration, bindings }`, and `declaration` must equal the manifest's `declaration` exactly.

- `bindings.handlers[capabilityId]` is required for every `query` and `action` capability. `bindings.observations[capabilityId]` is required for every `observation`, as an object with `poll(context)`. The registry rule is in `../registry.ts`.
- A query handler is `(input, context)`; `context` is `{ connectionId, destinations, continuation?, signal }`. Handlers and `poll` return a `ReadResponse`: the payload, which must match the capability's output schema, plus one annotation per object. An annotation has a JSON Pointer to the object in the payload (or `""` for the whole payload), its `ObjectReference`, its object schema pin, an owner revision, and its `destination` reference when the read binding has a `destinationType`.
- Every object in a response needs an annotation that is valid against the object type's schema. Anything else means Desk shows nothing from that response.
- Actions run through a connector, registered with `host.registerConnector(capabilityId, connection => connector)`. A connector has `support` (`OwnerSupportSchema`), `readbackCapabilityId`, `dispatch(request, signal)` returning an `OwnerResult`, and `readback(request, signal)` returning an `ObjectReadback`. On success, `evidence.refs[0]` identifies the saved object and `output` must match the capability's output schema. Readback `value` must match the object type's schema.

## Bindings in the manifest

`readBindings` tell Desk how to use a read capability:

- `mode`: `query` (add `textPointer` for the input field that carries the search text), `poll`, or `destinations` (lists the places a connection can be scoped to; called with `{}`).
- `display`: JSON Pointers for a title and optional summary, used when no custom view exists.
- `attention`: optional JSON Pointers (`title`, `why`, `due`, `area`, `link`). Only polled objects with this mapping reach Day. Desk derives the rank.
- `destinationType`: set this when objects belong to a place; annotations must then carry `destination`.

`draftingBindings` tell Desk how to prefill an action's input from a discussion. `fieldHints` assign `role` (`title`, `summary`, `destination`, `detail`) to input fields by JSON Pointer. A `destination` hint names the `destinations` capability in `resolveWith`. `widget: "long"` asks for a multi-line editor.

Draft editing is derived from the action's input schema: strings, enums, `format: date`, numbers, booleans and arrays of strings. Use `title` in a schema for its field label. A single relationship declared on the object type at the same field path, with a `resolveWith` hint, becomes a place picker. Anything else makes that field unsupported, and a required unsupported field blocks approval.

`objectTypes[].label` is the word people use in conversation: “turn this into a <label>”.

## Custom view protocol 1.0.0

The view runs in a sandboxed frame with no network, and receives data only through a host `MessagePort`.

1. On `window` `message` with `event.source === parent`, `type: "desk:init"`, `protocol: "1.0.0"` and one transferred port, keep the port and call `start()`.
2. Every message you send carries `instance`, `release` and `protocol` copied from `desk:init`.
3. Send `{ type: "ready", ... }` once. Desk answers `{ type: "host:projection", projection: { view: "result", objectType, object, ref }, theme }`.
4. You may send `{ type: "resize", height }`. Any type outside `ready`, `resize`, `renderer:error` and `host:navigate` closes the bridge and Desk falls back to its own rendering. A view cannot approve or save anything.

The frame's CSP allows scripts and styles only from its own asset path, plus inline styles. Reference `view.js` relatively.

## Running one package

```sh
bun scripts/prototype-desk-extension.ts --fresh --port <port> --state <dir> --samples <dir containing your package directory>
```

Under Adapters: Install, approve, Connect. Install verifies the package without running it; approving restarts Desk automatically. `sample` is the package's directory name. The JSON API a script can use, all POST with an `Origin` header equal to the server origin:

| Path | Body |
| --- | --- |
| `/api/adapters/install` | `{ sample }` |
| `/api/adapters/approve` | `{ packageId, releaseDigest }`, both from `GET /api/view` `adapters[]`; Desk then restarts, so wait about 3 s |
| `/api/adapters/connect` | `{ adapterId }` |
| `/api/say` | `{ text }`, for example `find X` or `Turn this into a <label>` |
| `/api/draft/edit` | `{ id, revision, changes }`, where `changes` is `{ fieldName: value }` |
| `/api/results/more` | `{ id, more }`, `id` being the key in `results` and `more` from the group |
| `/api/draft/approve` | `{ id, revision, digest }`, all from `GET /api/view` `drafts` |

`GET /__prototype/diagnostics` reports package state and refusal codes.
