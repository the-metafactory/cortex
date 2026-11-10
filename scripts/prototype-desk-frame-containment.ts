#!/usr/bin/env bun
import { ATTACKS } from "../docs/prototypes/desk-frame-containment/attacks";
import { buildShell, openCell, openEvil, openLabPackage, ROUTES, SESSION_COOKIE, SESSION_VALUE, VARIANTS, type LabCell } from "../docs/prototypes/desk-frame-containment/lab";

const port = Number(process.argv.find(arg => arg.startsWith("--port="))?.slice(7) ?? 33610);
const { rig } = await openLabPackage();
const shellJs = await buildShell();
const evilPlain = await openEvil(false);
const evilTls = await openEvil(true);
const cells: LabCell[] = ROUTES.flatMap(route => VARIANTS.map(variant => openCell(route, variant, rig, shellJs, route === "hosted" ? evilTls.origin : evilPlain.origin)));
const started = Date.now();

const shellLink = (cell: LabCell, attack: string): string => {
  const evil = cell.route === "hosted" ? evilTls : evilPlain;
  const query = new URLSearchParams({ a: attack, variant: cell.variant, c: `canary-${attack}`, t: `demo-${cell.route}-${cell.variant}-${attack}`, e: evil.origin, u: evil.udp, r: cell.redirectPath });
  const shell = `${cell.origin}/lab/shell.html?${query}`;
  return cell.route === "hosted" ? `${cell.origin}/__lab/login?next=${encodeURIComponent(shell)}` : shell;
};

const NOTES: Record<string, string> = {
  open: "uncontained control: every attack should land",
  merged: "the #3325 headers as merged: the adapter script never runs",
  combined: "generation-scoped CSP over network assets; hosted cookie SameSite=None",
  inline: "chosen: host-inlined single document, no network from the frame",
};

const index = (): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Frame containment lab</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:16px;max-width:1200px;color:#18181b;background:#fff}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #e4e4e7;padding:4px 6px;text-align:left;vertical-align:top}th{position:sticky;top:0;background:#fff}a{color:#1d4ed8}code{font-size:12px}#evil{font:12px/1.4 ui-monospace,monospace;background:#18181b;color:#fde68a;padding:10px;max-height:260px;overflow:auto;white-space:pre-wrap}@media (prefers-color-scheme:dark){body,th{background:#18181b;color:#f4f4f5}a{color:#93c5fd}td,th{border-color:#3f3f46}}</style></head><body>
<h1>Desk adapter frame containment lab</h1>
<p>Each link opens the shell with one hostile adapter UI attack. The grey panel under the frame shows the bridge; the black panel here shows what reached the attacker (refreshes every second). A leak carries the canary <code>canary-&lt;attack&gt;</code>. Hosted links set the synthetic session cookie first; accept the self-signed certificate once per hosted port.</p>
<p>${VARIANTS.map(v => `<b>${v}</b>: ${NOTES[v]}`).join("<br>")}</p>
<h2>Attacker receiver</h2><div id="evil">waiting…</div>
<h2>Attacks</h2><table><thead><tr><th>attack</th><th>family</th>${cells.map(c => `<th>${c.route}<br>${c.variant}</th>`).join("")}</tr></thead><tbody>
${ATTACKS.map(([attack, family]) => `<tr><td><code>${attack}</code></td><td>${family}</td>${cells.map(c => `<td><a href="${shellLink(c, attack)}" target="_blank" rel="noopener">open</a></td>`).join("")}</tr>`).join("\n")}
</tbody></table>
<script>setInterval(async()=>{const r=await fetch("/evil-log");document.getElementById("evil").textContent=(await r.text())||"nothing yet"},1000)</script></body></html>`;

Bun.serve({ hostname: "127.0.0.1", port, fetch(req) {
  const url = new URL(req.url);
  if (url.pathname === "/evil-log") {
    const lines = [...evilPlain.events, ...evilTls.events].filter(e => e.at >= started && e.kind !== "connect").sort((a, b) => b.at - a.at).slice(0, 80)
      .map(e => `${new Date(e.at).toISOString().slice(11, 19)} ${e.kind === "udp" ? `UDP packet, ${e.bytes} bytes (WebRTC STUN)` : e.line}`);
    return new Response(lines.join("\n"), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  return new Response(index(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
} });

console.log(`Frame containment lab: http://127.0.0.1:${port}/`);
console.log(`Session cookie for hosted routes: ${SESSION_COOKIE}=${SESSION_VALUE} (synthetic). Ctrl-C to stop.`);
