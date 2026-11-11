export const FLOW_EDITOR_MEDIA = { html: "text/html", js: "text/javascript", css: "text/css" } as const;
export const FLOW_EDITOR_ENTRY = "ui/flow-editor.html";
export const FLOW_EDITOR_VIEWS = [{ objectType: "flow.save-draft", view: "editor" }] as const;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="flow-editor.css"></head><body>
<main aria-label="Flow editor">
<label for="flow-name">Name</label><input id="flow-name" autocomplete="off" spellcheck="false">
<label for="flow-yaml">Definition</label><textarea id="flow-yaml" rows="12" spellcheck="false"></textarea>
<button id="flow-apply" type="button" disabled>Apply edit</button> <button id="flow-review" type="button" disabled>Review in Desk</button>
<p id="flow-status" role="status"></p>
<section aria-label="Steps"><h2>Steps</h2><ol id="flow-steps"></ol></section>
<section aria-label="Pulse findings"><h2>Pulse findings</h2><ul id="flow-findings"></ul></section>
</main><script src="flow-editor.js"></script></body></html>`;

const css = `body{font:14px system-ui,sans-serif;margin:0;padding:12px;color:CanvasText;background:Canvas}
label{display:block;font-weight:600;margin-top:8px}
input,textarea{width:100%;box-sizing:border-box;font:13px ui-monospace,monospace}
button{margin-top:8px}
ul,ol{padding-left:20px}
#flow-findings li{color:#8a1c1c}
@media (prefers-color-scheme:dark){#flow-findings li{color:#ff9b9b}}`;

const script = `(() => {
  const nameInput = document.getElementById("flow-name");
  const yamlInput = document.getElementById("flow-yaml");
  const apply = document.getElementById("flow-apply");
  const review = document.getElementById("flow-review");
  const status = document.getElementById("flow-status");
  const steps = document.getElementById("flow-steps");
  const findings = document.getElementById("flow-findings");
  let port = null;
  let identity = null;
  let seq = 0;
  let draft = null;
  let pending = false;
  const post = (type, body) => { port.postMessage({ ...identity, type, body, seq: ++seq }); };
  const fill = (list, items) => { list.replaceChildren(...items.map(text => { const item = document.createElement("li"); item.textContent = text; return item; })); };
  const dirty = () => draft !== null && (nameInput.value !== draft.values["/name"] || yamlInput.value !== draft.values["/definition"]);
  const refresh = () => { apply.disabled = pending || !dirty(); review.disabled = pending || draft === null || dirty(); };
  const resize = () => { post("ui:resize", { height: Math.min(4000, Math.ceil(document.documentElement.scrollHeight)) }); };
  addEventListener("message", event => {
    if (port !== null || event.source !== parent || event.data?.type !== "host:init" || event.ports.length !== 1) return;
    port = event.ports[0];
    const { protocol, version, instance, adapterId, connectionId, generationId, releaseDigest } = event.data;
    identity = { protocol, version, instance, adapterId, connectionId, generationId, releaseDigest };
    port.onmessage = message => {
      const { type, body } = message.data;
      if (type === "host:draft") {
        const unsaved = dirty();
        draft = body;
        if (!unsaved) { nameInput.value = String(body.values["/name"] ?? ""); yamlInput.value = String(body.values["/definition"] ?? ""); }
        pending = false;
      } else if (type === "host:projection") {
        fill(steps, body.object.steps);
        fill(findings, body.object.findings.length ? body.object.findings.map(item => item.message) : ["No findings."]);
      } else if (type === "host:reply") {
        pending = false;
        status.textContent = body.outcome === "accepted" ? "Edit applied to the draft." : "The draft changed; your edit was not applied.";
      }
      refresh();
      resize();
    };
    port.start();
    post("ui:ready", event.data.body);
  });
  nameInput.addEventListener("input", refresh);
  yamlInput.addEventListener("input", refresh);
  review.addEventListener("click", () => {
    if (draft && !pending && !dirty()) post("action:propose", { draftId: draft.draftId, revision: draft.revision });
  });
  apply.addEventListener("click", () => {
    if (!draft || pending || !dirty()) return;
    const changes = [];
    if (nameInput.value !== draft.values["/name"]) changes.push({ pointer: "/name", change: { kind: "set", value: nameInput.value } });
    if (yamlInput.value !== draft.values["/definition"]) changes.push({ pointer: "/definition", change: { kind: "set", value: yamlInput.value } });
    pending = true;
    status.textContent = "";
    refresh();
    post("draft:change", { draftId: draft.draftId, baseRevision: draft.revision, changes });
  });
})();`;

export const FLOW_EDITOR_FILES: Record<string, { body: string; mediaType: string }> = {
  [FLOW_EDITOR_ENTRY]: { body: html, mediaType: FLOW_EDITOR_MEDIA.html },
  "ui/flow-editor.js": { body: script, mediaType: FLOW_EDITOR_MEDIA.js },
  "ui/flow-editor.css": { body: css, mediaType: FLOW_EDITOR_MEDIA.css },
};
