<!-- glossary-ignore: host, token, path, user, data -->
# Desk adapter package and SDK authoring contract

This is the initial authoring contract for a Desk adapter package. It describes the `desk-adapter-package/1` manifest, the separately versioned Desk adapter SDK (1.2.0, an additive amendment of 1.0.0 and 1.1.0), and how the host discovers, approves and activates a generation. The loader lives in `src/conversations/domain-adapters/package.ts`; the SDK barrel is `src/desk-sdk/index.ts` (`DESK_ADAPTER_SDK_VERSION = "1.2.0"`).

The Desk adapter SDK is distinct from the surface plugin SDK. `SURFACE_SDK_VERSION` is unchanged: no existing surface export changes here. A Desk adapter is not a surface transport plugin, and a `cortex-plugin.yaml` is never reinterpreted as a Desk package manifest.

SDK 1.1.0 amends 1.0.0 additively: it types query handlers and observation bindings (the untyped 1.0.0 binding shape stays assignable), and lets an action connector supply dispatch, cancel, lookup and readback. A package built against 1.0.0 still loads, and `deskSdkRange: "^1.0.0"` still matches. No new major version is introduced.

SDK 1.2.0 amends 1.1.0 additively: the manifest's `ui.views[].view` accepts `editor` beside `result`, so a package can declare an editor mount of an object type it already declares. The UI wire format stays 1.0.0 (`DESK_UI_PROTOCOL_VERSION`), every wire message keeps its version, and a package built against 1.1.0 still loads because `deskSdkRange: "^1.1.0"` still matches 1.2.0. A manifest that declares only `result` views keeps the release digest it had under 1.1.0, because the digest already sorts the view pairs by object type and view name.

## Trust position

Backend adapter code runs in process with host privileges. The manifest checks and import scan below are an authoring and validation boundary, not a malicious-code sandbox. A package is either a bundled first-party default or an installed arc package the principal approved by its exact origin, version and release digest. Installation grants no connection access, no read or write authority and no provider effect.

## Package layout

An installed or bundled package directory contains `desk-adapter.json` and one prebuilt ESM backend bundle:

```text
my-desk-adapter/
  desk-adapter.json
  backend.mjs
  assets/app.html
  assets/app.js
```

`desk-adapter.json` is closed and strict. Unknown top-level, nested or setup fields fail closed.

```json
{
  "format": "desk-adapter-package/1",
  "packageId": "the-metafactory.desk-adapter-balance",
  "packageVersion": "1.0.0",
  "deskSdkRange": "^1.0.0",
  "domainContractVersion": "1.0.0",
  "backend": { "entry": "backend.mjs", "sha256": "<64 lowercase hex>" },
  "declaration": { "adapterId": "balance", "label": "Balance", "contractRange": "^1.0.0", "schemas": [], "objectTypes": [], "capabilities": [] },
  "draftingBindings": [],
  "readBindings": [],
  "setup": {
    "version": "1.0.0",
    "schemas": [],
    "configurationSchemaRef": { "schemaId": "balance.setup.configuration", "version": "1.0.0" },
    "accountScopeSchemaRef": { "schemaId": "balance.setup.account", "version": "1.0.0" },
    "authMethods": [{ "kind": "local" }]
  },
  "ui": {
    "protocolVersion": "1.0.0",
    "entry": "assets/app.html",
    "views": [{ "objectType": "task", "view": "result" }],
    "files": [
      { "path": "assets/app.html", "sha256": "<64 lowercase hex>", "mediaType": "text/html" },
      { "path": "assets/app.js", "sha256": "<64 lowercase hex>", "mediaType": "text/javascript" }
    ]
  }
}
```

Fields:

- `packageId` is a stable, lowercase, namespaced identifier. `packageVersion` is exact SemVer. `deskSdkRange` is a SemVer range that must include the running `DESK_ADAPTER_SDK_VERSION`.
- `domainContractVersion` is exactly `1.0.0`. The declaration's `contractRange` is checked against the running domain contract independently.
- `declaration` is the existing strict `AdapterDeclaration`; its schemas and schema references keep independent immutable pins.
- `draftingBindings` and `readBindings` are arrays of the independently versioned drafting binding 1.0.0 and read binding 1.0.0 documents, or empty arrays. Every entry is validated against the declaration before registration. An empty array is valid.
- `setup` is a strict host-owned setup descriptor. Both schema references must resolve exactly in the setup schema bundle, and both documents must be object schemas. `authMethods` is a nonempty list of closed alternatives: local, token slots, or one host-registered broker ID. No token value, URL, callback, permission default or arbitrary secret name belongs here.
- `backend.entry` is one relative `.mjs` file with an exact SHA-256. Relative imports, remote imports, package-manager imports, `eval` and `new Function` are refused. The only approved module specifiers are `@the-metafactory/cortex/desk-sdk` and the documented `node:` builtins (`crypto`, `buffer`, `util`, `url`, `zlib`, `stream`, `events`, `string_decoder`, `timers`, `net`, `tls`). A local dependency must be part of the one verified bundle.
- `ui` is optional. Its `protocolVersion` is exactly `1.0.0`; `entry` must be one listed file and must be HTML; `views` lists the object types the host may mount and, per object type, which view it mounts (`result` or `editor`, see below); `files` lists unique package-relative assets with an allowed media type and exact digest. No remote URL, import map, service worker or path outside the package is accepted.
- Manifest and every listed file are realpath-contained in the verified package directory. Traversal, absolute paths, symlinked entries and symlinked manifests fail closed. Deterministic host bounds apply to the manifest, file count and file size.

Host bounds: 512 KiB manifest, 256 asset files, 8 MiB per file. These are fixed in `package.ts`; a package cannot raise them.

## Views and wire messages

A `ui.views` entry is a closed `{ objectType, view }` pair. `view` is exactly `result` or `editor`; the object type must be declared by the package's own `declaration.objectTypes`. Any other view name, a missing field or an extra field refuses the whole manifest as `invalid_manifest` during discovery, before any backend module is imported. An object type may appear twice, once per view, and the catalog lists both entries.

| View | What the host mounts it for | Wire messages it may send |
| --- | --- | --- |
| `result` | Showing the outcome of a completed operation or a read picture of the object. | The read-only 1.0.0 result messages. `draft:change` and `action:propose` are refused. |
| `editor` | Reviewing and changing a host-owned draft of one of the adapter's object types, and proposing an action for it. | The read-only 1.0.0 messages plus `draft:change` and `action:propose`. |

`draft:change` and `action:propose` are the only messages an `editor` mount gains over a `result` mount. Both remain suggestions to the host: an editor mount never carries create, send, run or enable authority, and the host's own review and confirmation still decide what leaves Desk. Declaring an `editor` view says nothing about which of the adapter's capabilities a connection is allowed to read or write; the connection's capability lists still bound what the catalog offers and what the host admits.

The frame bridge that mounts an adapter document, pins its hash and enforces the per-view message split is a separate slice (node #3326). This contract only validates the declaration and publishes it in the asset catalog.

## Inline UI entry

The asset route delivers the active generation's HTML entry as one self-contained document for a `sandbox="allow-scripts"` frame. Author the entry with external classic scripts (`<script src="app.js"></script>`, optionally `type="text/javascript"`), stylesheet links (`<link rel="stylesheet" href="app.css">`) and images (`<img src="picture.png">`). Every reference must resolve to a file listed in `ui.files`. References, including CSS `url(...)` inside a stylesheet, resolve relative to the HTML entry, not the stylesheet directory. Use relative package paths; absolute paths, protocol-relative URLs, remote URLs and existing `data:` URLs are refused. CSS URLs may be quoted or unquoted and can reference listed images or fonts.

The Cortex runtime verifies each referenced file's digest before building the document. Scripts become inline scripts, stylesheet links become styles, and images and CSS URLs become `data:` URIs using the manifest media type. Script and style hashes pin their exact inline text in the response CSP; text is UTF-8 with HTML newline normalization. The ETag identifies the produced document. Other listed files retain their individual asset responses.

Script elements must omit `defer`, `async` and `nomodule`: their execution semantics cannot be preserved when the script becomes inline. Place scripts after the elements they access. Stylesheet links must use only `rel="stylesheet"`, `href`, optional `media` and optional `type="text/css"` attributes. The resulting style element retains `media`. Alternate, named and disabled stylesheets are unsupported.

Keep script and style element bodies empty in the authored HTML. Module scripts, inline bodies, `style=` attributes, `on*` handlers, CSS `@import` and runtime-built asset URLs are unsupported. Script text must not contain HTML script delimiters (`</script`, `<script`, `<!--`); stylesheet text must not contain a closing style delimiter. Use JavaScript string escapes where those strings are needed. Other elements may carry only fragment values in `src`, `href`, `srcset`, `poster`, `data` or `action` attributes. Embedded `srcdoc` documents and meta `http-equiv` directives (including refresh) are refused. An unsupported entry returns `422 ui_not_inlinable`; a missing or tampered listed file returns 503. The document CSP denies network connections, workers, child frames, forms and external resources. No runtime asset fetch, module import or external font reference is supported.

Execute `bun scripts/probe-desk-adapter-inline.ts` to exercise local and authenticated hosted rig routes in headless Chromium and WebKit. It checks UTF-8 script and style hashes without a meta charset, stylesheet media and image rendering, opaque-origin containment, zero subresource requests and rejection of an unsupported entry, using only synthetic packages and authentication.

## Backend module

The backend entry exports exactly one factory:

```ts
import type { DeskAdapterHost, DeskAdapterModule } from "@the-metafactory/cortex/desk-sdk";
import declaration from "./declaration.json" with { type: "json" };

export const createDeskAdapter: DeskAdapterModule["createDeskAdapter"] = (host: DeskAdapterHost) => {
  host.registerConnector("balance.task.create", connection => ({
    kind: "action",
    adapterId: "balance",
    connectionId: connection.connectionId,
    capabilityId: "balance.task.create",
  }));

  return {
    declaration,
    bindings: {
      handlers: { "balance.task.query": () => ({ objects: [] }) },
      observations: {},
    },
  };
};
```

Rules the loader enforces at activation:

- The module's returned `declaration` must equal the verified manifest declaration. A mismatch is `module_incompatible`.
- Each declared `query` needs a handler and each `observation` needs an observation binding. An `action` has no registry handler; it binds only through one registered connector.
- Every declared action capability needs exactly one `host.registerConnector` registration, and no other capability may register one. Registration happens before any connection exists and uses no credentials.
- The host creates a connector per connection on demand. Publication never calls the connector factory.
- The module must not export anything else. A missing or throwing `createDeskAdapter` affects only that adapter and publishes nothing from it.
- Registration stages in a fresh registry and is swapped in atomically. A failed update leaves the previous validated generation selected. Ordinary failures leave other adapters usable.

`bindings.handlers` and `bindings.observations` are the existing internal registry bindings. The host validates them with the strict registry; the module cannot widen authority through the declaration or the UI descriptor.

## Backend calls

A package supplies the calls below; the host adapts them to the `TrustedConnector` and `QueryPage` shapes its authority paths already use (`src/conversations/domain-adapters/package-backend.ts`). `loader.trustedConnector(adapterId, connection, { authorizeConnection, actionCapabilityId? })` builds one per connection and returns the connector with a per-path availability report (`query`, `observation`, `dispatch`, `cancel`, `lookup`, `readback`). `loader.registry()` returns the composed registry the authority mediator needs.

| Path | Where the package supplies it | Host contract |
| --- | --- | --- |
| query | `bindings.handlers[capabilityId](request, signal)` for each declared `query` capability | The request is the host's `QueryFetchRequest`; the result must parse as a `QueryPage` or the call fails. |
| observation | `bindings.observations[capabilityId]`: `{ modes, ordering?, fetch(request, signal) }` | `fetch` returns an `ObservationBatch`, validated by the host against the read binding. All observation bindings of one adapter must share one ordering id, or the path is unavailable. |
| dispatch | the action connector's `dispatch(request, signal)`, with `writerOwner` and `support` | `support` must name this adapter, connection and action capability. The host's writer fencing, confirmation and journal run first. |
| cancel, lookup | the action connector's `cancel` and `lookup` | Optional; each is offered only when supplied, independent of dispatch. |
| readback | the action connector's `readback(request, signal)` and `readbackCapabilityId` | Offered independent of dispatch. `readbackCapabilityId` must name a declared `query` capability of the same adapter, else the path is unavailable. The host releases the result only for an exact, restricted object reference. |

Rules:

- A call the package omits makes that path unavailable. The report names it with a `<path>_unavailable` code, the matching `TrustedConnector` member is absent (or, for dispatch, throws `DeskBackendUnavailableError` and carries an owner support that matches no snapshot), and the host never substitutes a synthetic connector.
- The host owns credential and account checks. A package cannot report a connection as available: `authorizeConnection` comes from the host.
- Every call re-checks that the adapter is still available and that the connector's generation is still the published one. Disable, uninstall or a newer generation fences a connector built earlier.
- Requests are passed as copies. The package receives no credentials, and the host's admission, scope, release and writer checks around each call are the same as for a synthetic connector.
- A connector serves one action capability. An adapter that registers several must name one in `actionCapabilityId`.
- Not supplied by a package in this amendment: the legacy `read` call for destination and poll reads.

## Discovery, approval and activation

The host supplies:

- bundled package directories;
- approved package roots plus an arc inventory runner (production defaults to `arc list --json` reading the configured arc package-repos directory);
- principal approvals `{ packageId, origin, packageVersion, releaseDigest }` for installed packages;
- the configured surface-plugin signing posture and trust root, which are reused as-is. No Desk-specific allowlist, exemption or flag is added;
- the durable generation store from the conversation host.

`discover()` reads and verifies manifests, identity uniqueness, version compatibility, setup documents, bindings, file digests, containment, trust and signatures. It does not import a backend. Binding validation stages every installable candidate in one registry so their relationships resolve, including a dependent whose target is not approved yet. A candidate that fails that pass is re-staged beside the candidates of its trust level, so an approved package is re-staged beside the other approved packages even when one of them failed the joint pass, and an unapproved package only beside unapproved ones. A package whose bindings do not match is thus refused by `install()` before the principal approves it, while an unapproved package's registration conflict neither displaces an approved release of the same adapter nor makes an approved package or an approved dependent unavailable. `install(packageId)` reports `{ packageId, packageVersion, adapterId, origin, releaseDigest }` without importing, so the principal can approve that exact release without a restart. A refused package reports its code immediately.

`activate(packageId, { releaseDigest })` is the managed activation step. It re-verifies the release, imports the verified backend, validates the returned declaration and connectors, composes a complete new registry snapshot, persists the selected generation, and swaps the snapshot atomically. Installation alone never restarts a service; Approve and Remove trigger the managed activation, which is outside this loader.

The release digest covers the canonical verified manifest, backend and asset identities, declaration, drafting and read bindings and setup descriptor. The durable store keeps `active`, `lastValid` and a bounded history per adapter. A rejected staged update leaves both unchanged.

## Availability, disable and uninstall

- Missing, throwing or incompatible modules are visibly unavailable. Nothing from that adapter is partially published.
- `catalog()` lists only available generations with their package generation, declaration, read bindings, drafting bindings, UI descriptor and availability.
- `disable(adapterId)` immediately fences logical admission and removes the adapter from the catalog; the in-process registration stays until a managed restart.
- `uninstall(adapterId)` does the same and marks the durable record uninstalled. Package files and stored drafts, receipts and schema pins are retained. It deletes no credential, remote object or user data.
- `boot()` applies durable fences at a managed restart. Fenced generations are not published. It composes every trusted package into one snapshot so relationships between adapters resolve; when that composition fails it publishes each adapter whose relationship targets are already published, repeats until no further adapter can be published, fences the adapters whose relationship targets will never publish, and offers the rest that still wait as one group, so an adapter stranded only by ordering or by a reference to its own object type still publishes and one adapter's composition failure leaves the others usable. An adapter whose target never publishes is fenced `dependency_unavailable` and names that target. The strict registry requires a relationship's target adapter and object type to be registered before the declaration that names it, so two adapters that wait on each other never register in one snapshot: both stay unavailable with the registry's refusal, and neither is published partially.
- `admit(adapterId, { releaseDigest })` returns `available`, `unavailable` or `upgrade_required`. A stored generation that does not match the active one is never downconverted. The caller must reopen it with the matching generation.

## Verification

The synthetic tests are `src/conversations/domain-adapters/__tests__/package-loader.test.ts`. They use temporary package roots, a fake arc inventory and a real temporary host store.

The standalone demonstration is:

```sh
bun scripts/probe-desk-adapter-packages.ts
```

The backend seam has its own tests (`src/conversations/domain-adapters/__tests__/package-backend.test.ts`) and probe:

```sh
bun scripts/probe-desk-package-backend.ts
```

It loads fixture packages with `DeskPackageLoader` in a temporary host and drives query, observation, confirmed dispatch and readback through the host paths, shows omitted calls reported unavailable, and fences a disabled adapter.

The extension prototype's fixture packages are committed under `docs/prototypes/desk-extension`; `bun docs/prototypes/desk-extension/build-packages.ts` regenerates them byte for byte.

The packaging probe loads a bundled default and an explicitly approved synthetic arc package from temporary roots, shows unavailable bad and missing packages, fences a disabled adapter, keeps the last valid generation on a rejected update and reports that install, activation, connector creation and a rejected update dispatch no provider handler, neither a read nor a mutation. It performs no real arc install, no service restart and uses no host secret.

## Not in this contract

Credential provisioning, connection setup UI, asset HTTP delivery, live package installation or restart, provider-family migration and untrusted-code sandbox execution remain separate slices. The frame bridge that mounts a view or an editor, the host-side draft handling behind `draft:change` and `action:propose`, and the enforcement of the per-view message split remain separate slices (node #3326). The conformance harness and its publication are separate slices.
