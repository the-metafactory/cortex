const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const zone = "Europe/Zurich";
const DEMO = new Date(Date.UTC(2026, 10, 2));
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MON_DAYS = [1, 2, 3, 4, 5, 6, 0];
const COMBINED = document.body.dataset.layout === "combined";
const VARIANTS = { D: "Schedule + workspace", A: "Schedule first", B: "Routine workspace", C: "Agenda first" };
const glyphs = {
  calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4m8-4v4"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  pause: '<path d="M9 5v14m6-14v14"/>',
  play: '<path d="m8 5 11 7-11 7z"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>',
  log: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyphs[name] ?? glyphs.clock}</svg>`;
const baseRoutines = [
  { id: "briefing", title: "Morning briefing", description: "A short view of your calendar, priorities and overnight agent work.", days: [1, 2, 3, 4, 5], time: "07:30", category: "Work", color: "#5476c7", tint: "#edf1fc", policy: "auto", steps: ["Read calendar and priorities", "Summarize what matters", "Prepare your briefing"] },
  { id: "inbox", title: "Inbox sweep", description: "Review unread messages and prepare the replies that need you.", days: [1, 2, 3, 4, 5], time: "09:00", category: "Work", color: "#8b73b7", tint: "#f1edf9", policy: "approval", pending: true, steps: ["Read unread messages", "Classify and group", "Prepare reply drafts"] },
  { id: "agents", title: "Agent check-in", description: "Collect progress, blockers and decisions from your active work.", days: [0, 1, 2, 3, 4, 5, 6], time: "12:00", category: "Work", color: "#4a8a87", tint: "#eaf4f3", policy: "auto", steps: ["Read active work", "Collect meaningful changes", "Update the Desk"] },
  { id: "notes", title: "Field notes", description: "Gather the week's useful changes into a draft you can review.", days: [3, 5], time: "16:00", category: "Creative", color: "#bd9456", tint: "#fbf2e5", policy: "approval", steps: ["Collect recent changes", "Choose a narrative", "Save a draft"] },
  { id: "timesheet", title: "Friday timesheet", description: "Prepare a proposed booking from this week's meetings and work.", days: [5], time: "17:00", category: "Work", color: "#8773aa", tint: "#f2eef8", policy: "approval", steps: ["Read this week's work", "Group time by project", "Prepare a booking proposal"] },
  { id: "review", title: "Weekly review", description: "Make room for next week by reflecting on this one.", days: [0], time: "18:00", category: "Personal", color: "#638b70", tint: "#edf4ec", policy: "approval", steps: ["Collect the week's outcomes", "Notice loose ends", "Prepare next week's outline"] },
  { id: "backup", title: "Nightly backup", description: "Save a verified snapshot of your working notes and configuration.", days: [0, 1, 2, 3, 4, 5, 6], time: "21:00", category: "Work", color: "#7a8799", tint: "#eef1f5", policy: "auto", steps: ["Collect changed files", "Write encrypted snapshot", "Verify the snapshot"] },
  { id: "reading", title: "Reading list", description: "Collect the articles and references you saved during the week.", days: [6], time: "10:00", category: "Personal", color: "#6c927a", tint: "#edf5ef", policy: "auto", paused: true, steps: ["Read saved references", "Group by topic", "Prepare a reading list"] },
];
function dateKey(date) { return date.toISOString().slice(0, 10); }
function plusDays(date, days) { const next = new Date(date); next.setUTCDate(next.getUTCDate() + days); return next; }
function partsAt(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
}
function instantFor(date, time, timeZone = zone) {
  const [hour, minute] = time.split(":").map(Number);
  const nominal = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute);
  let value = nominal;
  for (let index = 0; index < 3; index++) {
    const p = partsAt(new Date(value), timeZone);
    const rendered = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
    const corrected = value + nominal - rendered;
    if (corrected === value) break;
    value = corrected;
  }
  return new Date(value);
}
const NOW = instantFor(DEMO, "10:20");
function formatDate(date, options = { day: "numeric", month: "short" }) { return new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options }).format(date); }
function formatRunDate(value) {
  const p = partsAt(new Date(value), zone);
  const key = `${p.year}-${p.month}-${p.day}`;
  const prefix = key === dateKey(DEMO) ? "Today" : key === dateKey(plusDays(DEMO, -1)) ? "Yesterday" : formatDate(new Date(`${key}T00:00:00Z`));
  return `${prefix}, ${p.hour}:${p.minute}`;
}
function seedState() {
  const routines = structuredClone(baseRoutines).map((r) => ({ ...r, timezone: zone, paused: Boolean(r.paused), deleted: false }));
  const runs = [];
  for (const r of routines) {
    let count = 0;
    for (let offset = 0; offset > -20 && count < 4; offset--) {
      const day = plusDays(DEMO, offset);
      const at = instantFor(day, r.time, r.timezone);
      if (!r.days.includes(day.getUTCDay()) || at > NOW || (r.pending && offset === 0)) continue;
      const status = r.id === "backup" && count === 0 ? "failed" : r.id === "inbox" && count === 2 ? "denied" : "succeeded";
      runs.push({ id: `${r.id}-${count}`, routineId: r.id, at: at.toISOString(), status, duration: status === "denied" ? "—" : status === "failed" ? "8s" : ["24s", "31s", "19s", "27s"][count], trigger: status === "denied" ? "Denied by you" : r.policy === "auto" ? "Automatic" : "Approved by you" });
      count++;
    }
  }
  return { routines, runs, variant: COMBINED ? "D" : new URLSearchParams(location.search).get("variant") in VARIANTS ? new URLSearchParams(location.search).get("variant") : "A", selected: routines.some((r) => r.id === new URLSearchParams(location.search).get("routine")) ? new URLSearchParams(location.search).get("routine") : "briefing", range: ["day", "week", "month"].includes(new URLSearchParams(location.search).get("view")) ? new URLSearchParams(location.search).get("view") : "week", date: new Date(DEMO), focusDate: new Date(DEMO), tab: "overview", workspace: COMBINED && new URLSearchParams(location.search).get("tab") !== "workspace" ? "calendar" : "routine", category: "All", showPaused: true, query: "", drawer: false, modal: null, deletedTitle: "", draft: null, logFile: "execution.log", logWrap: true };
}
let state = seedState();
const liveRoutines = () => state.routines.filter((r) => !r.deleted);
const routine = (id = state.selected) => state.routines.find((r) => r.id === id);
const history = (id) => state.runs.filter((run) => !id || run.routineId === id).sort((a, b) => b.at.localeCompare(a.at));
const statusLabel = (value) => ({ succeeded: "Completed", failed: "Failed", denied: "Denied · not run", running: "Dispatched" }[value]);
const statusSymbol = (value) => ({ succeeded: "✓", failed: "!", denied: "–", running: "↗" }[value]);
function scheduleWords(r) {
  const sorted = [...r.days].sort((a, b) => MON_DAYS.indexOf(a) - MON_DAYS.indexOf(b));
  const when = sorted.length === 7 ? "Every day" : sorted.join(",") === "1,2,3,4,5" ? "Every weekday" : sorted.length === 1 ? `Every ${new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(plusDays(new Date(Date.UTC(2026, 10, 1)), sorted[0]))}` : sorted.map((day) => DAY_NAMES[day]).join(", ");
  return `${when} at ${r.time}`;
}
function nextOccurrences(r, maximum = 3) {
  const result = [];
  for (let offset = 0; offset < 50 && result.length < maximum; offset++) {
    const day = plusDays(DEMO, offset);
    if (!r.days.includes(day.getUTCDay())) continue;
    const at = instantFor(day, r.time, r.timezone);
    if (at <= NOW) continue;
    result.push(at);
  }
  return result;
}
function eventsForDay(day, filtered = true) {
  const events = [];
  for (const r of liveRoutines()) {
    if (filtered && ((state.category !== "All" && state.category !== r.category) || (!state.showPaused && r.paused))) continue;
    for (const offset of [-1, 0, 1]) {
      const candidate = plusDays(day, offset);
      if (!r.days.includes(candidate.getUTCDay())) continue;
      const instant = instantFor(candidate, r.time, r.timezone);
      const p = partsAt(instant, zone);
      if (`${p.year}-${p.month}-${p.day}` !== dateKey(day)) continue;
      events.push({ r, instant, time: `${p.hour}:${p.minute}`, minutes: Number(p.hour) * 60 + Number(p.minute) });
    }
  }
  return events.sort((a, b) => a.minutes - b.minutes);
}
function rangeDays() {
  if (state.range === "day") return [state.date];
  if (state.range === "week") {
    const start = plusDays(state.date, -((state.date.getUTCDay() + 6) % 7));
    return Array.from({ length: 7 }, (_, i) => plusDays(start, i));
  }
  const first = new Date(Date.UTC(state.date.getUTCFullYear(), state.date.getUTCMonth(), 1));
  const start = plusDays(first, -((first.getUTCDay() + 6) % 7));
  const count = new Date(Date.UTC(state.date.getUTCFullYear(), state.date.getUTCMonth() + 1, 0)).getUTCDate();
  return Array.from({ length: Math.ceil((((first.getUTCDay() + 6) % 7) + count) / 7) * 7 }, (_, i) => plusDays(start, i));
}
function heading() {
  if (state.range === "month") return formatDate(state.date, { month: "long", year: "numeric" });
  if (state.range === "day") return formatDate(state.date, { weekday: "long", day: "numeric", month: "long" });
  const days = rangeDays();
  return `${days[0].getUTCDate()}–${formatDate(days.at(-1), { day: "numeric", month: "long", year: "numeric" })}`;
}
function toolbar() {
  return `<div class="toolbar"><div class="row"><div class="navbuttons"><button class="iconbutton" data-action="period" data-delta="-1" aria-label="Previous ${state.range}">‹</button><button class="iconbutton" data-action="period" data-delta="1" aria-label="Next ${state.range}">›</button></div><h2>${heading()}</h2><button class="quiet tiny" data-action="today">Today</button></div><div class="row"><span class="timezone">${zone}</span><div class="seg" aria-label="Calendar range">${["day", "week", "month"].map((value) => `<button data-action="range" data-value="${value}" class="${state.range === value ? "active" : ""}" aria-pressed="${state.range === value}">${value[0].toUpperCase() + value.slice(1)}</button>`).join("")}</div></div></div>`;
}
function filters() {
  return `<div class="filters">${["All", "Work", "Creative", "Personal"].map((category) => `<button class="${state.category === category ? "active" : ""}" data-action="category" data-value="${category}">${category}</button>`).join("")}<label><input id="show-paused" type="checkbox" ${state.showPaused ? "checked" : ""}>Show paused</label></div>`;
}
function calendar(density = false) {
  const days = rangeDays();
  const countedDays = state.range === "month" ? days.filter((day) => day.getUTCMonth() === state.date.getUTCMonth()) : days;
  const number = countedDays.flatMap((day) => eventsForDay(day)).filter((e) => !e.r.paused).length;
  if (state.range === "month") {
    return `<div class="calendar-card ${density ? "c-month" : ""}"><div class="month-head">${MON_DAYS.map((d) => `<span>${DAY_NAMES[d]}</span>`).join("")}</div><div class="month-grid">${days.map((day) => {
      const events = eventsForDay(day);
      const active = events.filter((e) => !e.r.paused);
      const isToday = dateKey(day) === dateKey(DEMO);
      return `<div class="month-cell ${day.getUTCMonth() !== state.date.getUTCMonth() ? "out" : ""} ${isToday ? "today" : ""}"><button class="datebutton" data-action="${density ? "focus-day" : "open-day"}" data-date="${dateKey(day)}" aria-label="${formatDate(day, { day: "numeric", month: "long" })}">${day.getUTCDate()}</button>${density ? `<button class="density level-${Math.min(active.length, 6)}" data-action="focus-day" data-date="${dateKey(day)}">${active.length} runs</button>` : events.slice(0, 3).map((e) => `<button class="month-event ${e.r.paused ? "paused" : ""}" style="--color:${e.r.color};--tint:${e.r.tint}" data-action="select" data-id="${e.r.id}" title="${esc(e.r.title)} · ${e.time}">${e.time} ${esc(e.r.title)}</button>`).join("") + (events.length > 3 ? `<button class="month-more" data-action="open-day" data-date="${dateKey(day)}">+${events.length - 3} more</button>` : "")}</div>`;
    }).join("")}</div><div class="calendar-foot"><span>${number} scheduled in ${formatDate(state.date, { month: "long" })} · ${zone}</span><span>${density ? "Choose a date to see its agenda" : "Choose a date or routine"}</span></div></div>`;
  }
  const allEvents = days.flatMap((day) => eventsForDay(day));
  const start = Math.min(6, ...allEvents.map((e) => Math.floor(e.minutes / 60)));
  const end = Math.max(22, ...allEvents.map((e) => Math.ceil((e.minutes + 30) / 60)));
  const height = (end - start) * 38;
  return `<div class="calendar-card"><div class="calendar-head ${state.range === "day" ? "day" : ""}"><div></div>${days.map((day) => `<div class="daylabel ${dateKey(day) === dateKey(DEMO) ? "today" : ""}">${DAY_NAMES[day.getUTCDay()]}<strong>${day.getUTCDate()}</strong></div>`).join("")}</div><div class="time-grid ${state.range === "day" ? "day" : ""}"><div class="time-axis" style="height:${height}px">${Array.from({ length: end - start }, (_, i) => `<span style="top:${i * 38 + 8}px">${String(i + start).padStart(2, "0")}:00</span>`).join("")}</div>${days.map((day) => {
    const events = eventsForDay(day);
    return `<div class="time-day ${dateKey(day) === dateKey(DEMO) ? "today" : ""}" style="height:${height}px">${events.map((e, index) => {
      const nearby = events.filter((other) => Math.abs(other.minutes - e.minutes) < 57);
      const lane = nearby.findIndex((other) => other.r.id === e.r.id);
      const laneStyle = nearby.length > 1 ? `left:calc(${lane * 100 / nearby.length}% + 3px);width:calc(${100 / nearby.length}% - 5px);right:auto;` : "";
      return `<button class="cal-event ${state.selected === e.r.id ? "selected" : ""} ${e.r.paused ? "paused" : ""}" style="--color:${e.r.color};--tint:${e.r.tint};top:${(e.minutes - start * 60) * 38 / 60}px;${laneStyle}" data-action="select" data-id="${e.r.id}" aria-label="${esc(e.r.title)}, ${DAY_NAMES[day.getUTCDay()]} ${e.time}${e.r.paused ? ", paused" : ""}"><time>${e.time}${e.r.pending && dateKey(day) === dateKey(DEMO) ? " · ◉" : ""}</time><strong>${esc(e.r.title)}</strong></button>`;
    }).join("")}${dateKey(day) === dateKey(DEMO) && 620 >= start * 60 && 620 < end * 60 ? `<div class="nowline" style="top:${(620 - start * 60) * 38 / 60}px" title="Demo time: 10:20"></div>` : ""}</div>`;
  }).join("")}</div><div class="calendar-foot"><div class="row"><span>${number} scheduled occurrences</span><span>◉ Waiting for approval</span></div><span>Striped = paused · no future run</span></div></div>`;
}
function handlingText(r) { return r.policy === "auto" ? "Handled automatically" : "Asks before each run"; }
function actions(r) {
  return `<div class="inspect-actions"><button data-action="schedule" data-id="${r.id}">${icon("calendar")} Edit schedule</button><button data-action="${r.paused ? "resume" : "pause"}" data-id="${r.id}">${icon(r.paused ? "play" : "pause")} ${r.paused ? "Resume" : "Pause"}</button><button class="quiet danger" data-action="delete" data-id="${r.id}" aria-label="Delete ${esc(r.title)}">${icon("trash")}</button></div>`;
}
function pendingCard(r) {
  if (!r.pending) return "";
  return `<div class="pending-card"><div class="row"><span class="run-status" style="background:#faf0dc;color:#ad8750">?</span><h3>This run needs your approval</h3></div><p>Requested today at ${r.time}. Review the flow before allowing this run.</p><div class="row"><button class="primary" data-action="decide" data-id="${r.id}" data-value="approve">Approve this run</button><button data-action="decide" data-id="${r.id}" data-value="deny">Deny</button></div></div>`;
}
function handlingCard(r) {
  return `<div class="handling-card"><div><small>Handling policy</small><h3>${handlingText(r)}</h3></div><button class="link tiny" data-action="policy" data-id="${r.id}">${r.policy === "auto" ? "Stop automatic handling" : "Handle this yourself"}</button></div>`;
}
function flow(r) {
  return `<div>${r.steps.map((step, index) => `<div class="flow-step"><span class="step-num">${index + 1}</span><div><strong>${esc(step)}</strong><small>${["Read the configured sources", "Use the previous step's result", "Keep the result available on your Desk"][index] ?? "Continue the flow"}</small></div></div>`).join("")}</div>`;
}
function runRows(r, limit = 4) {
  const rows = history(r.id).slice(0, limit);
  return rows.length ? rows.map((run) => `<button class="run-row" data-action="run" data-run="${run.id}"><span class="run-status ${run.status}">${statusSymbol(run.status)}</span><div class="run-text"><strong>${formatRunDate(run.at)}</strong><small>${statusLabel(run.status)} · ${run.duration} · ${run.trigger}</small></div>${icon("log")}<span class="run-arrow">›</span></button>`).join("") : '<div class="empty">No executions yet. The first run will appear here.</div>';
}
function nextRuns(r) {
  return `<div>${r.paused ? '<div class="paused-banner">Paused. No future runs will be requested until you resume.</div>' : ""}${nextOccurrences(r).map((at) => `<div class="next-run"><span>${formatRunDate(at)}</span><span>${r.paused ? "If resumed" : r.policy === "auto" ? "Automatic" : "Will ask first"}</span></div>`).join("")}</div>`;
}
function scheduleDetail(r) {
  return `${r.paused ? '<div class="paused-banner">This routine is paused. Its schedule and handling policy are saved.</div>' : ""}<div class="schedule-summary"><div><p>${scheduleWords(r)}</p><small>${r.timezone}</small></div><button class="link tiny" data-action="schedule" data-id="${r.id}">Edit</button></div>${handlingCard(r)}<div class="section-title"><h3>Next occurrences${r.paused ? " if resumed" : ""}</h3></div>${nextRuns(r)}<div class="hint">Schedule changes affect future runs. Previous execution records and logs are kept.</div>`;
}
function inspectorContent(r) {
  if (state.tab === "schedule") return scheduleDetail(r);
  if (state.tab === "flow") return `<div class="section-title"><h3>Installed flow</h3><small>3 steps</small></div>${flow(r)}<div class="hint">Selecting an execution shows the flow and log files for that specific run.</div>`;
  if (state.tab === "executions") return `<div class="section-title"><h3>Recent executions</h3><small>Last ${history(r.id).length}</small></div>${runRows(r, 8)}<p class="day-note">Execution times shown in ${zone}.</p>`;
  return `${pendingCard(r)}${r.paused ? '<div class="paused-banner">Paused · no new scheduled runs</div>' : ""}<div class="schedule-summary"><div><p>${scheduleWords(r)}</p><small>${r.timezone}</small></div>${icon("calendar")}</div>${handlingCard(r)}<div class="section-title"><h3>Recent executions</h3><button class="link tiny" data-action="detail-tab" data-value="executions">View all</button></div>${runRows(r, 3)}<div class="section-title"><h3>Flow</h3><button class="link tiny" data-action="detail-tab" data-value="flow">Inspect</button></div>${flow(r)}`;
}
function detailTabs(className = "tabs") {
  return `<div class="${className}" aria-label="Routine detail">${["overview", "schedule", "flow", "executions"].map((tab) => `<button class="${state.tab === tab ? "active" : ""}" data-action="detail-tab" data-value="${tab}">${tab[0].toUpperCase() + tab.slice(1)}</button>`).join("")}</div>`;
}
function inspector() {
  const r = routine();
  if (!r || r.deleted) return '<aside class="inspector"><div class="empty">Select a routine on the calendar to inspect it.</div></aside>';
  return `<aside class="inspector" aria-label="Selected routine"><div class="inspect-title"><div class="row between"><div class="category"><span class="dot" style="--color:${r.color}"></span>${r.category}</div><span class="pill ${r.paused ? "amber" : "green"}">${r.paused ? "Paused" : "Active"}</span></div><h2>${esc(r.title)}</h2><p class="tiny muted">${esc(r.description)}</p>${actions(r)}</div>${detailTabs()}<div class="inspect-body">${inspectorContent(r)}</div></aside>`;
}
function routineItem(r) {
  return `<button class="routine-item ${state.selected === r.id ? "selected" : ""} ${r.paused ? "paused" : ""}" data-action="select" data-id="${r.id}"><span class="dot" style="--color:${r.color}"></span><span><strong>${esc(r.title)}${r.pending ? ' <span style="color:#b18d51">◉</span>' : ""}</strong><small>${r.paused ? "Paused · " : ""}${scheduleWords(r).replace("Every ", "")}</small></span></button>`;
}
function runTable(id) {
  const runs = history(id);
  if (!runs.length) return '<div class="empty">No executions yet.</div>';
  return `<table class="run-table"><thead><tr>${!id ? "<th>Routine</th>" : ""}<th>Started</th><th>Outcome</th><th>Duration</th><th></th></tr></thead><tbody>${runs.map((run) => `<tr tabindex="0" role="button" data-action="run" data-run="${run.id}" aria-label="${esc(routine(run.routineId)?.title)} ${formatRunDate(run.at)} ${statusLabel(run.status)}">${!id ? `<td>${esc(routine(run.routineId)?.title)}${routine(run.routineId)?.deleted ? ' <small>Deleted</small>' : ""}</td>` : ""}<td>${formatRunDate(run.at)}<br><small>${run.trigger}</small></td><td><span class="pill ${run.status === "failed" ? "red" : run.status === "succeeded" ? "green" : ""}">${statusLabel(run.status)}</span></td><td>${run.duration}</td><td>${icon("log")} <span class="tiny">Logs</span></td></tr>`).join("")}</tbody></table>`;
}
function workspaceDetail(r) {
  if (!r) return '<div class="empty">Choose a routine.</div>';
  return `<div class="workspace-top"><div><div class="row" style="margin-bottom:10px"><span class="dot" style="--color:${r.color}"></span><span class="eyebrow">${r.category}</span><span class="pill ${r.paused ? "amber" : "green"}">${r.paused ? "Paused" : "Active"}</span></div><h2>${esc(r.title)}</h2><p class="workspace-description">${esc(r.description)}</p></div>${actions(r)}</div>${detailTabs("workspace-tabs")}<div class="workspace-columns"><div class="inspect-body">${state.tab === "executions" ? `<div class="section-title"><h3>Execution history</h3><small>${zone}</small></div>${runTable(r.id)}` : state.tab === "overview" ? `${pendingCard(r)}${handlingCard(r)}<div class="section-title"><h3>Flow</h3><button class="link tiny" data-action="detail-tab" data-value="flow">Inspect flow</button></div>${flow(r)}<div class="workspace-section"><div class="section-title"><h3>Recent executions</h3><button class="link tiny" data-action="detail-tab" data-value="executions">All executions</button></div>${runRows(r, 3)}</div>` : inspectorContent(r)}</div><aside class="next-panel"><div class="row between"><h3>${r.paused ? "Saved schedule" : "Next up"}</h3>${icon("calendar")}</div><p>${scheduleWords(r)}<br>${r.timezone}</p><div style="margin-top:15px">${nextRuns(r)}</div><button class="link tiny" style="margin-top:16px" data-action="schedule" data-id="${r.id}">Edit schedule</button><div class="hint">${r.policy === "auto" ? "Future runs are handled automatically." : "Each occurrence creates a request for your approval."}</div></aside></div>`;
}
function variantA() {
  return `<div class="a-layout"><div class="a-main">${toolbar()}<div class="toolbar" style="margin-bottom:13px">${filters()}</div>${calendar()}<div class="a-legend">${["Work", "Creative", "Personal"].map((category) => `<span class="row"><span class="dot" style="--color:${{ Work: "#6d88c4", Creative: "#bd9456", Personal: "#6c927a" }[category]}"></span>${category}</span>`).join("")}<span style="margin-left:auto">Choose an occurrence to manage its routine</span></div></div>${inspector()}</div>`;
}
function variantB() {
  return `<div class="b-layout"><aside class="library"><div class="library-head"><h3>Your routines</h3><small>${liveRoutines().length}</small></div><div class="search">${icon("search")}<input id="routine-search" aria-label="Find a routine" placeholder="Find a routine…" value="${esc(state.query)}"></div><div class="library-list">${liveRoutines().filter((r) => r.title.toLowerCase().includes(state.query.toLowerCase())).map(routineItem).join("") || '<div class="empty">No matching routines.</div>'}</div></aside><main class="workspace">${state.workspace === "calendar" ? `${toolbar()}<div style="margin-bottom:14px">${filters()}</div>${calendar()}` : workspaceDetail(routine())}</main></div>`;
}
function eventStatus(event) {
  if (event.r.paused) return "Paused · will not run";
  if (event.r.pending && dateKey(state.focusDate) === dateKey(DEMO)) return "Waiting for your approval";
  const actual = state.runs.find((run) => run.routineId === event.r.id && (run.scheduledFor ?? run.at) === event.instant.toISOString());
  if (actual) return statusLabel(actual.status);
  return event.instant < NOW ? "Past scheduled occurrence" : event.r.policy === "auto" ? "Will run automatically" : "Will ask you first";
}
function variantC() {
  const days = rangeDays();
  let focus = state.range === "day" ? state.date : state.focusDate;
  if (!days.some((day) => dateKey(day) === dateKey(focus))) focus = days.find((day) => day.getUTCMonth() === state.date.getUTCMonth()) ?? days[0];
  state.focusDate = new Date(focus);
  const events = eventsForDay(focus);
  const activeCount = events.filter((e) => !e.r.paused).length;
  return `<div class="c-top"><div class="briefing"><div class="eyebrow" style="margin-bottom:10px">Your routines, in time</div><h2><strong>${eventsForDay(DEMO, false).filter((e) => !e.r.paused).length} runs today.</strong> A quiet view of what happens next.</h2><p>Keep the rhythm. Open any routine to change its schedule, handling or future runs.</p></div><div class="health-note"><span class="run-status failed">!</span><div><h3>One run needs a look</h3><p>Nightly backup failed yesterday. Your notes are unchanged.</p><button class="link tiny" style="margin-top:9px" data-action="run" data-run="backup-0">Read the execution log →</button></div></div></div>${toolbar()}<div style="margin:0 0 18px">${filters()}</div>${state.range === "week" ? `<div class="daystrip">${days.map((day) => { const count = eventsForDay(day).filter((e) => !e.r.paused).length; return `<button class="daytile ${dateKey(day) === dateKey(focus) ? "selected" : ""}" data-action="focus-day" data-date="${dateKey(day)}"><span class="eyebrow">${DAY_NAMES[day.getUTCDay()]}</span><strong>${day.getUTCDate()}</strong><div class="minibar"><i style="width:${count * 17}%"></i></div><small>${count} runs</small></button>`; }).join("")}</div>` : state.range === "month" ? calendar(true) : ""}<div class="c-layout"><main><div class="agenda-group"><div class="agenda-date"><span>${dateKey(focus) === dateKey(DEMO) ? "TODAY · " : ""}${formatDate(focus, { weekday: "long", day: "numeric", month: "long" })}</span><span>${activeCount} scheduled</span></div>${events.map((e) => `<div class="agenda-item ${e.r.paused ? "paused" : ""}"><time>${e.time}</time><div><button class="title-button" data-action="select" data-id="${e.r.id}"><span class="dot" style="--color:${e.r.color}"></span>${esc(e.r.title)}</button><p>${eventStatus(e)}${e.r.pending && dateKey(focus) === dateKey(DEMO) ? ' <span class="pill amber">Decision needed</span>' : ""}</p></div><button class="quiet" data-action="select" data-id="${e.r.id}">View →</button></div>`).join("") || '<div class="empty">Nothing scheduled here. Enjoy the space.</div>'}</div><p class="day-note">Times in ${zone}. Paused occurrences stay visible when “Show paused” is on.</p></main><aside class="c-rail"><h3>Routine library</h3>${liveRoutines().map(routineItem).join("")}<div class="workspace-section"><h3>Recently finished</h3>${history().filter((run) => run.status === "succeeded").slice(0, 2).map((run) => `<button class="run-row" data-action="run" data-run="${run.id}"><span class="run-status">✓</span><div class="run-text"><strong>${esc(routine(run.routineId).title)}</strong><small>${formatRunDate(run.at)} · ${run.trigger}</small></div></button>`).join("")}</div></aside></div>${state.drawer ? `<div class="drawer-shade" data-action="close-drawer"></div><section class="routine-drawer" role="dialog" aria-modal="true" aria-label="Routine details"><div class="drawer-grip"></div><button class="close" style="float:right" data-action="close-drawer" aria-label="Close routine details">×</button><div class="workspace">${workspaceDetail(routine())}</div></section>` : ""}`;
}
function combinedPrototype() {
  const schedule = state.workspace === "calendar";
  return `<div class="page-tabs" role="tablist" aria-label="Routines page"><button id="routines-tab-schedule" role="tab" aria-selected="${schedule}" aria-controls="routines-panel-schedule" tabindex="${schedule ? 0 : -1}" data-action="workspace" data-value="calendar">${icon("calendar")} Schedule</button><button id="routines-tab-workspace" role="tab" aria-selected="${!schedule}" aria-controls="routines-panel-workspace" tabindex="${schedule ? -1 : 0}" data-action="workspace" data-value="routine">${icon("log")} Routine workspace</button></div><section role="tabpanel" id="routines-panel-${schedule ? "schedule" : "workspace"}" aria-labelledby="routines-tab-${schedule ? "schedule" : "workspace"}">${schedule ? `<div class="combined-schedule">${toolbar()}<div class="toolbar" style="margin-bottom:14px">${filters()}<span class="timezone">Select an occurrence to open its routine workspace</span></div>${calendar()}<div class="a-legend">${["Work", "Creative", "Personal"].map((category) => `<span class="row"><span class="dot" style="--color:${{ Work: "#6d88c4", Creative: "#bd9456", Personal: "#6c927a" }[category]}"></span>${category}</span>`).join("")}</div></div>` : variantB()}</section>`;
}
function syncCombinedLocation() {
  if (!COMBINED) return;
  const url = new URL(location.href);
  url.searchParams.set("tab", state.workspace === "calendar" ? "schedule" : "workspace");
  url.searchParams.set("routine", state.selected ?? "briefing");
  url.searchParams.set("view", state.range);
  window.history.pushState({}, "", url);
}
function render() {
  const active = liveRoutines().filter((r) => !r.paused).length;
  const pending = liveRoutines().filter((r) => r.pending).length;
  $("#app").innerHTML = `<header class="topbar"><div class="brand"><i></i>Desk</div><nav class="topnav" aria-label="Context"><span>My day</span><span>Studio</span><span class="current">Routines</span></nav><div class="topright"><span class="timezone">Monday, 2 November</span><span class="avatar">JC</span></div></header><div class="demobar"><b>PROTOTYPE</b><span>Sample routines · changes stay in this demo</span><span>Demo clock: 10:20 · ${zone}</span></div><div class="shell"><div class="pagehead"><div><h1>Routines</h1><p>${state.variant === "D" ? "Your schedule at a glance. A workspace for every routine." : state.variant === "A" ? "See the rhythm. Make space where you need it." : state.variant === "B" ? "A home for every routine, from schedule to result." : "What happens today, and what is coming next."}</p></div><div class="headstats"><span class="stats"><b>${active}</b> active · <b>${liveRoutines().length - active}</b> paused</span><button class="quiet" data-action="activity">${icon("log")} Activity</button>${pending ? `<button class="approval-link" data-action="pending">${pending} awaiting approval</button>` : ""}<button class="primary" data-action="new">+ New routine</button></div></div>${state.deletedTitle ? `<div class="deleted-note">${esc(state.deletedTitle)} was deleted. Its execution history and logs are still in <button class="link tiny" data-action="activity">Activity</button>.</div>` : ""}${state.variant === "B" ? `<div class="toolbar"><div class="seg" aria-label="Workspace"><button data-action="workspace" data-value="routine" class="${state.workspace === "routine" ? "active" : ""}">Routine workspace</button><button data-action="workspace" data-value="calendar" class="${state.workspace === "calendar" ? "active" : ""}">Schedule overview</button></div><span class="timezone">Pause and automatic handling are separate controls</span></div>` : ""}${state.variant === "D" ? combinedPrototype() : state.variant === "A" ? variantA() : state.variant === "B" ? variantB() : variantC()}</div><nav class="switcher ${COMBINED ? "combined-switcher" : ""}" aria-label="Prototype variants"><button class="arrow" data-action="cycle" data-delta="-1" aria-label="Previous prototype">‹</button><small>COMPARE</small>${Object.entries(VARIANTS).filter(([key]) => key !== "D").map(([key, name]) => `<button data-action="variant" data-value="${key}" class="${state.variant === key ? "active" : ""}" aria-pressed="${state.variant === key}">${key} · <span class="variant-long">${name}</span><span class="variant-short">${{ A: "Calendar", B: "Workspace", C: "Agenda" }[key]}</span></button>`).join("")}<button class="arrow" data-action="cycle" data-delta="1" aria-label="Next prototype">›</button><button class="reset" data-action="reset">Reset</button></nav>`;
  document.title = `Routines · ${state.variant} ${VARIANTS[state.variant]} · Prototype`;
  renderModal();
}
function toast(text) {
  const node = $("#toast"); node.textContent = text; node.classList.add("show"); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove("show"), 3500);
}
function openModal(kind, id, extra = {}) {
  state.modal = { kind, id, ...extra };
  if (kind === "schedule") { const r = routine(id); state.draft = { days: [...r.days], time: r.time, timezone: r.timezone }; }
  state.logFile = "execution.log";
  renderModal();
  requestAnimationFrame(() => $("#overlay button, #overlay input, #overlay textarea, #overlay select")?.focus());
}
function closeModal() { state.modal = null; state.draft = null; renderModal(); }
function modalFrame(title, subtitle, content, actionsHtml, wide = false) {
  return `<div class="modal-shade"><section class="modal ${wide ? "wide" : ""}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-header"><h2 id="modal-title">${title}</h2><button class="close" data-action="close-modal" aria-label="Close dialog">×</button></div>${subtitle ? `<p>${subtitle}</p>` : ""}${content}${actionsHtml ? `<div class="modal-actions">${actionsHtml}</div>` : ""}</section></div>`;
}
function previewSchedule() {
  const r = routine(state.modal.id);
  const draft = { ...r, ...state.draft };
  return `<h3>Next three occurrences${r.paused ? " if resumed" : ""}</h3>${draft.days.length && draft.time ? `<p>${nextOccurrences(draft).map((at) => `${formatRunDate(at)} <span class="muted">${zone}</span>`).join("<br>")}</p>` : '<p class="field-error">Choose at least one day and a time.</p>'}<div class="change-line" style="margin-top:12px"><span>Before</span><b>${scheduleWords(r)} · ${r.timezone}</b></div><div class="change-line"><span>After</span><b>${draft.days.length ? scheduleWords(draft) : "No days selected"} · ${draft.timezone}</b></div>`;
}
function logText(run, r, file) {
  if (file === "output.json") return run.status === "succeeded" ? JSON.stringify({ routine: r.title, outcome: "succeeded", summary: r.id === "briefing" ? "Briefing prepared with 3 calendar events and 2 priorities." : "The routine completed and its result is available on the Desk.", sample_data: true }, null, 2) : JSON.stringify({ outcome: run.status, output: null, sample_data: true }, null, 2);
  if (file === "error.log") return `[SAMPLE LOG · no live connection]\n${run.at} ERROR  Snapshot destination could not be reached.\n${run.at} ERROR  Connection timed out after 8 seconds.\n${run.at} INFO   Source files were not modified.\n${run.at} INFO   Check the configured destination before the next run.`;
  const lines = [`[SAMPLE LOG · no live connection]`, `${run.at} INFO   ${r.title}`, `${run.at} INFO   ${run.trigger} · request accepted`];
  if (run.status === "denied") return [...lines, `${run.at} INFO   Run denied by you. No execution started.`].join("\n");
  if (run.status === "running") return [...lines, `${run.at} INFO   Dispatched. Waiting for an execution result.`].join("\n");
  lines.push(`${run.at} INFO   Step 1 · ${r.steps[0]}`, `${run.at} INFO   Step 1 completed`);
  if (run.status === "failed") lines.push(`${run.at} ERROR  Step 2 · destination unavailable`, `${run.at} INFO   Routine stopped. See error.log for details.`);
  else lines.push(`${run.at} INFO   Step 2 · ${r.steps[1]}`, `${run.at} INFO   Step 2 completed`, `${run.at} INFO   Step 3 · ${r.steps[2]}`, `${run.at} INFO   Completed in ${run.duration}. Result saved.`, `${run.at} INFO   credential=[redacted]`);
  return lines.join("\n");
}
function runModal() {
  const run = state.runs.find((value) => value.id === state.modal.runId);
  const r = routine(run.routineId);
  const files = ["execution.log", "output.json", ...(run.status === "failed" ? ["error.log"] : [])];
  const text = logText(run, r, state.logFile);
  return modalFrame(esc(r.title), `Execution · ${formatRunDate(run.at)} · ${zone}${r.deleted ? " · Routine deleted; evidence retained" : ""}`, `<div class="run-summary"><span class="run-status ${run.status}">${statusSymbol(run.status)}</span><div><h3>${statusLabel(run.status)}</h3><p>${run.trigger} · ${run.duration}${run.status === "running" ? " · not yet completed" : ""}</p></div><span class="pill ${run.status === "failed" ? "red" : run.status === "succeeded" ? "green" : ""}" style="margin-left:auto">${run.status === "failed" ? "Needs a look" : run.status === "succeeded" ? "Result available" : "No completed result"}</span></div><div class="execution-timeline ${["denied", "running"].includes(run.status) ? "inactive" : ""}">${r.steps.map((step, index) => `<b class="${run.status === "failed" && index === 1 ? "failed" : ""}">${run.status === "succeeded" ? "✓ " : run.status === "failed" && index === 1 ? "! " : ""}${esc(step)}</b>${index < r.steps.length - 1 ? "<span>→</span>" : ""}`).join("")}</div><div class="log-layout"><nav class="logfiles" aria-label="Log files"><h4>FILES</h4>${files.map((file) => `<button data-action="log-file" data-value="${file}" class="${state.logFile === file ? "active" : ""}">${icon("log")} ${file}<small>${file === "execution.log" ? "2.4 KB · execution trace" : file === "output.json" ? "614 B · saved result" : "843 B · error detail"}</small></button>`).join("")}</nav><div><div class="log-tools"><label><input id="wrap-log" type="checkbox" ${state.logWrap ? "checked" : ""}>Wrap lines</label><button data-action="download-log">Download ${state.logFile}</button></div><pre class="log-content ${state.logWrap ? "wrap" : ""}">${text.split("\n").map((line) => line.includes(" ERROR ") ? `<span class="logerror">${esc(line)}</span>` : esc(line)).join("\n")}</pre></div></div>`, `<button data-action="close-modal">Close</button>${!r.deleted ? `<button class="primary" data-action="inspect-from-log" data-id="${r.id}">View routine</button>` : ""}`, true);
}
function renderModal() {
  const modal = state.modal;
  if (!modal) { $("#overlay").innerHTML = ""; return; }
  const r = modal.id ? routine(modal.id) : null;
  let html = "";
  if (modal.kind === "schedule") html = modalFrame(`Edit schedule`, esc(r.title), `<form id="schedule-form"><div class="field"><label>Repeat on</label><div class="weekdays">${MON_DAYS.map((day) => `<button type="button" data-action="weekday" data-day="${day}" class="${state.draft.days.includes(day) ? "active" : ""}" aria-pressed="${state.draft.days.includes(day)}" aria-label="${DAY_NAMES[day]}">${DAY_NAMES[day][0]}</button>`).join("")}</div></div><div class="field-grid"><div class="field"><label for="schedule-time">At</label><input id="schedule-time" type="time" required value="${state.draft.time}"></div><div class="field"><label for="schedule-zone">Timezone</label><select id="schedule-zone">${[zone, "UTC", "America/New_York"].map((value) => `<option ${state.draft.timezone === value ? "selected" : ""}>${value}</option>`).join("")}</select></div></div><div class="preview-box" id="schedule-preview">${previewSchedule()}</div><p class="schedule-editor-note">${r.paused ? "This routine stays paused. " : ""}Handling stays “${handlingText(r).toLowerCase()}”. Existing executions and logs are unchanged.</p><p id="schedule-error" class="field-error"></p></form>`, '<button data-action="close-modal">Cancel</button><button class="primary" data-action="save-schedule">Save schedule</button>');
  if (modal.kind === "pause") html = modalFrame(`Pause ${esc(r.title)}?`, "No new runs will be triggered until you resume this routine.", `<div class="preview-box"><p>${scheduleWords(r)} · ${r.timezone}</p><p>Handling policy: ${handlingText(r).toLowerCase()}</p></div><div class="hint">The schedule and handling policy are kept. Pausing does not stop an active execution${r.pending ? " or withdraw the run already waiting for your approval" : ""}.</div>`, '<button data-action="close-modal">Keep active</button><button class="primary" data-action="confirm-pause">Pause routine</button>');
  if (modal.kind === "delete") html = modalFrame(`Delete ${esc(r.title)}?`, "Remove the routine and its future schedule.", `<div class="preview-box"><p>${scheduleWords(r)} · ${r.timezone}</p><p>${r.pending ? "Its pending approval request will also be withdrawn." : "This does not cancel an execution that has already started."}</p></div><div class="hint">Past execution records and log files remain available in Activity. This retention behavior is part of the UX proposal.</div>`, '<button data-action="close-modal">Keep routine</button><button class="danger primary" data-action="confirm-delete">Delete routine</button>');
  if (modal.kind === "policy") html = modalFrame("Who approves each run?", esc(r.title), `<div class="policy-choices"><label><input type="radio" name="handling" value="approval" ${r.policy === "approval" ? "checked" : ""}><span><strong>Ask me first</strong><small>Each scheduled occurrence asks for approval. You choose Approve or Deny.</small></span></label><label><input type="radio" name="handling" value="auto" ${r.policy === "auto" ? "checked" : ""}><span><strong>Handle this yourself</strong><small>Future runs are handled automatically and appear in your execution history.</small></span></label></div><div class="hint">This does not pause the schedule. ${r.paused ? "The routine stays paused until you resume it." : "Existing pending requests still need their own decision."}</div>`, '<button data-action="close-modal">Cancel</button><button class="primary" data-action="save-policy">Save handling policy</button>');
  if (modal.kind === "run") html = runModal();
  if (modal.kind === "activity") html = modalFrame("Recent executions", "Scheduled, approved and automatic runs — including history from deleted routines.", `<div class="filters" style="margin:16px 0 22px"><button data-action="activity-filter" data-value="all" class="${modal.filter !== "failed" ? "active" : ""}">All executions</button><button data-action="activity-filter" data-value="failed" class="${modal.filter === "failed" ? "active" : ""}">Failed only</button></div><div style="max-height:430px;overflow:auto">${modal.filter === "failed" ? `<table class="run-table"><tbody>${history().filter((run) => run.status === "failed").map((run) => `<tr tabindex="0" role="button" data-action="run" data-run="${run.id}"><td>${esc(routine(run.routineId).title)}</td><td>${formatRunDate(run.at)}</td><td><span class="pill red">Failed</span></td><td>Read logs →</td></tr>`).join("")}</tbody></table>` : runTable()}</div>`, '<button data-action="close-modal">Close</button>', true);
  if (modal.kind === "new") {
    const preview = modal.preview;
    html = modalFrame("Create a routine", "Tell Ivy what should happen and when. Review the schedule and flow before confirming.", `<div class="field"><label for="routine-request">Your request</label><textarea id="routine-request" rows="3" placeholder="Every Friday at 17:00, prepare my weekly review.">${esc(modal.request ?? "")}</textarea></div>${preview ? `<div class="preview-box"><div class="eyebrow">Prepared routine</div><h3 style="margin:9px 0">${esc(preview.title)}</h3><p>${scheduleWords(preview)} · ${zone}</p><p>Asks before each run</p></div><div style="margin-top:12px">${flow(preview)}</div>` : '<div class="hint">Try: “Every Friday at 17:00, prepare my weekly review.” Nothing is installed until Confirm.</div>'}<p id="new-error" class="field-error"></p>`, `<button data-action="close-modal">Cancel</button>${preview ? '<button class="primary" data-action="confirm-new">Confirm routine</button>' : '<button class="primary" data-action="preview-new">Prepare preview</button>'}`);
  }
  $("#overlay").innerHTML = html;
}
function selectRoutine(id) {
  state.selected = id; state.tab = "overview"; state.workspace = "routine";
  syncCombinedLocation();
  if (state.variant === "C") state.drawer = true;
  render();
  if (state.drawer) requestAnimationFrame(() => $(".routine-drawer .close")?.focus());
  if (state.variant === "A" && innerWidth < 850) $(".inspector")?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function switchVariant(value) {
  state.variant = value; state.drawer = false; closeModal();
  const url = new URL(location.href); url.searchParams.set("variant", value); historyPush(url); render();
}
function historyPush(url) { window.history.pushState({}, "", url); }
function handleAction(button) {
  const action = button.dataset.action;
  const id = button.dataset.id;
  if (action === "variant") return switchVariant(button.dataset.value);
  if (action === "cycle") { const keys = Object.keys(VARIANTS).filter((key) => key !== "D"); return switchVariant(keys[(keys.indexOf(state.variant) + Number(button.dataset.delta) + keys.length) % keys.length]); }
  if (action === "reset") { const variant = state.variant; state = seedState(); state.variant = variant; render(); return toast("Demo reset. All sample routines restored."); }
  if (action === "select") return selectRoutine(id);
  if (action === "detail-tab") { state.tab = button.dataset.value; return render(); }
  if (action === "workspace") { state.workspace = button.dataset.value; syncCombinedLocation(); return render(); }
  if (action === "range") { state.range = button.dataset.value; syncCombinedLocation(); return render(); }
  if (action === "category") { state.category = button.dataset.value; return render(); }
  if (action === "period") {
    const delta = Number(button.dataset.delta);
    state.date = state.range === "month" ? new Date(Date.UTC(state.date.getUTCFullYear(), state.date.getUTCMonth() + delta, 1)) : plusDays(state.date, delta * (state.range === "week" ? 7 : 1));
    state.focusDate = new Date(state.date); return render();
  }
  if (action === "today") { state.date = new Date(DEMO); state.focusDate = new Date(DEMO); return render(); }
  if (action === "open-day" || action === "focus-day") { const date = new Date(`${button.dataset.date}T00:00:00Z`); state.focusDate = date; if (action === "open-day") { state.date = date; state.range = "day"; } return render(); }
  if (["schedule", "pause", "delete", "policy"].includes(action)) return openModal(action, id);
  if (action === "resume") { routine(id).paused = false; render(); return toast(`Resumed. ${handlingText(routine(id))}.`); }
  if (action === "close-modal") return closeModal();
  if (action === "close-drawer") { state.drawer = false; return render(); }
  if (action === "weekday") {
    const day = Number(button.dataset.day);
    state.draft.days = state.draft.days.includes(day) ? state.draft.days.filter((value) => value !== day) : [...state.draft.days, day];
    button.classList.toggle("active"); button.setAttribute("aria-pressed", String(state.draft.days.includes(day))); $("#schedule-preview").innerHTML = previewSchedule(); return;
  }
  if (action === "save-schedule") {
    if (!state.draft.days.length || !state.draft.time || !$("#schedule-time").checkValidity()) { $("#schedule-error").textContent = "Choose at least one day and a valid time."; return; }
    const r = routine(state.modal.id); Object.assign(r, state.draft, { days: [...state.draft.days] }); closeModal(); render(); return toast(`Schedule saved. ${scheduleWords(r)}. Handling unchanged.`);
  }
  if (action === "confirm-pause") { const r = routine(state.modal.id); r.paused = true; closeModal(); render(); return toast(`${r.title} paused. Its handling policy is kept.`); }
  if (action === "confirm-delete") { const r = routine(state.modal.id); r.deleted = true; r.pending = false; state.deletedTitle = r.title; state.drawer = false; state.selected = liveRoutines()[0]?.id ?? null; closeModal(); render(); return toast("Routine deleted. Execution history and logs retained in Activity."); }
  if (action === "save-policy") { const r = routine(state.modal.id); r.policy = $('input[name="handling"]:checked').value; closeModal(); render(); return toast(`${handlingText(r)}. ${r.paused ? "The routine remains paused." : "The schedule is unchanged."}`); }
  if (action === "pending") { const pending = liveRoutines().find((r) => r.pending); if (pending) return selectRoutine(pending.id); }
  if (action === "decide") { const r = routine(id); r.pending = false; const approved = button.dataset.value === "approve"; state.runs.push({ id: `${id}-decision-${Date.now()}`, routineId: id, at: NOW.toISOString(), status: approved ? "running" : "denied", duration: "—", scheduledFor: instantFor(DEMO, r.time, r.timezone).toISOString(), trigger: approved ? "Approved by you" : "Denied by you" }); render(); return toast(approved ? "Run approved and dispatched. Completion will appear in its history." : "Run denied. No execution started."); }
  if (action === "activity") return openModal("activity", null, { filter: "all" });
  if (action === "activity-filter") { state.modal.filter = button.dataset.value; return renderModal(); }
  if (action === "run") return openModal("run", null, { runId: button.dataset.run });
  if (action === "log-file") { state.logFile = button.dataset.value; return renderModal(); }
  if (action === "download-log") {
    const run = state.runs.find((value) => value.id === state.modal.runId); const r = routine(run.routineId);
    const url = URL.createObjectURL(new Blob([logText(run, r, state.logFile)], { type: "text/plain" })); const link = document.createElement("a"); link.href = url; link.download = `sample-${r.id}-${state.logFile}`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return toast("Sample log downloaded.");
  }
  if (action === "inspect-from-log") { closeModal(); return selectRoutine(id); }
  if (action === "new") return openModal("new");
  if (action === "preview-new") {
    const request = $("#routine-request").value.trim(); const time = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(request); const weekdays = /weekdays?/i.test(request); const everyday = /every day|daily/i.test(request); const names = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]; const named = names.findIndex((name) => request.toLowerCase().includes(name));
    if (!time || (!weekdays && !everyday && named < 0)) { $("#new-error").textContent = "Include a recurring day and time, for example every Friday at 17:00."; return; }
    const title = request.replace(/^.*?\d{1,2}:\d{2}[,\s]*/, "").replace(/[.!]$/, "") || "New routine";
    state.modal.request = request; state.modal.preview = { title: title[0].toUpperCase() + title.slice(1), days: weekdays ? [1, 2, 3, 4, 5] : everyday ? [0, 1, 2, 3, 4, 5, 6] : [named], time: `${time[1].padStart(2, "0")}:${time[2]}`, timezone: zone, steps: ["Read the relevant sources", "Prepare a summary", "Save a draft for you"] }; return renderModal();
  }
  if (action === "confirm-new") { const id = `created-${Date.now()}`; state.routines.push({ ...state.modal.preview, id, description: state.modal.request, category: "Personal", policy: "approval", paused: false, deleted: false, color: "#6c927a", tint: "#edf5ef" }); closeModal(); selectRoutine(id); return toast("Routine confirmed. Each occurrence will ask you first."); }
}
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (button) { event.preventDefault(); handleAction(button); }
  else if (event.target.classList.contains("modal-shade")) closeModal();
});
document.addEventListener("change", (event) => {
  if (event.target.id === "show-paused") { state.showPaused = event.target.checked; render(); }
  if (event.target.id === "schedule-time" || event.target.id === "schedule-zone") { state.draft.time = $("#schedule-time").value; state.draft.timezone = $("#schedule-zone").value; $("#schedule-preview").innerHTML = previewSchedule(); }
  if (event.target.id === "wrap-log") { state.logWrap = event.target.checked; $(".log-content").classList.toggle("wrap", state.logWrap); }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "routine-search") { const value = event.target.value; const cursor = event.target.selectionStart; state.query = value; render(); const input = $("#routine-search"); input.focus(); input.setSelectionRange(cursor, cursor); }
});
document.addEventListener("keydown", (event) => {
  if (COMBINED && event.target.closest('.page-tabs [role="tab"]') && ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    state.workspace = event.key === "Home" ? "calendar" : event.key === "End" ? "routine" : state.workspace === "calendar" ? "routine" : "calendar";
    syncCombinedLocation(); render(); document.getElementById(state.workspace === "calendar" ? "routines-tab-schedule" : "routines-tab-workspace")?.focus(); return;
  }
  if (event.key === "Escape") { if (state.modal) closeModal(); else if (state.drawer) { state.drawer = false; render(); } }
  if ((event.key === "Enter" || event.key === " ") && event.target.matches('tr[data-action]')) { event.preventDefault(); handleAction(event.target); }
  const dialog = $("#overlay [role=dialog]") ?? $(".routine-drawer");
  if (event.key === "Tab" && dialog) { const controls = [...dialog.querySelectorAll('button:not(:disabled),input,select,textarea,a[href],[tabindex="0"]')]; const first = controls[0]; const last = controls.at(-1); if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last?.focus(); } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first?.focus(); } }
  if (!COMBINED && !state.modal && !state.drawer && ["ArrowLeft", "ArrowRight"].includes(event.key) && !event.target.closest("input,textarea,select,[contenteditable=true]")) { event.preventDefault(); const keys = Object.keys(VARIANTS).filter((key) => key !== "D"); switchVariant(keys[(keys.indexOf(state.variant) + (event.key === "ArrowRight" ? 1 : -1) + 3) % 3]); }
});
window.addEventListener("popstate", () => {
  if (COMBINED) {
    const params = new URLSearchParams(location.search);
    state.workspace = params.get("tab") === "workspace" ? "routine" : "calendar";
    if (routine(params.get("routine")) && !routine(params.get("routine")).deleted) state.selected = params.get("routine");
    if (["day", "week", "month"].includes(params.get("view"))) state.range = params.get("view");
    state.drawer = false; render(); return;
  }
  const value = new URLSearchParams(location.search).get("variant"); state.variant = value in VARIANTS ? value : "A"; state.drawer = false; render(); });
render();
