let port;
let identity;
let current;
let attackOrigin;
const root = document.querySelector("main");
const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const send = (type, extra = {}) => port?.postMessage({ type, ...identity, ...extra });
const render = () => {
  if (!current) return;
  document.documentElement.dataset.theme = current.theme;
  const fields = current.fields;
  const graph = current.adapter === "graph";
  const names = graph ? ["repository", "parent", "title", "body", "checkpoint"] : ["area", "project", "title", "note", "due"];
  const editor = names.map(name => `<label>${escape(name)}${["body", "note"].includes(name) ? `<textarea data-field="${name}">${escape(fields[name])}</textarea>` : `<input data-field="${name}" value="${escape(fields[name])}">`}</label>`).join("");
  const summary = graph ? `<div class="trail">${escape(fields.repository)}<br>↓<br>${escape(fields.parent)}<br>↓</div><h1>${escape(fields.title)}</h1><p>${escape(fields.body)}</p><span class="tag">Research · ${escape(fields.checkpoint)}</span>` : `<div class="task"><span class="check">○</span><div><small>${escape(fields.area)} / ${escape(fields.project)}</small><h1>${escape(fields.title)}</h1><p>${escape(fields.note)}</p><span class="tag">${fields.due ? escape(fields.due) : "No due date"}</span></div></div>`;
  root.innerHTML = `<div class="module-label">${graph ? "Work graph" : "Balance"} · custom module · synthetic projection</div>${current.stage === "editor" ? `<h1>${graph ? "Shape the research node" : "Refine the next task"}</h1>${editor}<button data-act="propose">Request host review</button>` : current.stage === "query" ? `<h1>One result in selected scope</h1><div class="result">${summary}<button data-act="detail">Inspect object</button></div>` : `${summary}${current.stage === "detail" ? `<dl>${names.filter(name => name !== "title").map(name => `<dt>${escape(name)}</dt><dd>${escape(fields[name]) || "Not specified"}</dd>`).join("")}</dl>` : ""}<button data-act="editor">Edit this draft</button>`}<p class="foot">Host owns identity, navigation, confirmation and receipt. This module cannot execute an action.</p>`;
  root.querySelectorAll("[data-field]").forEach(element => { element.addEventListener("input", () => { current.fields[element.dataset.field] = element.value; send("draft:change", { name: element.dataset.field, value: element.value }); }); });
  root.querySelectorAll("[data-act]").forEach(element => { element.addEventListener("click", () => { if (element.dataset.act === "propose") send("action:propose"); else send("host:navigate", { stage: element.dataset.act }); }); });
};
const probe = async attack => {
  if (attack === "parent") {
    try { parent.document.body.dataset.prototypeViolation = "true"; send("probe:result", { attack, result: "UNSAFE parent access succeeded" }); }
    catch (error) { send("probe:result", { attack, result: error.name === "SecurityError" ? "blocked by opaque origin" : error.name }); }
  } else if (attack === "fetch") {
    try { await fetch(`${attackOrigin}/fetch`); send("probe:result", { attack, result: "UNSAFE fetch succeeded" }); }
    catch (error) { send("probe:result", { attack, result: `blocked (${error.name})` }); }
  } else if (attack === "image") {
    const image = new Image(); image.src = `${attackOrigin}/image`; root.append(image);
  } else if (attack === "worker") {
    try { new Worker(`${attackOrigin}/worker.js`); send("probe:result", { attack, result: "UNSAFE worker created" }); }
    catch (error) { send("probe:result", { attack, result: `blocked (${error.name})` }); }
  } else if (attack === "ambient") parent.postMessage({ type: "action:execute", fields: current.fields }, "*");
  else if (attack === "wrong-generation") port.postMessage({ type: "draft:change", ...identity, release: "generation-b", name: "title", value: "Forged replacement" });
  else if (attack === "unknown-event") send("action:execute", { fields: current.fields });
  else if (attack === "prototype-event") send("toString");
  else if (attack === "constructor-event") send("constructor");
  else if (attack === "proto-event") send("__proto__");
  else if (attack === "array-payload") port.postMessage(Object.assign([], { type: "ready", ...identity }));
  else if (attack === "cyclic-payload") { const payload = { type: "ready", ...identity }; payload.cycle = payload; port.postMessage(payload); }
  else if (attack === "bigint-payload") send("probe:result", { attack, result: 1n });
  else if (attack === "self-navigation") location.href = `${attackOrigin}/navigation`;
  else if (attack === "renderer-error") send("renderer:error", { message: "Synthetic module failure" });
};
window.addEventListener("securitypolicyviolation", event => { send("probe:result", { attack: event.violatedDirective, result: `browser CSP blocked ${event.blockedURI}` }); });
window.addEventListener("message", event => {
  if (event.source !== parent || port || event.data?.type !== "desk:init" || event.data.protocol !== "1.0.0-prototype" || event.data.release !== "generation-a" || event.ports.length !== 1) return;
  port = event.ports[0];
  identity = { instance: event.data.instance, release: event.data.release, protocol: event.data.protocol };
  attackOrigin = event.data.attackOrigin;
  current = undefined;
  port.onmessage = message => {
    if (message.data?.type === "host:probe") { void probe(message.data.attack); return; }
    if (message.data?.type !== "host:projection") return;
    const next = { adapter: message.data.adapter, stage: message.data.stage, fields: message.data.fields, theme: message.data.theme };
    if (JSON.stringify(current) !== JSON.stringify(next)) { current = next; render(); }
  };
  port.start(); render(); send("ready");
});
