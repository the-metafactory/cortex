import { DESK_ADAPTER_FRAMES_PATH, FrameOpenReplySchema, FrameReplySchema, frameEntryUrl } from "../../desk/adapter-frame-contract";
import { DESK_UI_HANDSHAKE_MS, DESK_UI_MAX_MESSAGE_BYTES, DESK_UI_PROTOCOL, DESK_UI_WIRE_VERSION, HostMessageSchema, InboundGate, InitSchema, newInstance, plainJson, type HostMessage, type Identity, type UiMessage } from "../../desk/adapter-frame-protocol";

export type FrameNavigation = Extract<UiMessage, { type: "ui:navigate" }>["body"]["target"];
export interface FrameEvents {
  state(state: "loading" | "ready" | "unavailable"): void;
  review(draftId: string, revision: number): void;
  navigate?(target: FrameNavigation): void;
}

const RELAY = `let transferred=false;addEventListener('message',event=>{if(transferred||event.source!==parent||event.ports.length!==1||event.data?.type!=='host:init')return;const frame=document.querySelector('iframe');if(!frame?.contentWindow)return;transferred=true;frame.contentWindow.postMessage(event.data,'*',[event.ports[0]]);});`;
const htmlAttribute = (value: string): string => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
export const frameWrapper = (entry: string): string => `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="frame-src ${htmlAttribute(entry)}; base-uri 'none'; object-src 'none'"></head><body style="margin:0"><script>${RELAY}</script></body></html>`;

export async function frameRequest(path: string, signal: AbortSignal, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<unknown> {
  const response = await fetch(path, { method, credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.any([signal, AbortSignal.timeout(3000)]), ...(body === undefined ? {} : { headers: { "content-type": "application/json", "x-desk-ui-protocol": DESK_UI_WIRE_VERSION }, body: JSON.stringify(body) }) });
  if (!response.ok || response.redirected) throw new Error("adapter_view_unavailable");
  const text = await response.text();
  if (new TextEncoder().encode(text).length > DESK_UI_MAX_MESSAGE_BYTES * 8) throw new Error("adapter_view_oversized");
  return JSON.parse(text) as unknown;
}

export function mountAdapterFrame(container: HTMLElement, mountId: string, events: FrameEvents): () => void {
  const controller = new AbortController();
  const instance = newInstance();
  const path = `${DESK_ADAPTER_FRAMES_PATH}/${instance}`;
  let wrapper: HTMLIFrameElement | undefined;
  let frame: HTMLIFrameElement | undefined;
  let channel: MessageChannel | undefined;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let work = Promise.resolve();
  let pending = 0;
  let identity: Identity | undefined;
  let hostSeq = 1;
  const close = (reason: "navigation" | "unmounted" | "protocol_violation"): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer); clearTimeout(poll);
    if (channel && identity) channel.port1.postMessage({ ...identity, seq: ++hostSeq, type: "host:close", body: { reason } });
    channel?.port1.close(); channel?.port2.close();
    wrapper?.remove();
    controller.abort();
    void fetch(path, { method: "DELETE", credentials: "same-origin", redirect: "error", keepalive: true }).catch(() => undefined);
    if (reason !== "unmounted") events.state("unavailable");
  };
  const post = (raw: HostMessage): void => {
    if (closed || !identity || !plainJson(raw) || new TextEncoder().encode(JSON.stringify(raw)).length > DESK_UI_MAX_MESSAGE_BYTES) throw new Error("invalid_host_message");
    const message = HostMessageSchema.parse(raw);
    if (message.instance !== instance || message.adapterId !== identity.adapterId || message.connectionId !== identity.connectionId || message.generationId !== identity.generationId || message.releaseDigest !== identity.releaseDigest || message.seq <= hostSeq) throw new Error("invalid_host_identity");
    hostSeq = message.seq;
    channel?.port1.postMessage(message);
  };
  const exchange = async (raw?: UiMessage): Promise<void> => {
    const reply = FrameReplySchema.parse(await frameRequest(path, controller.signal, raw));
    if (closed) return;
    for (const message of reply.messages) post(message);
    if (raw?.type === "ui:ready") {
      clearTimeout(timer);
      if (wrapper) wrapper.hidden = false;
      events.state("ready");
    }
    if (raw && reply.messages.some(message => message.type === "host:reply" && message.body.replyTo === raw.seq && message.body.outcome === "accepted")) {
      if (raw.type === "action:propose") events.review(raw.body.draftId, raw.body.revision);
      if (raw.type === "ui:navigate") events.navigate?.(raw.body.target);
    }
  };
  const enqueue = (run: () => Promise<void>): void => {
    if (++pending > 64) { close("protocol_violation"); return; }
    work = work.then(() => closed ? undefined : run()).catch(() => { close("protocol_violation"); }).finally(() => { pending--; });
  };
  const pollLater = (): void => {
    poll = setTimeout(() => { enqueue(async () => { await exchange(); if (!closed) pollLater(); }); }, 1000);
  };
  const start = async (): Promise<void> => {
    events.state("loading");
    const opened = FrameOpenReplySchema.parse(await frameRequest(DESK_ADAPTER_FRAMES_PATH, controller.signal, { mountId, instance }));
    if (closed) return;
    const entry = opened.entry;
    const url = frameEntryUrl(entry, location.origin);
    if (!url || !entry.views.some(view => view.objectType === opened.mount.objectType && view.view === opened.mount.view)) throw new Error("unavailable_entry");
    const checked = await fetch(url, { credentials: "same-origin", redirect: "error", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(3000)]), headers: { "x-desk-ui-protocol": DESK_UI_WIRE_VERSION } });
    const csp = checked.headers.get("content-security-policy") ?? "";
    await checked.body?.cancel();
    if (!checked.ok || checked.redirected || !checked.headers.get("content-type")?.startsWith("text/html") || !csp.includes("sandbox allow-scripts") || !csp.includes("connect-src 'none'") || !csp.includes("worker-src 'none'")) throw new Error("unsafe_entry");
    if (closed) return;
    identity = { protocol: DESK_UI_PROTOCOL, version: DESK_UI_WIRE_VERSION, instance, adapterId: entry.adapterId, connectionId: entry.connectionId, generationId: entry.generationId, releaseDigest: entry.releaseDigest };
    const gate = new InboundGate(identity, opened.mount);
    channel = new MessageChannel();
    channel.port1.onmessageerror = () => { close("protocol_violation"); };
    channel.port1.onmessage = event => {
      if (closed) return;
      const verdict = gate.admit(event.data);
      if (!verdict.ok || verdict.message.type === "ui:error") { close("protocol_violation"); return; }
      const message = verdict.message;
      if (message.type === "ui:resize" && frame && wrapper) frame.style.height = wrapper.style.height = `${message.body.height}px`;
      enqueue(async () => { await exchange(message); if (message.type === "ui:ready" && !closed) pollLater(); });
    };
    channel.port1.start();
    wrapper = document.createElement("iframe");
    wrapper.title = "Desk view host";
    wrapper.hidden = true;
    wrapper.style.cssText = "width:100%;height:240px;border:0";
    let wrapperLoaded = false;
    wrapper.addEventListener("load", () => {
      if (closed) return;
      if (wrapperLoaded) { close("navigation"); return; }
      wrapperLoaded = true;
      const doc = wrapper?.contentDocument;
      if (!doc) { close("protocol_violation"); return; }
      doc.addEventListener("securitypolicyviolation", () => { close("navigation"); });
      frame = doc.createElement("iframe");
      if (!frame.sandbox.supports("allow-scripts")) { close("protocol_violation"); return; }
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("allow", "camera 'none'; microphone 'none'; geolocation 'none'; payment 'none'; usb 'none'; clipboard-read 'none'; clipboard-write 'none'");
      frame.referrerPolicy = "no-referrer";
      frame.title = "Adapter view";
      frame.style.cssText = "width:100%;height:240px;border:0";
      let loaded = false;
      frame.addEventListener("load", () => {
        if (closed) return;
        if (loaded) { close("navigation"); return; }
        loaded = true;
        if (!frame?.contentWindow || !wrapper?.contentWindow || !identity || !channel) { close("protocol_violation"); return; }
        wrapper.contentWindow.postMessage(InitSchema.parse({ ...identity, seq: 1, type: "host:init", body: { mount: opened.mount } }), location.origin, [channel.port2]);
      });
      frame.src = url;
      doc.body.append(frame);
    });
    wrapper.srcdoc = frameWrapper(url);
    timer = setTimeout(() => { close("protocol_violation"); }, DESK_UI_HANDSHAKE_MS);
    container.append(wrapper);
  };
  void start().catch(() => { close("protocol_violation"); });
  return () => { close("unmounted"); };
}
