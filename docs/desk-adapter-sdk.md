# Desk adapter package and SDK authoring contract

This is the initial authoring contract for a Desk adapter package. It describes the `desk-adapter-package/1` manifest, the separately versioned Desk adapter SDK 1.0.0, and how the host discovers, approves and activates a generation. The loader lives in `src/conversations/domain-adapters/package.ts`; the SDK barrel is `src/desk-sdk/index.ts` (`DESK_ADAPTER_SDK_VERSION = "1.0.0"`).

The Desk adapter SDK is distinct from the surface plugin SDK. `SURFACE_SDK_VERSION` is unchanged: no existing surface export changes here. A Desk adapter is not a surface transport plugin, and a `cortex-plugin.yaml` is never reinterpreted as a Desk package manifest.

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
- `ui` is optional. Its `protocolVersion` is exactly `1.0.0`; `entry` must be one listed file and must be HTML; `views` lists the object types whose result view the host may mount; `files` lists unique package-relative assets with an allowed media type and exact digest. No remote URL, import map, service worker or path outside the package is accepted.
- Manifest and every listed file are realpath-contained in the verified package directory. Traversal, absolute paths, symlinked entries and symlinked manifests fail closed. Deterministic host bounds apply to the manifest, file count and file size.

Host bounds: 512 KiB manifest, 256 asset files, 8 MiB per file. These are fixed in `package.ts`; a package cannot raise them.

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

## Discovery, approval and activation

The host supplies:

- bundled package directories;
- approved package roots plus an arc inventory runner (production defaults to `arc list --json` reading the configured arc package-repos directory);
- principal approvals `{ packageId, origin, packageVersion, releaseDigest }` for installed packages;
- the configured surface-plugin signing posture and trust root, which are reused as-is. No Desk-specific allowlist, exemption or flag is added;
- the durable generation store from the conversation host.

`discover()` reads and verifies manifests, identity uniqueness, version compatibility, setup documents, bindings, file digests, containment, trust and signatures. It does not import a backend. `install(packageId)` reports `{ packageId, packageVersion, adapterId, origin, releaseDigest }` without importing, so the principal can approve that exact release without a restart. A refused package reports its code immediately.

`activate(packageId, { releaseDigest })` is the managed activation step. It re-verifies the release, imports the verified backend, validates the returned declaration and connectors, composes a complete new registry snapshot, persists the selected generation, and swaps the snapshot atomically. Installation alone never restarts a service; Approve and Remove trigger the managed activation, which is outside this loader.

The release digest covers the canonical verified manifest, backend and asset identities, declaration, drafting and read bindings and setup descriptor. The durable store keeps `active`, `lastValid` and a bounded history per adapter. A rejected staged update leaves both unchanged.

## Availability, disable and uninstall

- Missing, throwing or incompatible modules are visibly unavailable. Nothing from that adapter is partially published.
- `catalog()` lists only available generations with their package generation, declaration, read bindings, drafting bindings, UI descriptor and availability.
- `disable(adapterId)` immediately fences logical admission and removes the adapter from the catalog; the in-process registration stays until a managed restart.
- `uninstall(adapterId)` does the same and marks the durable record uninstalled. Package files and stored drafts, receipts and schema pins are retained. It deletes no credential, remote object or user data.
- `boot()` applies durable fences at a managed restart. Fenced generations are not published.
- `admit(adapterId, { releaseDigest })` returns `available`, `unavailable` or `upgrade_required`. A stored generation that does not match the active one is never downconverted. The caller must reopen it with the matching generation.

## Verification

The synthetic tests are `src/conversations/domain-adapters/__tests__/package-loader.test.ts`. They use temporary package roots, a fake arc inventory and a real temporary host store.

The standalone demonstration is:

```sh
bun scripts/probe-desk-adapter-packages.ts
```

It loads a bundled default and an explicitly approved synthetic arc package from temporary roots, shows unavailable bad and missing packages, fences a disabled adapter, keeps the last valid generation on a rejected update and reports zero provider mutation calls. It performs no real arc install, no service restart and uses no host secret.

## Not in this contract

Credential provisioning, connection setup UI, asset HTTP delivery, the frame bridge, live package installation or restart, provider-family migration and untrusted-code sandbox execution remain separate slices. The exact view and editor vocabulary remains the approved UI prototype's decision. Unresolved query and observation behavior stays unavailable until its own decision closes.
