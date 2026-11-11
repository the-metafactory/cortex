# Desk adapter frame browser evidence

Observed 2026-11-11 with Playwright 1.57.0 on macOS, invoking `bun scripts/probe-desk-adapter-frame.ts` outside the execution sandbox so browser processes can launch. No VM, container, provider account, external credential or production activation was used.

128 cases passed: 32 cases × Chromium 143.0.7499.4 and WebKit 26.0 × local and hosted synthetic authenticated routes. The hosted route checks its session cookie and injects a synthetic verified access assertion; it is served over loopback HTTP, not real Cloudflare Access or an HTTPS origin.

Every passed case asserts script execution, zero attacker HTTP requests, zero popups/downloads, an unchanged parent DOM, zero domain-service dispatch/cancel calls, no shell confirmation request and a shell request allowlist. Matching UI also proves denial of both ancestor documents and frame storage, then fallback after revocation. Editor proposal checks late shell review responses cannot restore revoked review.

Worker cases require explicit denial reports and reject execution/registration success reports. The worker script would call `postMessage` before attempting network access, so blocked HTTP alone cannot hide worker execution. Both Chromium and WebKit reported worker and service-worker denial on both routes.

The late-revoke, before-load, mismatch, throw and before-ready cases each produced zero released projections in every browser/route. Navigation and terminal protocol failures removed the frame and retained visible shell history. The download case expects safe fallback after its blocked navigation.

| Case | Chromium local | Chromium hosted | WebKit local | WebKit hosted |
| --- | --- | --- | --- | --- |
| good | passed | passed | passed | passed |
| editor-change | passed | passed | passed | passed |
| editor-propose | passed | passed | passed | passed |
| late-revoke | passed | passed | passed | passed |
| mismatch | passed | passed | passed | passed |
| throw | passed | passed | passed | passed |
| forged | passed | passed | passed | passed |
| replay | passed | passed | passed | passed |
| wrong-release | passed | passed | passed | passed |
| wrong-generation | passed | passed | passed | passed |
| wrong-connection | passed | passed | passed | passed |
| unknown-field | passed | passed | passed | passed |
| before-ready | passed | passed | passed | passed |
| cross-connection | passed | passed | passed | passed |
| ambient | passed | passed | passed | passed |
| navigate | passed | passed | passed | passed |
| before-load | passed | passed | passed | passed |
| remote | passed | passed | passed | passed |
| `data` | passed | passed | passed | passed |
| blob | passed | passed | passed | passed |
| redirect | passed | passed | passed | passed |
| fetch | passed | passed | passed | passed |
| image | passed | passed | passed | passed |
| font | passed | passed | passed | passed |
| style | passed | passed | passed | passed |
| worker | passed | passed | passed | passed |
| service-worker | passed | passed | passed | passed |
| parent | passed | passed | passed | passed |
| form | passed | passed | passed | passed |
| popup | passed | passed | passed | passed |
| download | passed | passed | passed | passed |
| top | passed | passed | passed | passed |

Firefox: NOT EXECUTED. Playwright Firefox 144.0.2 timed out at launch after 10 seconds. No Firefox containment result is claimed. The probe continues to attempt Firefox on every invocation and fails if Chromium or WebKit cannot launch.

Known accepted residuals: WebRTC STUN/UDP in Chromium and WebKit, and WebKit preconnect TCP. This probe records those channels as residuals and does not assert they are blocked. DNS egress and real Cloudflare Access remain outside this evidence.

Raw evidence is written locally to `/tmp/desk-adapter-frame-evidence.json` (or `DESK_FRAME_PROBE_OUTPUT`). Its SHA-256 for this invocation:

`f7fa3e6457f1f054bb28f293a5f8dc9afccbf37f72988c6e45d3afc143a3cc61`

Source SHA-256 values for the measured implementation:

| Source | SHA-256 |
| --- | --- |
| scripts/probe-desk-adapter-frame.ts | 5f5080a7a68d6f689d5b9a6bf4417d52aad6a2a5486291e6a63a2d0ffeab9af8 |
| src/surface/mc/desk/__tests__/fixtures/adapter-frame-ui.ts | b6044df02ecd19577d5258bcbc768b7ba20e800fa8c8b592fb64e614a3b9e046 |
| src/surface/mc/desk/adapter-frame-host.ts <!-- glossary-ignore: host --> | c8832f5618d5f52253ede6d441a6f95dcf5ce24b11633a27a0f8d16f8b0a4ecc |
| src/surface/mc/dashboard-v2/lib/desk-adapter-frame.ts | 053e6aeb2e7341d7ec900f54a479326e6773ce1a37abcc00dd3821151bdbe7a1 |
| src/surface/mc/desk/adapter-frame-protocol.ts | 24cdbaea4cb965a59fcc7099b9116cd0507bf1deba01513f08b30730220ec433 |
