# Desk adapter extension prototype — #3292

**Question:** can an adapter unknown to Desk supply an observation, answer a query, create a draft and render its own result using only the extension contract?

**Answer from this evidence:** yes for a local, synthetic Chromium run, with the contract revisions below. Throwaway code; nothing here belongs on main.

## Run it

```sh
bun install --frozen-lockfile
bun scripts/prototype-desk-extension.ts --fresh --port 33594
```

Open <http://127.0.0.1:33594/>. Under Adapters: Install, Restart Desk, Approve this release, Restart Desk, Connect. Then try the sentences below. All data is synthetic, with no provider, credential or account.

| Adapter | Try |
| --- | --- |
| `reading-list` | Day; `find crash`, then Load more; `Turn this into an article`, choose a shelf, Edit, Approve |
| `workshop` | `The bench drill wobbles on Bench 2.`, then `Turn this into a repair`; `find spare bearing` |
| `plant-care`, written without seeing the host | `I bought a monstera for the study.`, then `Turn this into a plant` |
| `tide-tables`, read-only, no custom view | `find spring`; `Turn this into a tide` |
| `routing`, a schema the shared editor cannot represent | `Turn this into a route` |
| `broken-*`, `duplicate-identity`, `crashing-view`, `hostile-view` | Install and restart: each is refused, or falls back to the safe rendering |

Clear a Read or Add box under Adapters to see a denied destination. Remove takes an adapter out at once and keeps saved receipts.

## How the boundary was tested

1. `59b94df`: host plus exactly one adapter package.
2. `49a3d5e`: second domain, read-only, unsupported and broken packages. `git diff 59b94df 49a3d5e -- src scripts/prototype-desk-extension.ts` is empty.
3. `13853bb`, `9f8192d`: later host changes are generic: phone layout, showing the safe rendering until a view answers, and “a/an”.
4. `plant-care` was written by an agent that could read only `AUTHORING.md` and the contract types, not the host. Its action input differs from its stored object. It ran with no host change. The fixes it found were to the guide and the items in the table below.

`bun scripts/probe-desk-extension.ts --phase all` drives the browser from fresh state; results and screenshots are in `evidence/`. Use the `*-card.png` shots for custom views: off-screen sandboxed frames do not paint in full-page captures.

## Contract changes this prototype needs

| Code | Change | Why | Affects |
| --- | --- | --- | --- |
| F1 | Add `readBindings` to the closed `desk-adapter.json` | The closed manifest has no home for the approved read binding or attention mapping, so an unknown adapter cannot reach Day or answer a query | #3321, #3328, #3331 |
| F2 | Add a `destinations` read mode and an annotation `destination` | Setup must list selectable places before any read destination exists, and destination-scoped release needs each object's place | #3324, #3328 |
| F3 | Add `display` pointers to the read binding | Without them the safe host rendering has no title for an unknown object | #3328, #3329 |
| F4 | Add `ui.views` | The host cannot otherwise tell which object types a package's UI can show | #3325, #3326 |
| F5 | `registerConnector(capabilityId, connection => connector)` | `OwnerSupport` names a connection, but module registration happens before any connection exists | #3309, #3321 |
| F6 | Stop requiring a registry handler for `action` capabilities | Actions dispatch through the connector, so every package ships a dead throwing stub. Merged registry change. | #3299 follow-up, #3309 |
| F7 | Pin the drafting field hint vocabulary: `role`, `resolveWith`, `widget` | The approved binding names field hints but not their meanings | #3318 |
| F8 | Verify manifests at install, without running code | Approval needs the release digest, and this prototype only learns it at restart, forcing an extra restart | #3321, #3324 |
| F9 | Define what `readbackCapabilityId` must point to | The blind author had to guess; the prototype never checks it | #3310 |
| F10 | Default query results to host rendering; mount a custom view for an opened object | One sandboxed frame per result item is heavy: one conversation mounted 8 | #3326, #3329 |

## Edits the real Desk still needs

None of these branches on an adapter's domain. No existing file differs from main on this branch, because the prototype runs in its own shell.

| Core seam | Edit | Evidence |
| --- | --- | --- |
| `src/surface/mc/desk/types.ts` `DESK_ITEM_KINDS` | Add `adapter` once | `tsc` then flags only `FOLDED_LABELS` and `CARD_KIND_LABELS` |
| `src/surface/mc/desk/interrupt.ts` | None | Unnamed kinds return `false`, so an adapter item cannot interrupt |
| `src/surface/mc/desk/compose.ts` | Feed the projection into Day once | Approved in #3289 D7; not exercised against real `compose` |
| `src/conversations/creation.ts` and `catalog.ts` | Leave closed; adapter drafts take the new path | `ProposalSchema.type` is `z.enum(CREATABLE_TYPES)`, so an adapter type cannot enter it |
| `src/conversations/domain-adapters/registry.ts` | F6 | Above |
| Desk shell | Catalog, asset route and frame host, once | #3325, #3326 |

## What this does not prove

Hosted delivery and authentication; browsers other than Chromium; a live model (the drafter is deterministic and crude: it truncates titles, and its summary pulled an unrelated earlier line into a saved note); durable owners (fixture owners forget objects at restart, which is how the missing-object case is shown); the token and broker path; the real `AuthorityMediator`, because dispatch is not built (#3309): this host applies simplified checks but speaks the real lifecycle wire schemas; owner-evidenced deletion; query cancellation; local-only egress; custom editors in a frame; the real `DeskView`.
