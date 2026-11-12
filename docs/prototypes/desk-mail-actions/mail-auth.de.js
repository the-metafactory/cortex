/* ---------- Prototype for cortex#3356: Mail actions under host authority ---------- */
/* Shows what is new for Mail beyond the My Day prototype: warnings for actions with outside effects (report, */
/* invitation reply, unsubscribe), the sweep preview with scope and count, and the Undo conflict state. */
/* The simulation switch decides how the provider answers the next action. All data is made up. */
const CONN = "Privat";
const FAM = {
  move: { label: "Archivieren, Spam, Löschen und Wiederherstellen", note: "Löschen heisst Papierkorb, nie endgültig. Jede Aktion hat ein Rückgängig." },
  "report:phishing": { label: "Phishing beim Anbieter melden", warn: "Die Meldung geht an deinen Mailanbieter. Rückgängig holt die Mail in den Posteingang zurück, die Meldung selbst lässt sich nicht zurückziehen." },
  invite: { label: "Einladungen beantworten: Zusagen, Absagen, Vielleicht", warn: "Jede Antwort benachrichtigt den Organisator. Rückgängig kann diese Nachricht nicht zurückholen." },
  "invite:remove": { label: "Abgesagte Einladungen aus dem Kalender entfernen", note: "Nie automatisch nach dem Absagen. Rückgängig stellt den Termin wieder her." },
  unsubscribe: { label: "Mit einem Klick abmelden", warn: "Das ändert dein Abo beim Absender. Es lässt sich vielleicht nicht rückgängig machen." },
};
const SWEEP = { fam: "sweep:wochenbrief-7d", label: "Archivieren · Absender Wochenbrief Sicherheit · älter als 7 Tage", count: 18 };
const MAILS = [
  { id: "m1", from: "Wochenbrief Sicherheit", subj: "Wochenrückblick KW 46", gist: "Zwölf Meldungen der Woche.", kind: "news" },
  { id: "m2", from: "Konto-Service", subj: "Ihr Postfach wird heute gesperrt", gist: "Link auf eine fremde Domain, Absender nicht in deinen Kontakten.", kind: "phish" },
  { id: "m3", from: "Nico, Geschäftsleitung", subj: "Einladung: Drehbuch Krisenübung, Mo 11:00", gist: "Termin mit fünf Teilnehmenden.", kind: "invite" },
];
const SIMS = [
  ["ok", "Normal"],
  ["moved", "Mail inzwischen verschoben"],
  ["missing", "Mail nicht mehr da"],
  ["denied", "Konto verweigert"],
  ["unclear", "Anbieter antwortet nicht"],
];
const M = { sim: "ok", grants: new Set(), ask: null, receipts: [], gone: new Set(), state: {}, sweep: false, toast: "", n: 0 };

const famOf = (a) => ({ archive: "move", junk: "move", trash: "move", phish: "report:phishing", accept: "invite", decline: "invite", tentative: "invite", removeDeclined: "invite:remove", unsub: "unsubscribe", sweep: SWEEP.fam }[a]);
const DONE = {
  archive: "Archiviert", junk: "In Spam verschoben", trash: "In den Papierkorb gelegt", phish: "Als Phishing beim Anbieter gemeldet",
  accept: "Zugesagt", decline: "Abgesagt", tentative: "Mit Vielleicht geantwortet", removeDeclined: "Abgesagte Einladung entfernt", unsub: "Abgemeldet",
  sweep: `${SWEEP.count} Mails archiviert`,
};
const UNDOABLE = new Set(["archive", "junk", "trash", "phish", "removeDeclined", "sweep"]);
const FOLDER = { archive: "Archiv", junk: "Spam", trash: "Papierkorb", phish: "Spam", sweep: "Archiv", removeDeclined: "gelöschte Termine" };

function receipt(mail, a, status, extra) {
  M.receipts.unshift({ id: "r" + ++M.n, mail: mail ? mail.id : null, title: `${DONE[a]}${mail ? `: «${mail.subj}»` : ""}`, a, status, ...extra });
}
/* One attempt, as the host would run it after authority is settled. The simulation decides the provider's answer. */
function run(a, mail) {
  if (M.sim === "denied") return receipt(mail, a, "denied", { text: `Das Konto ${CONN} ist für diese Aktion nicht freigegeben. Nichts wurde ausgeführt.` });
  if (M.sim === "missing") return receipt(mail, a, "missing", { text: "Die Mail ist beim Anbieter nicht mehr da. Nichts wurde ausgeführt, und es gibt keinen neuen Versuch." });
  if (M.sim === "unclear") return receipt(mail, a, "unclear", { text: "Der Anbieter hat nicht geantwortet. Vielleicht ist es passiert. Threva prüft das, bevor es mit dieser Mail etwas anderes tut." });
  settle(mail, a);
  receipt(mail, a, "done", { undo: UNDOABLE.has(a) });
}
function settle(mail, a) {
  if (a === "sweep") { M.sweep = "done"; return; }
  if (!mail) return;
  if (a === "decline") { M.state[mail.id] = "declined"; return; }
  if (a === "accept" || a === "tentative" || a === "unsub") { M.state[mail.id] = a; return; }
  M.gone.add(mail.id);
}
function press(a, id) {
  const mail = MAILS.find((m) => m.id === id) || null, fam = famOf(a);
  if (!fam) {
    if (a === "phishDraft") { receipt(mail, "phish", "draft", { title: `Meldung als Entwurf: «${mail.subj}»`, text: "Liegt in deinen Entwürfen mit der Mail im Anhang. Senden musst du selbst. Dafür braucht es keine Erlaubnis." }); M.state[mail.id] = "drafted"; }
    return;
  }
  if (M.grants.has(fam)) return run(a, mail);
  M.ask = { a, id, fam };
}
function answer(how) {
  const q = M.ask; M.ask = null; if (!q || how === "cancel") { M.toast = "Abgebrochen. Nichts ist passiert."; return; }
  if (how === "always") M.grants.add(q.fam);
  run(q.a, MAILS.find((m) => m.id === q.id) || null);
}
function undo(rid) {
  const r = M.receipts.find((x) => x.id === rid); if (!r || r.status !== "done" || r.undone) return;
  if (M.sim === "moved") { r.conflict = `Die Mail liegt nicht mehr im ${FOLDER[r.a]}, sondern im Ordner «Projekte». Jemand hat sie seither verschoben. Threva überschreibt das nicht, nichts wurde zurückgeholt.`; return; }
  if (M.sim === "missing") { r.conflict = "Die Mail ist beim Anbieter nicht mehr da. Nichts wurde zurückgeholt, und es gibt keinen neuen Versuch."; return; }
  if (M.sim === "denied") { r.conflict = `Das Konto ${CONN} ist für diese Aktion nicht freigegeben. Nichts wurde zurückgeholt.`; return; }
  r.undone = true;
  if (r.a === "sweep") M.sweep = false;
  else if (r.mail) { M.gone.delete(r.mail); if (r.a === "removeDeclined") M.state[r.mail] = "declined"; }
  M.toast = r.a === "phish" ? "Die Mail ist zurück im Posteingang. Die Meldung beim Anbieter bleibt bestehen." : "Rückgängig. Die Mail ist zurück, wo sie war.";
}
function check(rid) {
  const r = M.receipts.find((x) => x.id === rid); if (!r) return;
  const mail = MAILS.find((m) => m.id === r.mail) || null;
  settle(mail, r.a); r.status = "done"; r.undo = UNDOABLE.has(r.a); r.text = "Geprüft: Es ist passiert.";
}

const btn = (a, id, label, cls = "") => `<button class="btn ${cls}" data-m="${a}" data-id="${id || ""}">${label}</button>`;
function askBox(fam) {
  const f = FAM[fam] || { label: SWEEP.label, note: "Deine Ein-Klick-Erlaubnis für einzelne Mails gilt hier nicht. Diese Erlaubnis deckt nur genau diese Auswahl." };
  return `<div class="ivy ask"><span class="from">Threva fragt, bevor etwas passiert · Konto ${CONN}</span>
    <p><b>${esc(f.label)}</b></p>${f.warn ? `<p class="warnline">${esc(f.warn)}</p>` : ""}${f.note ? `<p class="faint">${esc(f.note)}</p>` : ""}
    <div class="row">${btn("always", "", "Ja, ab jetzt mit einem Klick", "pri")}${btn("once", "", "Nur dieses Mal")}${btn("cancel", "", "Abbrechen", "quiet")}</div></div>`;
}
const here = (a, id) => M.ask && M.ask.id === (id || "") && famOf(M.ask.a) === famOf(a);
function mailCard(m) {
  if (M.gone.has(m.id)) return "";
  const st = M.state[m.id];
  let actions, pill = "";
  if (m.kind === "news") {
    actions = [btn("archive", m.id, "Archivieren", "pri"), btn("trash", m.id, "Löschen"), st === "unsub" ? "" : btn("unsub", m.id, "Abmelden")].join("");
    if (st === "unsub") pill = `<span class="pill ok">abgemeldet</span>`;
  } else if (m.kind === "phish") {
    actions = [btn("phish", m.id, "Beim Anbieter melden", "pri"), st === "drafted" ? "" : btn("phishDraft", m.id, "Als Entwurf melden"), btn("junk", m.id, "Spam")].join("");
    pill = `<span class="pill wait">verdächtig</span>`;
  } else {
    actions = st === "declined" ? btn("removeDeclined", m.id, "Abgesagte Einladung entfernen")
      : st ? "" : [btn("accept", m.id, "Zusagen", "pri"), btn("tentative", m.id, "Vielleicht"), btn("decline", m.id, "Absagen")].join("");
    if (st) pill = `<span class="pill calm">${{ accept: "zugesagt", tentative: "vielleicht", declined: "abgesagt" }[st]}</span>`;
  }
  const ask = M.ask && M.ask.id === m.id ? askBox(M.ask.fam) : "";
  return `<div class="card"><span class="row" style="justify-content:space-between"><span class="eyebrow">Mail · ${esc(m.from)}</span>${pill}</span>
    <span class="q">${esc(m.subj)}</span><span class="sub">${esc(m.gist)}</span>
    <div class="row">${actions}</div>${ask}</div>`;
}
function sweepCard() {
  if (M.sweep === "done") return "";
  const sample = ["Wochenrückblick KW 45", "Wochenrückblick KW 44", "Sonderausgabe: Patchday", "Wochenrückblick KW 43"];
  return `<div class="card"><span class="row" style="justify-content:space-between"><span class="eyebrow">Aufräumen · Vorschau</span><span class="pill think">${SWEEP.count} Mails</span></span>
    <span class="q">Alle ${SWEEP.count} Mails von Wochenbrief Sicherheit archivieren, die älter als 7 Tage sind?</span>
    <span class="sub">Auswahl: Absender Wochenbrief Sicherheit · älter als 7 Tage · nur Posteingang. Betroffen sind genau diese ${SWEEP.count} Mails, keine weiteren.</span>
    <ul class="plain faint">${sample.map((s) => `<li>${esc(s)}</li>`).join("")}<li>… und ${SWEEP.count - sample.length} weitere</li></ul>
    <div class="row">${btn("sweep", "", `${SWEEP.count} archivieren`, "pri")}</div>${M.ask && M.ask.a === "sweep" ? askBox(SWEEP.fam) : ""}</div>`;
}
const STATUS = { done: ["ok", "erledigt"], draft: ["calm", "Entwurf"], denied: ["wait", "verweigert"], missing: ["wait", "nicht gefunden"], unclear: ["wait", "unklar"] };
function receiptsBox() {
  if (!M.receipts.length) return `<p class="faint">Noch nichts. Jeder Versuch bekommt hier eine Quittung, auch ein misslungener.</p>`;
  return M.receipts.map((r) => {
    const [cls, word] = r.conflict ? ["wait", "Konflikt"] : r.undone ? ["calm", "rückgängig"] : STATUS[r.status];
    const tail = r.conflict ? `<span class="faint">${esc(r.conflict)}</span>`
      : r.undone ? (r.a === "phish" ? `<span class="faint">Die Mail ist zurück. Die Meldung beim Anbieter bleibt bestehen.</span>` : "")
      : r.text ? `<span class="faint">${esc(r.text)}</span>` : (!r.undo && r.status === "done" ? `<span class="faint">${r.a === "unsub" ? "Kein Rückgängig: Das Abo beim Absender ist geändert." : "Kein Rückgängig: Der Organisator ist benachrichtigt."}</span>` : "");
    const act = r.status === "unclear" ? btn("check", r.id, "Jetzt prüfen") : r.status === "done" && r.undo && !r.undone && !r.conflict ? btn("undo", r.id, "Rückgängig", "quiet") : "";
    return `<div class="vrow"><span class="stack" style="gap:2px"><span>${esc(r.title)}</span>${tail}</span><span class="pill ${cls}">${word}</span><span>${act}</span></div>`;
  }).join("");
}
function grantsBox() {
  if (!M.grants.size) return `<p class="faint">Keine. Ohne Erlaubnis fragt Threva bei jedem Klick.</p>`;
  return [...M.grants].map((g) => `<div class="vrow"><span>${esc((FAM[g] || { label: SWEEP.label }).label)}</span><span class="faint">Konto ${CONN}</span><span>${btn("revoke", g, "Entziehen", "quiet")}</span></div>`).join("");
}
function mailView() {
  return `<div class="cols mailproto">
    <div class="stack">${M.toast ? `<div class="toast">${esc(M.toast)}</div>` : ""}${MAILS.map(mailCard).join("")}${sweepCard()}</div>
    <div class="stack"><span class="eyebrow">Quittungen</span>${receiptsBox()}<span class="eyebrow" style="margin-top:12px">Erlaubnisse mit einem Klick</span>${grantsBox()}</div></div>`;
}
function mailAct(a, id) {
  M.toast = "";
  if (a === "always" || a === "once" || a === "cancel") return answer(a);
  if (a === "undo") return undo(id);
  if (a === "check") return check(id);
  if (a === "revoke") { M.grants.delete(id); M.toast = "Entzogen. Ab dem nächsten Klick fragt Threva wieder. Die Quittungen bleiben."; return; }
  if (here(a, id)) { M.ask = null; return; }
  press(a, id);
}
