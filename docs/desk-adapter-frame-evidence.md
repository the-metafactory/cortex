# Desk adapter frame browser evidence

Observed 2026-11-11 with Playwright 1.57.0 on the host, running `bun scripts/probe-desk-adapter-frame.ts` outside the execution sandbox so browser processes can launch. No VM, container, provider account, external credential or deployment was used.

128 cases passed: 32 cases × Chromium 143.0.7499.4 and WebKit 26.0 × local and hosted synthetic authenticated routes. The hosted route checks its session cookie and injects a synthetic verified access assertion; it is served over loopback HTTP, not real Cloudflare Access or an HTTPS deployment.

Every passed case asserts script execution, zero attacker HTTP requests, zero popups/downloads, an unchanged parent DOM, zero owner dispatch/cancel calls, no host confirmation request and a host request allowlist. Matching UI also proves denial of both ancestor documents and frame storage, then fallback after revocation. Editor proposal checks late host review responses cannot restore revoked review.

Worker cases require explicit denial reports and reject execution/registration success reports. The worker script would post a message before attempting network access, so blocked HTTP alone cannot hide worker execution. Both Chromium and WebKit reported worker and service-worker denial on both routes.

The late-revoke, before-load, mismatch, throw and before-ready cases each produced zero released projections in every browser/route. Navigation and terminal protocol failures removed the frame and retained visible host history. The download case expects safe fallback after its blocked navigation.

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
| data | passed | passed | passed | passed |
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

Firefox: NOT RUN. Playwright Firefox 144.0.2 timed out at launch after 10 seconds. No Firefox containment result is claimed. The probe continues to attempt Firefox on every run and fails if Chromium or WebKit cannot launch.

Known accepted residuals: WebRTC STUN/UDP in Chromium and WebKit, and WebKit preconnect TCP. This probe records those channels as residuals and does not assert they are blocked. DNS egress and real Cloudflare Access remain outside this evidence.

Raw evidence is written locally to `/tmp/desk-adapter-frame-evidence.json` (or `DESK_FRAME_PROBE_OUTPUT`). Its SHA-256 for this run:

`1a47445edf4d2d4868167979cf833c774cf8780f7844265154e98c4c127f0abc`

Source SHA-256 values for the measured implementation:

| Source | SHA-256 |
| --- | --- |
| scripts/probe-desk-adapter-frame.ts | 3069e63285f8a5966a908a3760144064587edd5b8ef4482aa8fdd90eb2513fd0 |
| src/surface/mc/desk/__tests__/fixtures/adapter-frame-ui.ts | f533ac3dccd56e75cd42a07fe93eb32f754411bd9e9b12c89cd85a86bfe08195 |
| src/surface/mc/desk/adapter-frame-host.ts | 8972625908c694615f54af0dd5a0aaac9c37865526b4c85413d983391df0b9d9 |
| src/surface/mc/dashboard-v2/lib/desk-adapter-frame.ts | 9a47a02b2da82e0b9bfeb6296fba46f41f3e58c0bcf272404985a0e3cf7f7f62 |
