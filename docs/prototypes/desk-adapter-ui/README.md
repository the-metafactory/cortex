# Disposable Desk adapter UI prototype

Refs #3290. This throwaway branch answers which host/render contract makes adapter-owned objects useful without losing drafts or granting authority. No option is selected or approved. Do not merge this prototype into main.

Run `bun run prototype:desk-adapter-ui` and open `http://127.0.0.1:33590/?desk=adapter-ui-prototype&variant=A`. The runner serves only synthetic fixtures, never boots Cortex or reads its configuration, and uses an in-memory draft store. Closing/reloading the page resets it. A floating switcher changes `variant=A`, `B`, or `C` without discarding current edits.

| Variant | Question |
| --- | --- |
| A — Object workspace | Does a persistent adapter rail and object inspector make domain boundaries clear? |
| B — Conversation workbench | Should the originating discussion remain alongside every view/editor? |
| C — Review journey | Does a visible six-step journey clarify the transition from inspection to a host-owned proposal? |

Choose Work graph or Balance and either the host schema fallback or isolated custom module. Summary, detail, editor, selected-scope query result, proposed action and saved receipt share one host model. Edit a field, switch adapter/view/variant and return: the dirty draft remains. Empty a required title and request review: host validation blocks it. Only the host's explicit confirmation increments the synthetic owner counter. Saved results are adapter-scoped; reopening does not repeat that call. No real object exists.

The custom module runs inside a real `sandbox="allow-scripts"` frame without same-origin privilege, receives a data-free bootstrap and host-created MessageChannel, then a synthetic projection only after the matched ready handshake, and proposes candidate `draft:change`, `host:navigate` and `action:propose` events. It has no execute/confirm event. Host validation closes a mismatched generation, unknown/inherited event, array or malformed cyclic/BigInt payload and retains the draft in the schema fallback. Remount creates a fresh bridge instance. Loading, unavailable, renderer failure, light/dark host theme and mobile layouts are inspectable.

## Browser evidence

`probe.json` records the browser version, cases, final visible state and local receiver traffic. Desktop and 390px mobile captures exist for all variants, plus custom Balance and fallback captures. The probe uses a staged Chromium executable with a temporary HOME/profile. To repeat, copy an installed Playwright Chromium headless-shell bundle into a temporary tool directory, then run:

```sh
bun --no-env-file scripts/probe-desk-adapter-ui.ts --browser /tmp/cortex-3290-browser/chrome-headless-shell --out /tmp/cortex-3290-browser-evidence
```

The receiver at localhost port33591 deliberately allows an uncredentialed response; the browser boundary, not a Playwright route abort or CORS, must prevent delivery. Fetch/image CSP violations were observed; parent DOM and worker construction were denied by opaque-origin rules. Self-navigation is constrained by parent frame-source policy. The receiver saw zero requests. Suppressed-ready draft/proposal/navigation attacks left the host unchanged; the initial packet contained no projected fields and repeated-ready events closed the bridge. Ambient frame messages did not become authority. Wrong-generation/unknown/constructor/__proto__/toString/array/cyclic/BigInt events and renderer failures closed the bridge. The explicit synthetic save happened once; external owner calls remained zero.

## Limits and decision still needed

This is Chromium-only evidence against two local synthetic origins. It is not a general no-egress proof, a supported-browser matrix, an authenticated hosted gateway test or a production credential/policy implementation. No real protected data is admitted. The proposed event vocabulary uses `1.0.0-prototype`; it does not claim compatibility with an approved production UI protocol. Actual asset integrity, authenticated delivery, bounded registry schemas, durable drafts, real source restrictions and current-policy admission belong to their blocked build nodes.

The principal must choose the host/render contract from this prototype before node3290 closes. That decision unlocks the separate conversation-prefilled graph/Balance prototype3291. The parent agent owns review, tracker notes and gated closure; this branch preserves the primary source.
