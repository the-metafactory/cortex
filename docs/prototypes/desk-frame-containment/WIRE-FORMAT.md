# Desk UI wire format 1.0.0 — proposal

Executable form: [`protocol.ts`](protocol.ts). The lab shell enforces exactly this module in every browser run, and `scripts/probe-desk-frame-containment.ts` checks it directly (section "Protocol checks" in [`evidence/matrix.md`](evidence/matrix.md)).

## Envelope

Every message in either direction is one closed object:

| Field | Type | Rule |
| --- | --- | --- |
| `protocol` | `"desk-ui"` | literal |
| `version` | `"1.0.0"` | literal, equal to the package `ui.protocolVersion` and `DESK_UI_PROTOCOL_VERSION`; `1.0.0-prototype` is refused |
| `instance` | 32 lowercase hex | host-generated per mount, never reused |
| `adapterId`, `connectionId`, `generationId`, `releaseDigest` | catalog identity | must equal the mounted catalog entry exactly |
| `seq` | integer ≥ 1 | strictly increasing per direction |
| `type` | one of the names below | closed set |
| `body` | per type | closed object (`strict`) |

Unknown fields at either level, unknown types, wrong identity, a repeated or lower `seq`, a non-plain value (Map, Date, class instance, own `__proto__` key, non-finite number), or a message over 64 KiB serialized close the bridge and the frame. A violation is terminal; there is no error reply the frame could probe with.

## Transport

1. The host creates the frame from the active catalog entry, then on the frame's **first** `load` posts `host:init` with `port2` of a fresh `MessageChannel` to `frame.contentWindow` with target origin `"*"` (the frame's origin is opaque, so no narrower target exists; containment of what the frame can have navigated to is the CSP's job, see the matrix).
2. Every later message travels on that port only. The host ignores all `window` messages; an ambient message, a second port or a forged init confers nothing.
3. A second `load` event means the frame navigated: the host closes the bridge and removes the frame.
4. No `ui:ready` within 3 s closes the bridge.

## Messages

Sender prefix rule: `host:` comes from the host; `ui:`, `draft:` and `action:` come from the frame. This renames the prototype candidate `host:navigate` (a frame request) to `ui:navigate`.

Host → frame

| Type | Body | Meaning |
| --- | --- | --- |
| `host:init` | `{ mount: { objectType, view: "result" \| "editor" } }` | carries the port; sent once |
| `host:theme` | `{ scheme, reducedMotion, locale }` | presentation only |
| `host:projection` | `{ projectionId, revision, object }` | the current authorized projection; `object` is JSON validated by the host against the declared schema before sending |
| `host:draft` | `{ draftId, revision, values: { pointer: json }, blocking: Blocking[] }` | editor mounts only; the host-owned draft state |
| `host:reply` | `{ replyTo, outcome: accepted \| rejected \| stale, code? }` | answer to a frame request |
| `host:close` | `{ reason }` | `navigation`, `disabled`, `generation_changed`, `connection_changed`, `unmounted`, `protocol_violation` |

Frame → host

| Type | Body | Allowed in | Meaning |
| --- | --- | --- | --- |
| `ui:ready` | `{ mount }` | once, first | must echo the init mount exactly |
| `ui:resize` | `{ height: 0..4000 }` | result, editor | layout hint |
| `ui:error` | `{ code: render_failed \| unsupported_projection \| internal }` | result, editor | host shows its safe rendering; no free text crosses |
| `ui:navigate` | `{ target: { kind: "object", ref: ObjectReference } \| { kind: "draft", draftId } }` | result, editor | a request; the host navigates inside Desk, never to a URL. A `ref` naming another adapter or connection is a violation |
| `draft:change` | `{ draftId, baseRevision, changes: [{ pointer, change: EditChange }] (1..64) }` | editor | `EditChange` is the drafting contract's `set` / `null` / `omit`; the host validates and revises the draft, then replies |
| `action:propose` | `{ draftId, revision }` | editor | asks the host to show **its own** confirmation for that exact revision. It never approves, executes or names a capability |

## How it meets the approved contracts

- **Package contract** (`DeskAdapterUiSchema`, #3288 D2/D5): `ui.protocolVersion` is the literal `1.0.0` this format carries. The package's `ui.views[].view` currently accepts only `result`, so an `editor` mount is not declarable yet (the probe records this as `false`). Decision D3 below.
- **Authority contract** (#3288 D5, #3290): confirmation and execution stay host-owned. No frame message carries a grant, credential, URL, capability id or callback; `action:propose` can only open the host's confirmation, and the host rechecks read/release and effect admission before replying or acting. Identity binds every message to one adapter, connection, generation and release, so a cached frame of generation A cannot talk to backend B.
- **Drafting contract**: `draft:change` reuses `EditChange` and JSON-pointer field addressing; `host:draft.blocking` reuses `Blocking`.

## Open decisions for the principal

- **D2** Rename `host:navigate` to `ui:navigate` under the sender-prefix rule (proposed), or keep the prototype name.
- **D3** Editor views: widen the package `ui.views[].view` to `result | editor` before the Desk SDK 1.0.0 release, so 1.0.0 covers editors (proposed); or ship 1.0.0 result-only and add `editor` with `draft:change` / `action:propose` in 1.1.0.
