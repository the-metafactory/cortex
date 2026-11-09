const VARIANTS = {
  a: "A: Ask at the click",
  b: "B: Ask in a card",
  c: "C: Ask when starting the day",
};
const params = new URLSearchParams(location.search);
const variant = VARIANTS[params.get("variant")] ? params.get("variant") : "a";

const seed = () => ({
  view: "day",
  phase: "proposed",
  grant: false,
  filter: "all",
  selected: null,
  editing: null,
  moving: null,
  ask: null,
  checked: false,
  banner: null,
  wins: [],
  mails: [
    { id: "m1", title: "Budget question from a colleague", why: "Asks for an answer by tomorrow." },
    { id: "m2", title: "Invoice from a supplier", why: "Payment is due next week." },
  ],
  tasks: [
    { id: "t1", title: "Write the outline", area: "Work", project: "Launch", planned: true, why: "Top of your Work share this week." },
    { id: "t2", title: "Book the dentist", area: "Home", planned: true, due: "today", why: "Due today." },
    { id: "t3", title: "Respond to Ivy on launch timing", area: "Work", planned: true, studio: true, why: "Waiting in a Studio thread." },
    { id: "t4", title: "Review the draft", area: "Work", planned: true, why: "Next in Launch." },
    { id: "t5", title: "Renew the domain", area: "Work", due: "overdue", why: "Overdue by two days." },
    { id: "t6", title: "Plan next week", area: "Work", why: "No due date." },
    { id: "t7", title: "Sort the photos", area: "Home", why: "No due date." },
    { id: "t8", title: "Repair the shelf", area: "Home", why: "No due date." },
  ],
});
let s = seed();

const VERB = {
  start: "Start the day",
  done: "Complete",
  reopen: "Reopen",
  defer: "Set aside for today",
  select: "Work on",
  today: "Add to today",
  edit: "Save the edit to",
  move: "Move",
  file: "File to Balance",
  undo: "Undo",
  remove: "Remove",
};
const ALWAYS_ASK = new Set(["remove", "moveArea"]);
const esc = t => t.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const task = id => s.tasks.find(t => t.id === id);
const snapshot = () => JSON.stringify({ tasks: s.tasks, mails: s.mails, wins: s.wins, phase: s.phase, selected: s.selected });
const restore = text => Object.assign(s, JSON.parse(text));
const planned = () => s.tasks.filter(t => t.planned && !t.done && !t.deferred);
const current = () => task(s.selected) ?? planned()[0];

function apply(a) {
  const before = snapshot();
  const t = a.id ? task(a.id) : null;
  let text = "";
  if (a.kind === "start") { s.phase = "started"; text = "Your day is started."; }
  if (a.kind === "done") { t.done = true; s.wins.push(t.id); s.selected = null; text = `${t.title} is done.`; }
  if (a.kind === "reopen") { t.done = false; s.wins = s.wins.filter(w => w !== t.id); text = `${t.title} is open again, and today's win is removed.`; }
  if (a.kind === "defer") { t.deferred = true; s.selected = null; text = `${t.title} is set aside for today.`; }
  if (a.kind === "select") { s.selected = t.id; text = `Working on ${t.title}.`; }
  if (a.kind === "today") { t.planned = true; text = `${t.title} joined today.`; }
  if (a.kind === "edit") { t.title = a.value; s.editing = null; text = "Saved your edit."; }
  if (a.kind === "move" || a.kind === "moveArea") { t.area = a.area; t.project = a.project; s.moving = null; text = `${t.title} moved to ${a.project ? `${a.area} / ${a.project}` : a.area}.`; }
  if (a.kind === "remove") { s.tasks = s.tasks.filter(x => x.id !== t.id); s.selected = null; s.banner = { text: `${t.title} was removed.` }; return; }
  if (a.kind === "file") {
    const mail = s.mails.find(m => m.id === a.mail);
    s.mails = s.mails.filter(m => m.id !== a.mail);
    s.tasks.push({ id: `f${Date.now()}`, title: `Reply: ${mail.title}`, area: "Work", why: "Filed from mail. No due date." });
    text = "Filed. The mail is now a task in Balance.";
  }
  if (a.kind === "undo") { restore(a.before); s.banner = { text: "Undone." }; return; }
  if (a.kind === "start") { s.banner = null; return; }
  if (a.kind === "select") return;
  s.banner = { text, before };
}

function act(a) {
  const always = ALWAYS_ASK.has(a.kind);
  if (!always && s.grant) { apply(a); s.ask = null; render(); return; }
  if (variant === "c" && a.kind === "start") { if (s.checked) s.grant = true; apply(a); render(); return; }
  s.ask = a;
  s.checked = false;
  render();
}
function answer(mode) {
  const a = s.ask;
  s.ask = null;
  if (mode === "always" || (mode === "go" && s.checked)) s.grant = true;
  if (mode !== "cancel") apply(a);
  render();
}
function askTitle(a) {
  if (a.kind === "moveArea") return `Move ${task(a.id).title} from ${task(a.id).area} to ${a.area}?`;
  if (a.kind === "remove") return `Remove ${task(a.id).title}?`;
  if (a.kind === "start") return "Start the day with these priorities?";
  if (a.kind === "file") return `File ${s.mails.find(m => m.id === a.mail).title} to Balance?`;
  if (a.kind === "undo") return "Undo your last change?";
  return `${VERB[a.kind]} ${task(a.id).title}?`;
}
function askBody(a) {
  if (a.kind === "remove") return "This can't be undone.";
  if (a.kind === "start") return "This confirms today's plan and changes nothing outside it.";
  if (a.kind === "select") return "This only changes what you're working on today.";
  if (a.kind === "moveArea") return `${a.area} may have different data rules, so this is always confirmed. You can move it back.`;
  return "You can undo this today.";
}
function inlineAsk(a) {
  const always = ALWAYS_ASK.has(a.kind);
  const offer = !always && variant === "a";
  return `<div class="proto-ask ${a.kind === "remove" ? "warn" : ""}" role="group" aria-label="Confirm change">
    <strong>${esc(askTitle(a))}</strong><p>${esc(askBody(a))}${offer ? " One click skips this question for changes to today's plan and changes you can undo. You can turn it off below." : ""}</p>
    <div class="proto-row">
      ${offer ? `<button class="desk-btn pri" data-answer="always">Yes, use one click from now on</button><button class="desk-btn" data-answer="once">Just this once</button>` : `<button class="desk-btn pri" data-answer="once">${a.kind === "remove" ? "Remove" : "Confirm"}</button>`}
      <button class="desk-btn ghost" data-answer="cancel">Cancel</button>
    </div></div>`;
}
function modalAsk(a) {
  const always = ALWAYS_ASK.has(a.kind);
  return `<div class="proto-scrim"><div class="proto-modal" role="dialog" aria-modal="true" aria-label="Confirm change">
    <h2>${esc(askTitle(a))}</h2><p>${esc(askBody(a))}</p>
    ${always ? "" : `<label class="proto-check"><input type="checkbox" data-check ${s.checked ? "checked" : ""}><span>Don't ask again for changes to today's plan or changes I can undo</span></label>`}
    <div class="proto-row"><button class="desk-btn pri" data-answer="go">${a.kind === "remove" ? "Remove" : "Confirm"}</button><button class="desk-btn ghost" data-answer="cancel">Cancel</button></div>
  </div></div>`;
}
const isHere = where => s.ask && variant !== "b" && s.ask.where === where;
const here = where => isHere(where) ? inlineAsk(s.ask) : "";

function banner() {
  if (!s.banner) return "";
  return `<div class="proto-banner" role="status"><span>${esc(s.banner.text)}</span>${s.banner.before ? `<button class="desk-btn" data-undo>Undo</button>` : ""}</div>`;
}
function oneClick() {
  return `<p class="proto-one">One click for today's plan and changes you can undo: <b>${s.grant ? "on" : "off"}</b>. <button data-grant>${s.grant ? "Turn off" : "Turn on"}</button></p>`;
}
function detailTools(t) {
  if (s.editing === t.id) return `<div class="proto-edit"><input aria-label="Task title" id="edit-title" value="${esc(t.title)}"><button class="desk-btn pri" data-save="${t.id}">Save</button><button class="desk-btn ghost" data-edit-cancel>Cancel</button></div>`;
  if (s.moving === t.id) return `<div class="proto-edit"><select aria-label="Move to" id="move-to"><option value="Work|Launch">Work / Launch</option><option value="Work|Ideas">Work / Ideas</option><option value="Home|">Home</option></select><button class="desk-btn pri" data-move="${t.id}">Move</button><button class="desk-btn ghost" data-edit-cancel>Cancel</button></div>`;
  return `<div class="tf-actions proto-row" style="margin-top:10px"><button class="desk-btn ghost" data-editing="${t.id}">Edit</button>${t.studio ? "" : `<button class="desk-btn ghost" data-moving="${t.id}">Move</button><button class="desk-btn ghost" data-act="remove" data-id="${t.id}" data-where="current">Remove</button>`}</div>`;
}
function day() {
  const items = planned();
  const c = current();
  return `<div class="proto-page"><div class="desk-grid tf-shell"><div class="tf-layout">
    <main class="tf-main">
      <header class="tf-heading"><div><h1>My day</h1><p>What the engine says matters most today.</p></div><span>${s.wins.length} done</span></header>
      ${banner()}
      ${s.phase === "started" && c ? `<section class="tf-current" aria-label="Selected working task">
        <span class="tf-eyebrow">Next up</span>
        <h2>${esc(c.title)}</h2>
        <p>${c.studio ? "Studio" : "Estimate unknown"} · ${esc(c.area)}${c.project ? ` / ${esc(c.project)}` : ""}</p>
        <div class="tf-actions proto-row">
          ${c.studio ? `<a class="desk-btn pri" href="#studio">Respond in Studio</a>` : `<button class="desk-btn pri" data-act="done" data-id="${c.id}" data-where="current">Done</button>`}
          <button class="desk-btn ghost" data-act="defer" data-id="${c.id}" data-where="current">→ not today</button>
        </div>
        ${detailTools(c)}
        ${here("current")}
      </section>` : ""}
      ${s.phase === "proposed" ? `<section class="tf-contract" aria-label="Day confirmation"><p>Does this look like your day?</p>
        ${variant === "c" ? `<label class="proto-check"><input type="checkbox" data-check ${s.checked ? "checked" : ""}><span>Use one click from now on for changes to today's plan and changes I can undo, such as Done or Not today. You can turn it off below.</span></label>` : ""}
        <div class="tf-actions proto-row"><button class="desk-btn pri" data-act="start" data-where="contract">Start the day</button></div>${here("contract")}</section>` : ""}
      ${s.wins.length ? `<section class="tf-wins"><h2>Wins today</h2><ul>${s.wins.map(w => `<li>${esc(task(w)?.title ?? "Task")} <button class="desk-btn ghost" data-act="reopen" data-id="${w}" data-where="wins">Reopen</button></li>`).join("")}</ul>${here("wins")}</section>` : ""}
      ${here("banner")}
      ${oneClick()}
    </main>
    <aside class="tf-side" aria-label="Priorities"><section class="tf-priorities" aria-label="Today's priorities">
      <header><h2>Today's priorities</h2></header><p>Your saved order · Choose freely</p>
      <ol>${items.map((t, i) => `<li><button class="tf-choice" aria-pressed="${c?.id === t.id}" ${s.phase === "started" ? `data-act="select" data-id="${t.id}" data-where="current"` : "disabled"}><span class="tf-rank">${i + 1}</span><span><strong>${esc(t.title)}</strong><br><small>${esc(t.area)}${t.studio ? " · Studio" : ""}${t.due ? ` · ${t.due === "today" ? "due today" : "overdue"}` : ""}</small></span></button></li>`).join("")}</ol>
    </section></aside>
  </div></div></div>`;
}
function taskCard(t) {
  const where = `c-${t.id}`;
  return `<article class="proto-card"><h3>${esc(t.title)}${t.planned && !t.deferred ? `<span class="proto-tag">In today</span>` : ""}${t.due ? `<span class="proto-tag due">${t.due === "today" ? "Due today" : "Overdue"}</span>` : ""}</h3>
    <p>${esc(t.area)} · ${esc(t.why)}</p>
    <div class="proto-row">
      ${t.studio ? `<a class="desk-btn" href="#studio">Respond in Studio</a>` : s.phase === "started" ? `<button class="desk-btn" data-act="done" data-id="${t.id}" data-where="${where}">Done</button>` : ""}
      ${t.planned ? "" : `<button class="desk-btn ghost" data-act="today" data-id="${t.id}" data-where="${where}">Add to today</button>`}
    </div>${here(where)}</article>`;
}
function mailCard(m) {
  const where = `c-${m.id}`;
  return `<article class="proto-card"><h3>${esc(m.title)}</h3><p>Mail · ${esc(m.why)}</p><div class="proto-row"><button class="desk-btn" data-act="file" data-mail="${m.id}" data-where="${where}">File to Balance</button></div>${here(where)}</article>`;
}
function catchup() {
  const open = s.tasks.filter(t => !t.done);
  const tasks = s.filter === "mail" ? [] : open;
  const mails = s.filter === "task" ? [] : s.mails;
  const dated = tasks.filter(t => t.due);
  const rest = tasks.filter(t => !t.due);
  const need = mails.length + dated.length;
  return `<div class="proto-page catchup-wrap"><main class="catchup">
    <header class="catchup-lead"><div><p class="catchup-eyebrow">Your inbox</p><h1>Catch-up</h1><p>Everything open. My day shows what matters most.</p></div><span>${need} need you · ${need + rest.length} in all</span></header>
    <nav class="catchup-types" aria-label="Kind">${[["all", "All"], ["task", "Tasks"], ["mail", "Mail"]].map(([k, l]) => `<button aria-pressed="${s.filter === k}" data-filter="${k}">${l}</button>`).join("")}</nav>
    ${banner()}${here("banner")}
    ${need ? `<h2 class="proto-section">Needs you</h2><div class="proto-list">${mails.map(mailCard).join("")}${dated.map(taskCard).join("")}</div>` : ""}
    ${rest.length ? `<h2 class="proto-section">Everything else</h2><div class="proto-list">${rest.map(taskCard).join("")}</div>` : ""}
    ${oneClick()}
  </main></div>`;
}
function render() {
  document.getElementById("app").innerHTML = `<nav class="proto-top" role="tablist" aria-label="View"><button role="tab" aria-selected="${s.view === "day"}" data-view="day">Day</button><button role="tab" aria-selected="${s.view === "catchup"}" data-view="catchup">Catch-up</button></nav>${s.view === "day" ? day() : catchup()}${s.ask && variant === "b" ? modalAsk(s.ask) : ""}`;
  document.getElementById("bar").innerHTML = `${Object.entries(VARIANTS).map(([k, l]) => `<button aria-pressed="${k === variant}" aria-label="${l}" data-variant="${k}">${innerWidth < 800 ? k.toUpperCase() : l}</button>`).join("")}<button data-reset>Reset</button>`;
}
document.addEventListener("change", e => { if (e.target.matches("[data-check]")) s.checked = e.target.checked; });
document.addEventListener("click", e => {
  const b = e.target.closest("button");
  if (!b) return;
  const d = b.dataset;
  if (d.variant) { location.search = `?variant=${d.variant}`; return; }
  if ("reset" in d) { s = seed(); render(); return; }
  if (d.view) { s.view = d.view; s.ask = null; s.banner = null; render(); return; }
  if (d.filter) { s.filter = d.filter; render(); return; }
  if ("grant" in d) { s.grant = !s.grant; render(); return; }
  if (d.answer) { answer(d.answer); return; }
  if ("undo" in d) { act({ kind: "undo", before: s.banner.before, where: "banner" }); return; }
  if (d.editing) { s.editing = d.editing; s.moving = null; render(); return; }
  if (d.moving) { s.moving = d.moving; s.editing = null; render(); return; }
  if ("editCancel" in d) { s.editing = null; s.moving = null; render(); return; }
  if (d.save) { act({ kind: "edit", id: d.save, value: document.getElementById("edit-title").value.trim() || task(d.save).title, where: "current" }); return; }
  if (d.move) {
    const [area, project] = document.getElementById("move-to").value.split("|");
    act({ kind: area === task(d.move).area ? "move" : "moveArea", id: d.move, area, project: project || undefined, where: "current" });
    return;
  }
  if (d.act) act({ kind: d.act, id: d.id, mail: d.mail, where: d.where });
});
render();
