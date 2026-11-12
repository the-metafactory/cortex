/* Mail authority prototype for cortex#3356. Reuses the prototype's styles from compose.ts. Builds dist/mail.html. */
import { bundle } from "./compose";
const here = import.meta.dir;
const { css } = await bundle();
const proto = await Bun.file(`${here}/mail-auth.de.js`).text();

const html = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Threva · Mail-Aktionen</title>
<style>${css}
.mailproto{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:18px;align-items:start}
@media (max-width:860px){.mailproto{grid-template-columns:1fr}}
.ivy.ask{border:1.5px solid var(--accent)}
.warnline{color:var(--wait);font-weight:500}
.plain{margin:0;padding-left:18px}
.mailproto>*{min-width:0}
.proto-ctl,.proto-ctl .row,.seg{max-width:100%;min-width:0}
.eyebrow{white-space:normal;overflow-wrap:anywhere}
</style>
</head>
<body>
<div class="wrap">
  <header style="display:flex;flex-direction:column;gap:10px">
    <span class="eyebrow">Threva · Prototyp Mail-Aktionen · alle Daten sind erfunden</span>
    <div class="proto-ctl"><span class="row"><span class="faint">Der Anbieter antwortet beim nächsten Klick mit</span><div class="seg" role="tablist" id="ctl-sim"></div></span></div>
  </header>
  <main id="view"></main>
</div>
<script>
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
${proto}
const view = document.getElementById("view"), sim = document.getElementById("ctl-sim");
function render() {
  view.innerHTML = mailView();
  sim.innerHTML = SIMS.map(([k, l]) => '<button role="tab" data-s="' + k + '" aria-selected="' + (M.sim === k) + '">' + l + "</button>").join("");
}
view.addEventListener("click", (e) => { const b = e.target.closest("[data-m]"); if (!b) return; mailAct(b.dataset.m, b.dataset.id); render(); });
sim.addEventListener("click", (e) => { const b = e.target.closest("[data-s]"); if (!b) return; M.sim = b.dataset.s; render(); });
render();
</script>
</body>
</html>
`;
await Bun.write(`${here}/dist/mail.html`, html);
console.log("bytes", html.length);
