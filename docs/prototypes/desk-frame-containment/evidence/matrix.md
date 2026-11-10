# Frame containment matrix

Browsers: chromium 143.0.7499.4, webkit 26.0. ✓ contained, **✗** breached, n/r adapter script never ran (so the row proves nothing), pass/FAIL for positive controls. Columns: browser / route / variant (open = uncontained control, merged = production headers from #3325, combined = generation-scoped CSP over network assets, inline = host-inlined single document).

| attack | ch l open | ch l mrg | ch l cmb | ch l inl | ch h open | ch h mrg | ch h cmb | ch h inl | we l open | we l mrg | we l cmb | we l inl | we h open | we h mrg | we h cmb | we h inl |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| benign-result | pass | **FAIL** | pass | pass | pass | **FAIL** | pass | pass | pass | **FAIL** | pass | pass | pass | **FAIL** | pass | pass |
| benign-editor | pass | **FAIL** | pass | pass | pass | **FAIL** | pass | pass | pass | **FAIL** | pass | pass | pass | **FAIL** | pass | pass |
| legit-assets | pass | **FAIL** | pass | pass | pass | **FAIL** | pass | pass | pass | **FAIL** | pass | pass | pass | **FAIL** | pass | pass |
| parent-dom-read | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| parent-dom-write | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| top-dom-read | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| parent-location-read | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| storage-local | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| storage-session | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| storage-cookie | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| storage-indexeddb | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| storage-cache | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| fetch-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| fetch-host-api | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| xhr-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| websocket-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| eventsource-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| beacon-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| image-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| image-host-api | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| image-gateway-redirect | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| style-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| style-attr-beacon | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| css-import | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| font-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| prefetch | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| preconnect | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | **✗** | n/r | **✗** | **✗** | **✗** | n/r | **✗** | **✗** |
| media-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| object-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| nested-frame | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| script-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| import-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| anchor-ping | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| webrtc-stun | **✗** | n/r | **✗** | **✗** | **✗** | n/r | **✗** | **✗** | **✗** | n/r | **✗** | **✗** | **✗** | n/r | **✗** | **✗** |
| worker-same | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| worker-blob | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| worker-data | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| shared-worker | **✗** | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| service-worker | **✗** | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| nav-before-load | **✗** | ✓ | ✓ | ✓ | **✗** | ✓ | ✓ | ✓ | **✗** | ✓ | ✓ | ✓ | **✗** | ✓ | ✓ | ✓ |
| nav-remote | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| nav-data | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| nav-blob | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| nav-javascript | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| nav-redirect | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| nav-gateway-redirect | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| nav-same-generation | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| nav-host-page | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| meta-refresh | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| anchor-click | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| top-nav | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| top-nav-link | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| popup | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| popup-link | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| form-post | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| form-top | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| download-asset | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| download-blob | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ | **✗** | n/r | ✓ | ✓ |
| msg-ambient-parent | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-ambient-top | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-second-port | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-unknown-type | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-extra-field | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-extra-envelope | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-wrong-instance | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-wrong-release | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-wrong-generation | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-wrong-connection | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-wrong-version | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-replay | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-oversized | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-malformed | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-non-plain | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-proto-key | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-before-ready | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-editor-only | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-cross-connection | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |
| msg-after-close | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ | ✓ | n/r | ✓ | ✓ |

## Breaches and failures outside the open control

- chromium local merged `benign-result`: ready=false accepted= closed=handshake_timeout
- chromium local merged `benign-editor`: accepted= closed=handshake_timeout
- chromium local merged `legit-assets`: ready=false css=not run app.js=200 image=?/200 font=no request module=not run/no request
- chromium local merged `parent-dom-read`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `parent-dom-write`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `top-dom-read`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `parent-location-read`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local merged `storage-local`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `storage-session`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `storage-cookie`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `storage-indexeddb`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `storage-cache`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `fetch-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `fetch-host-api`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `xhr-remote`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local merged `websocket-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `eventsource-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `beacon-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `image-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `image-host-api`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `image-gateway-redirect`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `style-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `style-attr-beacon`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local merged `css-import`: adapter script never ran: app.html 200, pixel.png 200, attack.js 200, app.css 200
- chromium local merged `font-remote`: adapter script never ran: app.html 200, app.css 200, pixel.png 200, attack.js 200
- chromium local merged `prefetch`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `preconnect`: adapter script never ran: app.html 200, app.css 200, pixel.png 200, attack.js 200
- chromium local merged `media-remote`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local merged `object-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `nested-frame`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local merged `script-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `import-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `anchor-ping`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `webrtc-stun`: adapter script never ran: app.html 200, attack.js 200, pixel.png 200, app.css 200
- chromium local merged `worker-same`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `worker-blob`: adapter script never ran: app.html 200, app.css 200, pixel.png 200, attack.js 200
- chromium local merged `worker-data`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `shared-worker`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local merged `service-worker`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `nav-remote`: adapter script never ran: app.html 200, app.css 200, pixel.png 200, attack.js 200
- chromium local merged `nav-data`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `nav-blob`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local merged `nav-javascript`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `nav-redirect`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `nav-gateway-redirect`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `nav-same-generation`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local merged `nav-host-page`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `meta-refresh`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `anchor-click`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `top-nav`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `top-nav-link`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local merged `popup`: adapter script never ran: app.html 200, attack.js 200, pixel.png 200, app.css 200
- chromium local merged `popup-link`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `form-post`: adapter script never ran: app.html 200, app.css 200, pixel.png 200, attack.js 200
- chromium local merged `form-top`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local merged `download-asset`: adapter script never ran: app.html 200, pixel.png 200, app.css 200, attack.js 200
- chromium local merged `download-blob`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-ambient-parent`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-ambient-top`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-second-port`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-unknown-type`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-extra-field`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-extra-envelope`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-wrong-instance`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-wrong-release`: adapter script never ran: app.html 200, app.css 200, pixel.png 200, attack.js 200
- chromium local merged `msg-wrong-generation`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-wrong-connection`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-wrong-version`: adapter script never ran: app.html 200, app.css 200, pixel.png 200, attack.js 200
- chromium local merged `msg-replay`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-oversized`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-malformed`: adapter script never ran: app.html 200, app.css 200, pixel.png 200, attack.js 200
- chromium local merged `msg-non-plain`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-proto-key`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-before-ready`: adapter script never ran: app.html 200, app.css 200, pixel.png 200, attack.js 200
- chromium local merged `msg-editor-only`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-cross-connection`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- chromium local merged `msg-after-close`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- chromium local combined `webrtc-stun`: 4 STUN/UDP packet(s) to attacker
- chromium local inline `webrtc-stun`: 4 STUN/UDP packet(s) to attacker
- chromium hosted merged `benign-result`: ready=false accepted= closed=handshake_timeout
- chromium hosted merged `benign-editor`: accepted= closed=handshake_timeout
- chromium hosted merged `legit-assets`: ready=false css=not run app.js=302 image=?/302 font=no request module=not run/no request
- chromium hosted merged `parent-dom-read`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `parent-dom-write`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `top-dom-read`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `parent-location-read`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `storage-local`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `storage-session`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `storage-cookie`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `storage-indexeddb`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `storage-cache`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302, pixel.png 302
- chromium hosted merged `fetch-remote`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `fetch-host-api`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `xhr-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `websocket-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `eventsource-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `beacon-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `image-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `image-host-api`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `image-gateway-redirect`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `style-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `style-attr-beacon`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `css-import`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `font-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `prefetch`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `preconnect`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `media-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `object-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `nested-frame`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `script-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `import-remote`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `anchor-ping`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `webrtc-stun`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `worker-same`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `worker-blob`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `worker-data`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `shared-worker`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `service-worker`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `nav-remote`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `nav-data`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `nav-blob`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `nav-javascript`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `nav-redirect`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `nav-gateway-redirect`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `nav-same-generation`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `nav-host-page`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `meta-refresh`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `anchor-click`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `top-nav`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `top-nav-link`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `popup`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `popup-link`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `form-post`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `form-top`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `download-asset`: adapter script never ran: app.html 200, app.css 302, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `download-blob`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-ambient-parent`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-ambient-top`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-second-port`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-unknown-type`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-extra-field`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-extra-envelope`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-wrong-instance`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-wrong-release`: adapter script never ran: app.html 200, app.css 302, pixel.png 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-wrong-generation`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-wrong-connection`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-wrong-version`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-replay`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-oversized`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-malformed`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-non-plain`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-proto-key`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-before-ready`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-editor-only`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-cross-connection`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted merged `msg-after-close`: adapter script never ran: app.html 200, app.css 302, attack.js 302, pixel.png 302
- chromium hosted combined `webrtc-stun`: 4 STUN/UDP packet(s) to attacker
- chromium hosted inline `webrtc-stun`: 4 STUN/UDP packet(s) to attacker
- webkit local merged `benign-result`: ready=false accepted= closed=handshake_timeout
- webkit local merged `benign-editor`: accepted= closed=handshake_timeout
- webkit local merged `legit-assets`: ready=false css=not run app.js=no request image=?/no request font=no request module=not run/no request
- webkit local merged `parent-dom-read`: adapter script never ran: app.html 200
- webkit local merged `parent-dom-write`: adapter script never ran: app.html 200
- webkit local merged `top-dom-read`: adapter script never ran: app.html 200
- webkit local merged `parent-location-read`: adapter script never ran: app.html 200
- webkit local merged `storage-local`: adapter script never ran: app.html 200
- webkit local merged `storage-session`: adapter script never ran: app.html 200
- webkit local merged `storage-cookie`: adapter script never ran: app.html 200
- webkit local merged `storage-indexeddb`: adapter script never ran: app.html 200
- webkit local merged `storage-cache`: adapter script never ran: app.html 200
- webkit local merged `fetch-remote`: adapter script never ran: app.html 200
- webkit local merged `fetch-host-api`: adapter script never ran: app.html 200
- webkit local merged `xhr-remote`: adapter script never ran: app.html 200
- webkit local merged `websocket-remote`: adapter script never ran: app.html 200
- webkit local merged `eventsource-remote`: adapter script never ran: app.html 200
- webkit local merged `beacon-remote`: adapter script never ran: app.html 200
- webkit local merged `image-remote`: adapter script never ran: app.html 200
- webkit local merged `image-host-api`: adapter script never ran: app.html 200
- webkit local merged `image-gateway-redirect`: adapter script never ran: app.html 200
- webkit local merged `style-remote`: adapter script never ran: app.html 200
- webkit local merged `style-attr-beacon`: adapter script never ran: app.html 200
- webkit local merged `css-import`: adapter script never ran: app.html 200
- webkit local merged `font-remote`: adapter script never ran: app.html 200
- webkit local merged `prefetch`: adapter script never ran: app.html 200
- webkit local merged `preconnect`: adapter script never ran: app.html 200
- webkit local merged `media-remote`: adapter script never ran: app.html 200
- webkit local merged `object-remote`: adapter script never ran: app.html 200
- webkit local merged `nested-frame`: adapter script never ran: app.html 200
- webkit local merged `script-remote`: adapter script never ran: app.html 200
- webkit local merged `import-remote`: adapter script never ran: app.html 200
- webkit local merged `anchor-ping`: adapter script never ran: app.html 200
- webkit local merged `webrtc-stun`: adapter script never ran: app.html 200
- webkit local merged `worker-same`: adapter script never ran: app.html 200
- webkit local merged `worker-blob`: adapter script never ran: app.html 200
- webkit local merged `worker-data`: adapter script never ran: app.html 200
- webkit local merged `shared-worker`: adapter script never ran: app.html 200
- webkit local merged `service-worker`: adapter script never ran: app.html 200
- webkit local merged `nav-remote`: adapter script never ran: app.html 200
- webkit local merged `nav-data`: adapter script never ran: app.html 200
- webkit local merged `nav-blob`: adapter script never ran: app.html 200
- webkit local merged `nav-javascript`: adapter script never ran: app.html 200
- webkit local merged `nav-redirect`: adapter script never ran: app.html 200
- webkit local merged `nav-gateway-redirect`: adapter script never ran: app.html 200
- webkit local merged `nav-same-generation`: adapter script never ran: app.html 200
- webkit local merged `nav-host-page`: adapter script never ran: app.html 200
- webkit local merged `meta-refresh`: adapter script never ran: app.html 200
- webkit local merged `anchor-click`: adapter script never ran: app.html 200
- webkit local merged `top-nav`: adapter script never ran: app.html 200
- webkit local merged `top-nav-link`: adapter script never ran: app.html 200
- webkit local merged `popup`: adapter script never ran: app.html 200
- webkit local merged `popup-link`: adapter script never ran: app.html 200
- webkit local merged `form-post`: adapter script never ran: app.html 200
- webkit local merged `form-top`: adapter script never ran: app.html 200
- webkit local merged `download-asset`: adapter script never ran: app.html 200
- webkit local merged `download-blob`: adapter script never ran: app.html 200
- webkit local merged `msg-ambient-parent`: adapter script never ran: app.html 200
- webkit local merged `msg-ambient-top`: adapter script never ran: app.html 200
- webkit local merged `msg-second-port`: adapter script never ran: app.html 200
- webkit local merged `msg-unknown-type`: adapter script never ran: app.html 200
- webkit local merged `msg-extra-field`: adapter script never ran: app.html 200
- webkit local merged `msg-extra-envelope`: adapter script never ran: app.html 200
- webkit local merged `msg-wrong-instance`: adapter script never ran: app.html 200
- webkit local merged `msg-wrong-release`: adapter script never ran: app.html 200
- webkit local merged `msg-wrong-generation`: adapter script never ran: app.html 200
- webkit local merged `msg-wrong-connection`: adapter script never ran: app.html 200
- webkit local merged `msg-wrong-version`: adapter script never ran: app.html 200
- webkit local merged `msg-replay`: adapter script never ran: app.html 200
- webkit local merged `msg-oversized`: adapter script never ran: app.html 200
- webkit local merged `msg-malformed`: adapter script never ran: app.html 200
- webkit local merged `msg-non-plain`: adapter script never ran: app.html 200
- webkit local merged `msg-proto-key`: adapter script never ran: app.html 200
- webkit local merged `msg-before-ready`: adapter script never ran: app.html 200
- webkit local merged `msg-editor-only`: adapter script never ran: app.html 200
- webkit local merged `msg-cross-connection`: adapter script never ran: app.html 200
- webkit local merged `msg-after-close`: adapter script never ran: app.html 200
- webkit local combined `preconnect`: 1 bare TCP connection(s) to attacker
- webkit local combined `webrtc-stun`: 4 STUN/UDP packet(s) to attacker
- webkit local inline `preconnect`: 1 bare TCP connection(s) to attacker
- webkit local inline `webrtc-stun`: 4 STUN/UDP packet(s) to attacker
- webkit hosted merged `benign-result`: ready=false accepted= closed=handshake_timeout
- webkit hosted merged `benign-editor`: accepted= closed=handshake_timeout
- webkit hosted merged `legit-assets`: ready=false css=not run app.js=200 image=?/200 font=no request module=not run/no request
- webkit hosted merged `parent-dom-read`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `parent-dom-write`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `top-dom-read`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `parent-location-read`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `storage-local`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `storage-session`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `storage-cookie`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `storage-indexeddb`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `storage-cache`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `fetch-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `fetch-host-api`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `xhr-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `websocket-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `eventsource-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `beacon-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `image-remote`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- webkit hosted merged `image-host-api`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `image-gateway-redirect`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- webkit hosted merged `style-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `style-attr-beacon`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- webkit hosted merged `css-import`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `font-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `prefetch`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `preconnect`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- webkit hosted merged `media-remote`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- webkit hosted merged `object-remote`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `nested-frame`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `script-remote`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- webkit hosted merged `import-remote`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- webkit hosted merged `anchor-ping`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `webrtc-stun`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `worker-same`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `worker-blob`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `worker-data`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `shared-worker`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `service-worker`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `nav-remote`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- webkit hosted merged `nav-data`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `nav-blob`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `nav-javascript`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `nav-redirect`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `nav-gateway-redirect`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `nav-same-generation`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `nav-host-page`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `meta-refresh`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `anchor-click`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `top-nav`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `top-nav-link`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `popup`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `popup-link`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `form-post`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `form-top`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `download-asset`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- webkit hosted merged `download-blob`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-ambient-parent`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-ambient-top`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-second-port`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-unknown-type`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-extra-field`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-extra-envelope`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-wrong-instance`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-wrong-release`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-wrong-generation`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-wrong-connection`: adapter script never ran: app.html 200, attack.js 200, app.css 200, pixel.png 200
- webkit hosted merged `msg-wrong-version`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-replay`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-oversized`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-malformed`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-non-plain`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-proto-key`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-before-ready`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-editor-only`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-cross-connection`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted merged `msg-after-close`: adapter script never ran: app.html 200, app.css 200, attack.js 200, pixel.png 200
- webkit hosted combined `preconnect`: 1 bare TCP connection(s) to attacker
- webkit hosted combined `webrtc-stun`: 4 STUN/UDP packet(s) to attacker
- webkit hosted inline `preconnect`: 1 bare TCP connection(s) to attacker
- webkit hosted inline `webrtc-stun`: 4 STUN/UDP packet(s) to attacker

## Positive controls

- chromium local open `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- chromium local open `benign-editor` pass: accepted=draft:change+action:propose closed=null
- chromium local open `legit-assets` pass: ready=true css=applied app.js=200 image=loaded/200 font=200(Origin http://127.0.0.1:65522) module=ran/200(Origin http://127.0.0.1:65522)
- chromium local merged `benign-result` fail: ready=false accepted= closed=handshake_timeout
- chromium local merged `benign-editor` fail: accepted= closed=handshake_timeout
- chromium local merged `legit-assets` fail: ready=false css=not run app.js=200 image=?/200 font=no request module=not run/no request
- chromium local combined `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- chromium local combined `benign-editor` pass: accepted=draft:change+action:propose closed=null
- chromium local combined `legit-assets` pass: ready=true css=applied app.js=200 image=loaded/200 font=403(Origin null) module=failed/403(Origin null)
- chromium local inline `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- chromium local inline `benign-editor` pass: accepted=draft:change+action:propose closed=null
- chromium local inline `legit-assets` pass: ready=true css=applied app.js=no request image=loaded/no request font=no request module=failed/no request
- chromium hosted open `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- chromium hosted open `benign-editor` pass: accepted=draft:change+action:propose closed=null
- chromium hosted open `legit-assets` pass: ready=true css=applied app.js=200 image=loaded/200 font=200(Origin https://localhost:65526) module=ran/200(Origin https://localhost:65526)
- chromium hosted merged `benign-result` fail: ready=false accepted= closed=handshake_timeout
- chromium hosted merged `benign-editor` fail: accepted= closed=handshake_timeout
- chromium hosted merged `legit-assets` fail: ready=false css=not run app.js=302 image=?/302 font=no request module=not run/no request
- chromium hosted combined `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- chromium hosted combined `benign-editor` pass: accepted=draft:change+action:propose closed=null
- chromium hosted combined `legit-assets` pass: ready=true css=applied app.js=200 image=loaded/200 font=302(Origin null) module=failed/302(Origin null)
- chromium hosted inline `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- chromium hosted inline `benign-editor` pass: accepted=draft:change+action:propose closed=null
- chromium hosted inline `legit-assets` pass: ready=true css=applied app.js=no request image=loaded/no request font=no request module=failed/no request
- webkit local open `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- webkit local open `benign-editor` pass: accepted=draft:change+action:propose closed=null
- webkit local open `legit-assets` pass: ready=true css=applied app.js=200 image=loaded/200 font=200 module=ran/200(Origin http://127.0.0.1:49154)
- webkit local merged `benign-result` fail: ready=false accepted= closed=handshake_timeout
- webkit local merged `benign-editor` fail: accepted= closed=handshake_timeout
- webkit local merged `legit-assets` fail: ready=false css=not run app.js=no request image=?/no request font=no request module=not run/no request
- webkit local combined `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- webkit local combined `benign-editor` pass: accepted=draft:change+action:propose closed=null
- webkit local combined `legit-assets` pass: ready=true css=applied app.js=200 image=loaded/200 font=200 module=failed/403(Origin null)
- webkit local inline `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- webkit local inline `benign-editor` pass: accepted=draft:change+action:propose closed=null
- webkit local inline `legit-assets` pass: ready=true css=applied app.js=no request image=loaded/no request font=no request module=failed/no request
- webkit hosted open `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- webkit hosted open `benign-editor` pass: accepted=draft:change+action:propose closed=null
- webkit hosted open `legit-assets` pass: ready=true css=applied app.js=200 image=loaded/200 font=200 module=ran/200(Origin https://localhost:49158)
- webkit hosted merged `benign-result` fail: ready=false accepted= closed=handshake_timeout
- webkit hosted merged `benign-editor` fail: accepted= closed=handshake_timeout
- webkit hosted merged `legit-assets` fail: ready=false css=not run app.js=200 image=?/200 font=no request module=not run/no request
- webkit hosted combined `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- webkit hosted combined `benign-editor` pass: accepted=draft:change+action:propose closed=null
- webkit hosted combined `legit-assets` pass: ready=true css=applied app.js=200 image=loaded/200 font=200 module=failed/302(Origin null)
- webkit hosted inline `benign-result` pass: ready=true accepted=ui:resize+ui:navigate closed=null
- webkit hosted inline `benign-editor` pass: accepted=draft:change+action:propose closed=null
- webkit hosted inline `legit-assets` pass: ready=true css=applied app.js=no request image=loaded/no request font=no request module=failed/no request

## Protocol checks

- ok: ready admitted
- ok: draft:change admitted after ready
- ok: action:propose admitted in editor
- ok: replayed seq → replayed_or_out_of_order
- ok: unknown type → schema
- ok: extra body field → schema
- ok: extra envelope field → schema
- ok: prototype version label → schema
- ok: wrong release → identity_mismatch
- ok: propose in result view → editor_only
- ok: cross-connection navigate → cross_connection_reference
- ok: oversized → oversized
- ok: non-plain → not_plain_json
- ok: own __proto__ key → not_plain_json
- ok: message before ready → before_ready
- ok: UI wire version equals the package UI protocol version
- ok: ui:navigate reuses ObjectReferenceSchema
- ok: package contract accepts a 1.0.0 result view
- **false**: package contract accepts a 1.0.0 editor view (expected false until the package schema widens)
