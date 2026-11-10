# Desk adapter frame containment — prototype for node #3463

Throwaway lab; nothing here belongs on main. It settles the two prerequisites of the frame build #3326: does a combined containment mechanism hold in supported browsers on local and hosted synthetic authenticated routes, and what is the exact UI wire format 1.0.0.

## Run it

```sh
bun install --frozen-lockfile
bun x playwright install webkit firefox
bun scripts/prototype-desk-frame-containment.ts                          # browsable lab at http://127.0.0.1:33610/
bun scripts/probe-desk-frame-containment.ts --browsers=chromium,webkit   # ~5 min, writes evidence/
```

The lab serves the **real** merged asset handler (`handleDeskAdapterAssets`, #3325) and package loader through two routes:

- **local**: `http://127.0.0.1`, loopback principal, as the daemon serves Desk.
- **hosted**: `https://localhost` behind a synthetic gateway that requires a `CF_Authorization` session cookie, redirects unauthenticated requests to a login origin, and injects the access assertion the guard verifies.

A hostile package UI (`package-ui/attack.js`) runs one of 82 attacks per frame load. Ground truth is external: an attacker receiver (HTTP/TLS, raw TCP, UDP) that logs every request and connection, the host request log, Playwright popup/download/navigation events, the parent DOM, and the shell's bridge log. Every projection carries a random canary, so a leak is proven by the canary arriving at the attacker. An attack whose script never ran is reported `n/r`, never as contained.

Four variants per route:

| Variant | Frame | Asset response | Shell |
| --- | --- | --- | --- |
| open | no sandbox | no CSP, no CORP | no CSP. **Control**: proves each attack lands when uncontained |
| merged | `sandbox="allow-scripts"` | exactly the #3325 headers | no CSP (as the dashboard today) |
| combined | `sandbox="allow-scripts"` | CSP scoped to the generation path, `sandbox allow-scripts`, CORP `cross-origin`; hosted cookie `SameSite=None` | CSP `frame-src` limited to the asset prefix |
| inline | `sandbox="allow-scripts"` | the host inlines the generation into one document: scripts and styles pinned by `sha256` CSP hashes, images and fonts as `data:`, every network directive `'none'` | as combined |

All variants use the same bridge: per-instance `MessageChannel`, the closed gate in [`protocol.ts`](protocol.ts), teardown on a second frame `load`, 3 s handshake timeout.

## Result (Chromium 143, WebKit 26; 1,248 runs)

Full matrix: [`evidence/matrix.md`](evidence/matrix.md); raw: [`evidence/results.json`](evidence/results.json).

| | open | merged | combined | inline |
| --- | --- | --- | --- | --- |
| Positive controls (view, editor, assets) | pass | **fail**: adapter script never runs | pass | pass |
| Attacks landed (per browser × route) | 49–51 of 79 | 0, but 74 never ran | 1 (Chromium) / 2 (WebKit) | 1 (Chromium) / 2 (WebKit) |

Findings:

- **F1 — merged #3325 delivery cannot host a sandboxed frame.** The entry HTML loads, but every subresource from the opaque-origin frame fails: locally `Cross-Origin-Resource-Policy: same-origin` blocks it; hosted, the `SameSite=Lax` session cookie is not sent from an opaque-origin frame, so the gateway redirects to login. It fails closed, but no adapter UI can work as shipped.
- **F2 — combined and inline contain every DOM, storage, HTTP egress, worker, navigation, top-window, popup, form, download and message attack in both browsers on both routes**, including the attack where the frame navigates away before its first load to steal the host's port and projection (it lands in the open control).
- **F3 — WebRTC is not containable with these primitives.** `RTCPeerConnection` with an attacker STUN server sent UDP to the attacker from the sandboxed frame in every combined and inline cell, both browsers, both routes. CSP has no WebRTC control the browsers enforce. Payload capacity was not measured; the attacker chooses host and port, and a hostname is a DNS channel.
- **F4 — WebKit opens a bare TCP connection for `<link rel=preconnect>`** despite `default-src 'none'`. No request bytes; the hostname choice is again a DNS channel.
- **F5 — combined needs two global weakenings**: the hosted session cookie must be `SameSite=None` (sent on every cross-site request to the whole dashboard), and CORP must be relaxed. Even then package **fonts and module scripts fail**: their CORS-mode requests carry `Origin: null`, which the mutation guard refuses (403 locally, 302 hosted).
- **F6 — inline needs neither weakening**, makes no network request from the frame at all, and keeps the `Lax` cookie. Its cost: the host must inline the generation (scripts, styles, `url()`/`<img>` assets); asset URLs built at runtime in JavaScript and module scripts do not work.
- **F7 — wire format 1.0.0** ([`WIRE-FORMAT.md`](WIRE-FORMAT.md)) rejected every forged, malformed, replayed, oversized, mis-identified, pre-ready, wrong-view and cross-connection message by closing the bridge, and ignored every ambient window message, in both browsers. The package contract accepts its `1.0.0` result view; it does **not** accept an editor view yet.

## What this does not prove

- **Firefox**: Playwright's Firefox build hangs at launch on this host (headless and headed); no run. The repository names no supported-browser list.
- Rows the open control could not land, so containment there is not evidence: Chromium `preconnect`, WebKit `prefetch` (unsupported), Chromium hosted `service-worker` and `shared-worker` (refused even uncontained under the lab's self-signed TLS).
- DNS-based egress (`dns-prefetch`, WebRTC/TURN hostnames) is not observable in this lab.
- Real Cloudflare Access, a real `DeskView`, production frame hosting (#3326).
