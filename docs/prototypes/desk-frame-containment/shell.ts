import { DESK_UI_HANDSHAKE_MS, DESK_UI_PROTOCOL, DESK_UI_WIRE_VERSION, InboundGate, newInstance, type Identity, type Mount } from "./protocol";

interface CatalogEntry { adapterId: string; connectionId: string; generationId: string; releaseDigest: string; entry: string; files: { path: string; url: string }[] }
interface LabState { log: string[]; accepted: string[]; violations: string[]; ambient: number; closed: string | null; loads: number; ready: boolean; projectionSent: boolean; frameUrl: string; done: boolean }

const q = new URLSearchParams(location.search);
const attack = q.get("a") ?? "benign-result";
const variant = q.get("variant") ?? "combined";
const canary = q.get("c") ?? "none";
const lab: LabState = { log: [], accepted: [], violations: [], ambient: 0, closed: null, loads: 0, ready: false, projectionSent: false, frameUrl: "", done: false };
(window as unknown as { __lab: LabState }).__lab = lab;
const note = (line: string): void => { lab.log.push(`${Math.round(performance.now())} ${line}`); };

try { localStorage.setItem("lab-canary", canary); sessionStorage.setItem("lab-canary", canary); } catch (_err) { note("storage unavailable in shell"); }
document.cookie = `lab-canary=${canary}; path=/; SameSite=Lax`;
document.title = `shell ${canary}`;

window.addEventListener("message", event => {
  lab.ambient += 1;
  note(`ambient message ignored: ${JSON.stringify(event.data)?.slice(0, 120) ?? "?"} ports=${event.ports.length}`);
});

async function main(): Promise<void> {
  const response = await fetch("/api/desk/adapters/catalog", { headers: { "x-desk-ui-protocol": DESK_UI_WIRE_VERSION } });
  if (!response.ok) { note(`catalog ${response.status}`); lab.done = true; return; }
  const catalog = await response.json() as { adapters: CatalogEntry[] };
  const entry = catalog.adapters[0];
  const entryFile = entry?.files.find(file => file.path === entry.entry);
  if (!entry || !entryFile) { note("no adapter entry"); lab.done = true; return; }
  const mount: Mount = { objectType: "task", view: attack === "benign-result" || attack === "msg-editor-only" ? "result" : "editor" };
  const identity: Identity = { protocol: DESK_UI_PROTOCOL, version: DESK_UI_WIRE_VERSION, instance: newInstance(), adapterId: entry.adapterId, connectionId: entry.connectionId, generationId: entry.generationId, releaseDigest: entry.releaseDigest };
  const fragment = new URLSearchParams({ a: attack, e: q.get("e") ?? "", u: q.get("u") ?? "", t: q.get("t") ?? "", r: q.get("r") ?? "", m: JSON.stringify(mount) });
  lab.frameUrl = `${location.origin}${entryFile.url}`;

  const frame = document.createElement("iframe");
  if (variant !== "open") frame.setAttribute("sandbox", "allow-scripts");
  frame.referrerPolicy = "no-referrer";
  frame.title = "Adapter view";
  frame.style.cssText = "width:100%;height:240px;border:1px solid #888";

  const channel = new MessageChannel();
  const gate = new InboundGate(identity, mount);
  let hostSeq = 0;
  const post = (type: string, body: unknown): void => { hostSeq += 1; channel.port1.postMessage({ ...identity, seq: hostSeq, type, body }); };
  const close = (reason: string, detail?: string): void => {
    if (lab.closed) return;
    lab.closed = detail ? `${reason}:${detail}` : reason;
    note(`bridge closed ${lab.closed}`);
    try { post("host:close", { reason: reason === "handshake_timeout" ? "protocol_violation" : reason }); } catch (_err) { note("close post failed"); }
    channel.port1.close();
    frame.remove();
    lab.done = true;
  };
  const timer = setTimeout(() => { if (!lab.ready) close("handshake_timeout"); }, DESK_UI_HANDSHAKE_MS);

  channel.port1.onmessage = event => {
    if (lab.closed) return;
    const verdict = gate.admit(event.data);
    if (!verdict.ok) { lab.violations.push(verdict.violation); close("protocol_violation", verdict.violation); return; }
    const message = verdict.message;
    note(`admitted ${message.type}`);
    switch (message.type) {
      case "ui:ready":
        lab.ready = true;
        clearTimeout(timer);
        post("host:theme", { scheme: "light", reducedMotion: false, locale: "en" });
        if (mount.view === "editor") post("host:draft", { draftId: "draft-1", revision: 1, values: { "/title": canary }, blocking: [] });
        post("host:projection", { projectionId: "projection-1", revision: 1, object: { title: canary } });
        lab.projectionSent = true;
        return;
      case "draft:change":
      case "action:propose":
      case "ui:navigate":
        lab.accepted.push(message.type);
        post("host:reply", { replyTo: message.seq, outcome: "accepted" });
        return;
      default:
        lab.accepted.push(message.type);
    }
  };
  channel.port1.start();

  frame.addEventListener("load", () => {
    lab.loads += 1;
    note(`frame load ${lab.loads}`);
    if (lab.loads > 1) { close("navigation"); return; }
    frame.contentWindow?.postMessage({ ...identity, seq: ++hostSeq, type: "host:init", body: { mount } }, "*", [channel.port2]);
  });
  frame.src = `${lab.frameUrl}#${fragment.toString()}`;
  document.body.append(frame);
}

void main().catch((error: unknown) => { note(`shell failed ${String(error)}`); lab.done = true; });
