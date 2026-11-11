# Desk adapter frames

Node #3326 adds a reusable Desk frame and an inactive host integration. Production code must explicitly supply `MissionControlViews.adapterFrames` and register host-owned mounts. This change enables no production connection or owner mutation.

The shell receives a mount ID from trusted host code for an opened object, saved result or editor. It never selects a renderer during creation and never mounts a frame per listed query result. `DeskAdapterFrame` always takes the safe host rendering as its fallback. Missing assets, protocol failure, rendering errors, navigation, disable, mount removal, policy revocation and generation changes retire the frame; status and history remain host-owned. There is no automatic retry or recreation.

## Authority and protocol

`AdapterFrameHost.register` binds a principal, audience, exact adapter/connection, declared object type/view, authenticated view context, explicit read scopes, projection schema and projection source. An editor additionally binds one existing `DraftService` draft. The host owns the view release sink internally; only a successfully checked exchange response reaches the browser. A pre-existing external sink with that identity is refused.

The active authenticated asset catalog is the sole asset source. Each exchange checks its exact generation, release and UI protocol. Projection derivation and release use `AuthorityMediator.projectHostData`, with current read/release checks and explicit source/destination policy. Schema parsing supplies the released value, so stripped fields cannot escape through the original object. Local-only scopes cannot enter a cloud mount.

The closed 1.0.0 envelopes and view/editor vocabulary follow the [approved executable reference](https://github.com/the-metafactory/cortex/blob/c92e8903813ad58eb06478f97d1c6d1a1a4f776d/docs/prototypes/desk-frame-containment/protocol.ts). Unknown fields/types, invalid JSON shapes, oversize, replay, wrong identity/mount and cross-connection object navigation are terminal. A fresh instance gets one MessageChannel. Readiness has a three-second deadline; subsequent loads retire the frame. Ambient package window messages confer no authority.

`draft:change` edits the bound draft through the existing schema/relationship validators and optimistic revisions. `action:propose` requests host review of the exact revision; it neither confirms nor dispatches. The host fetches its own editor and retains the existing separate confirmation action. A cleared review cannot be restored by late fetches or pending editor actions. A complete supported generic editor may remain available through the host fallback; incomplete schemas retain their existing blocking state.

## Containment

The local shell response and the static shell HTML restrict `frame-src` to the current origin's `/api/desk/adapters/assets/` prefix. A trusted, host-generated `srcdoc` wrapper narrows each mount to its exact selected entry URL. Only static host markup and a parent-window-checked one-time port relay execute in that wrapper. Package code executes exclusively in its child with `sandbox="allow-scripts"`, no same-origin, form, popup, download or top-navigation privileges, and denied device permissions.

The wrapper addresses an additional case beyond the approved lab matrix: a package navigating to another active executable entry within the asset prefix before its first load. The original lab's pre-load case targets a remote page; its same-generation case targets CSS after projection. A prefix policy alone does not establish the loaded package identity. The per-mount exact-entry policy avoids accumulating restrictions across unrelated mounts. The package entry still comes from the separate manifest-verifying inline asset service, with hash-pinned scripts/styles, data images/fonts, no network directives, unchanged CORP and unchanged session-cookie policy. No sandbox-alone or CSP-alone no-egress claim is made.

## Verification and current limits

Run:

```sh
bun run test src/surface/mc/desk/__tests__/adapter-frame.test.ts scripts/__tests__/probe-desk-adapter-frame.test.ts src/surface/mc/desk/__tests__/adapter-assets.test.ts src/surface/mc/desk/__tests__/adapter-inline.test.ts
bun scripts/probe-desk-adapter-frame.ts
```

The browser probe uses the real shell HTML/head and frame component with a synthetic entry module, real temporary authority/package state, authenticated local/hosted handlers and hostile manifest-verified packages. External shell font links are removed to keep the probe entirely synthetic. It checks host request allowlists, attacker HTTP requests, parent/storage denial, bridge failure/fallback, draft edits, host review, revocation, and zero owner mutations. It explicitly covers another connection's executable entry before first load, wrong release/generation/connection identities, malformed and pre-ready messages, cross-connection navigation, and direct fetch. Revocation while deriving a private projection must yield fallback with zero releases. Blocked downloads retire the frame through its navigation policy and preserve the fallback. Every case, including protocol mismatch, must prove its script ran. Raw evidence defaults to `/tmp/desk-adapter-frame-evidence.json`; `DESK_FRAME_PROBE_OUTPUT` selects another local artifact path.

On 2026-11-11, the targeted 111-test run and TypeScript check passed. A regression interrupts every awaited catalog check with mount removal, session closure or expiry. The host rechecks the session after each await, including its final check before returning a projection; retirement cannot race that check and release a late fact.

The [supported-browser evidence](desk-adapter-frame-evidence.md) records 128 passed cases: 32 cases in Chromium 143.0.7499.4 and WebKit 26.0 on both local and hosted synthetic authenticated routes. Browser processes require execution outside the agent sandbox on this host. Firefox timed out at launch and is explicitly not run; no Firefox containment result is claimed. The probe fails if Chromium or WebKit cannot launch and always attempts Firefox.

The required full `bun run check` passed lint, duplication, typecheck, vocabulary, SDK, shippable hygiene, XDG and up-to-date gates. The suite reported 15,417 passed, 30 skipped, 201 todo and one failure: `src/conversations/domain-adapters/__tests__/conformance.test.ts`, “makes no network request and writes nothing outside its own temporary directory”. Its directory snapshot observes another parallel test's `desk-conformance-failure-*` directory changing. The same failure reproduced on an untouched archive of `origin/main` (`d355c765`), running only `conformance.test.ts` and `conformance-failures.test.ts` with `bun run test --parallel`: 37 passed, one failed. That baseline test is unchanged.

Accepted residuals remain WebRTC STUN/UDP in Chromium and WebKit, and WebKit preconnect TCP. The probe records them as known residuals rather than asserting they are blocked. DNS egress and real Cloudflare Access are outside this synthetic evidence. No provider account, external credential or deployment is used.
