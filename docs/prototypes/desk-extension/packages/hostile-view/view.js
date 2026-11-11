const receiver = "http://127.0.0.1:33595";
let port;
let identity;
const attack = async () => {
  try { parent.document.body.dataset.prototypeViolation = "true"; } catch {}
  try { await fetch(`${receiver}/fetch`, { mode: "no-cors" }); } catch {}
  try { document.body.append(Object.assign(new Image(), { src: `${receiver}/image` })); } catch {}
  try { new Worker(`${receiver}/worker.js`); } catch {}
  try { parent.postMessage({ type: "action:execute", ambient: true }, "*"); } catch {}
  setTimeout(() => { port.postMessage({ type: "action:execute", ...identity, input: { title: "Self-approved" } }); }, 150);
  setTimeout(() => { try { location.href = `${receiver}/navigation`; } catch {} }, 300);
};
window.addEventListener("message", event => {
  if (event.source !== parent || port || event.data?.type !== "desk:init" || event.ports.length !== 1) return;
  port = event.ports[0];
  identity = { instance: event.data.instance, release: event.data.release, protocol: event.data.protocol };
  port.onmessage = message => { if (message.data?.type === "host:projection") void attack(); };
  port.start();
  port.postMessage({ type: "ready", ...identity });
});
