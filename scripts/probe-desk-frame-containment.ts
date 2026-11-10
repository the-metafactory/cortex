#!/usr/bin/env bun
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser, type BrowserType, type Page } from "playwright";
import { DeskAdapterUiSchema } from "../src/conversations/domain-adapters/package";
import { DESK_UI_PROTOCOL_VERSION } from "../src/conversations/domain-adapters/package-generation";
import { ObjectReferenceSchema } from "../src/conversations/domain-adapters/types";
import { buildShell, openCell, openEvil, openLabPackage, ROUTES, SESSION_COOKIE, SESSION_VALUE, VARIANTS, type EvilReceiver, type HostHit, type LabCell, type Route, type Variant } from "../docs/prototypes/desk-frame-containment/lab";
import { ATTACKS, type Family } from "../docs/prototypes/desk-frame-containment/attacks";
import { DESK_UI_WIRE_VERSION, InboundGate, newInstance, UiMessageSchema, type Identity } from "../docs/prototypes/desk-frame-containment/protocol";

const EVIDENCE = join(import.meta.dir, "../docs/prototypes/desk-frame-containment/evidence");
const only = process.argv.find(arg => arg.startsWith("--only="))?.slice(7).split(",");
const browserArg = process.argv.find(arg => arg.startsWith("--browsers="))?.slice(11).split(",") ?? ["chromium", "firefox", "webkit"];

const SELECTED = only ? ATTACKS.filter(([id]) => only.includes(id)) : ATTACKS;

interface Report { step: string; value: string | null }
interface Shell { log: string[]; accepted: string[]; violations: string[]; ambient: number; closed: string | null; loads: number; ready: boolean; projectionSent: boolean; done: boolean }
interface Run {
  browser: string; route: Route; variant: Variant; attack: string; family: Family; tag: string; canary: string;
  reports: Report[]; shell: Shell | null; evil: string[]; bare: number; udp: number; hostHits: HostHit[];
  popups: string[]; downloads: string[]; pageUrl: string; frameUrls: string[]; parentPwned: boolean; pageErrors: string[];
  outcome: "contained" | "breached" | "pass" | "fail" | "not-run"; mechanism: string;
}

const rand = (): string => newInstance().slice(0, 12);
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

async function runAttack(browser: Browser, browserName: string, cell: LabCell, evil: EvilReceiver, attack: string, family: Family): Promise<Run> {
  const tag = `${browserName}-${cell.route}-${cell.variant}-${attack}-${rand()}`;
  const canary = `canary${rand()}`;
  const context = await browser.newContext({ acceptDownloads: true, ignoreHTTPSErrors: true });
  if (cell.route === "hosted") await context.addCookies([{ name: SESSION_COOKIE, value: SESSION_VALUE, domain: "localhost", path: "/", httpOnly: true, secure: true, sameSite: cell.variant === "combined" ? "None" as const : "Lax" as const }]);
  const page = await context.newPage();
  const reports: Report[] = [];
  const popups: string[] = [];
  const downloads: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", message => {
    const text = message.text();
    if (!text.startsWith("LAB ")) return;
    try {
      const parsed = JSON.parse(text.slice(4)) as { tag?: string; step: string; value: string | null };
      if (!parsed.tag || parsed.tag === tag) reports.push({ step: parsed.step, value: parsed.value });
    } catch (_err) { reports.push({ step: "unparsed", value: text }); }
  });
  page.on("pageerror", error => { pageErrors.push(error.message.slice(0, 160)); });
  context.on("page", other => { if (other !== page) popups.push(other.url()); });
  page.on("download", download => { downloads.push(download.suggestedFilename()); });
  const hitsBefore = cell.hits.length;
  const evilBefore = evil.events.length;
  const start = Date.now();
  const shellUrl = `${cell.origin}/lab/shell.html?${new URLSearchParams({ a: attack, variant: cell.variant, c: canary, t: tag, e: evil.origin, u: evil.udp, r: cell.redirectPath })}`;
  let shell: Shell | null = null;
  try {
    await page.goto(shellUrl, { waitUntil: "load", timeout: 8000 });
    for (let waited = 0; waited < 3800; waited += 100) {
      if (reports.some(r => r.step === "done")) break;
      const state = await page.evaluate(() => (window as unknown as { __lab?: { done: boolean } }).__lab?.done ?? false).catch(() => false);
      if (state) break;
      await sleep(100);
    }
    await sleep(700);
    shell = await page.evaluate(() => (window as unknown as { __lab?: Shell }).__lab ?? null).catch(() => null);
  } catch (error) { pageErrors.push(`goto: ${String(error).slice(0, 160)}`); }
  await sleep(150);
  const pageUrl = page.url();
  const frameUrls = page.frames().filter(frame => frame !== page.mainFrame()).map(frame => frame.url());
  const parentPwned = await page.evaluate(() => document.body?.dataset.labPwned ?? "").then(value => value !== "").catch(() => false);
  const popupUrls = context.pages().filter(other => other !== page).map(other => other.url());
  await context.close();
  const end = Date.now();
  const window = evil.events.slice(evilBefore).filter(event => event.at >= start && event.at <= end + 200);
  const evilLines = window.filter(event => event.kind === "request" && event.line?.includes(`/${tag}/`)).map(event => event.line ?? "");
  const loginLines = window.filter(event => event.kind === "request" && event.line?.includes("/access-login")).map(event => event.line ?? "");
  const requests = window.filter(event => event.kind === "request").length;
  const connects = window.filter(event => event.kind === "connect").length;
  const run: Run = {
    browser: browserName, route: cell.route, variant: cell.variant, attack, family, tag, canary, reports, shell,
    evil: [...evilLines, ...loginLines], bare: Math.max(0, connects - requests), udp: window.filter(event => event.kind === "udp").length,
    hostHits: cell.hits.slice(hitsBefore).filter(hit => !hit.path.startsWith("/lab/")), popups: [...new Set([...popups, ...popupUrls])], downloads, pageUrl, frameUrls, parentPwned, pageErrors,
    outcome: "contained", mechanism: "",
  };
  classify(run, cell.origin, evil.origin);
  return run;
}

const value = (run: Run, step: string): string | null => run.reports.find(r => r.step === step)?.value ?? null;
const threw = (v: string | null): boolean => v === null || v.startsWith("threw:");

function classify(run: Run, origin: string, evilOrigin: string): void {
  const s = run.shell;
  const breach = (mechanism: string): void => { run.outcome = "breached"; run.mechanism = mechanism; };
  const contain = (mechanism: string): void => { run.outcome = "contained"; run.mechanism = mechanism; };
  const leaked = run.evil.filter(line => !line.includes("/access-login"));
  const canaryLeaked = leaked.some(line => line.includes(run.canary));
  const escapedFrame = run.frameUrls.find(url => url.startsWith(evilOrigin) || url.startsWith("data:") || url.startsWith("blob:") || url === `${origin}/`);

  if (!s && run.pageUrl.includes("/access-login")) { run.outcome = "not-run"; run.mechanism = "lab: the shell itself was not authenticated"; return; }
  if (run.attack === "benign-result") { run.outcome = s?.ready && s.projectionSent && s.accepted.includes("ui:navigate") && !s.closed ? "pass" : "fail"; run.mechanism = `ready=${s?.ready} accepted=${s?.accepted.join("+")} closed=${s?.closed}`; return; }
  if (run.attack === "benign-editor") { run.outcome = s?.accepted.includes("draft:change") && s.accepted.includes("action:propose") && !s.closed ? "pass" : "fail"; run.mechanism = `accepted=${s?.accepted.join("+")} closed=${s?.closed}`; return; }
  if (run.attack === "legit-assets") {
    const status = (name: string): string => { const hit = run.hostHits.find(h => h.path.endsWith(`/${name}`)); return hit ? `${hit.status}${hit.origin ? `(Origin ${hit.origin})` : ""}` : "no request"; };
    const css = value(run, "css") === "rgb(1, 2, 3)";
    run.outcome = css && value(run, "image") === "loaded" && s?.ready ? "pass" : "fail";
    run.mechanism = `ready=${s?.ready} css=${css ? "applied" : value(run, "css") ?? "not run"} app.js=${status("attack.js")} image=${value(run, "image") ?? "?"}/${status("pixel.png")} font=${status("font.woff2")} module=${value(run, "module") ?? "not run"}/${status("module.js")}`;
    return;
  }
  const ran = run.reports.some(r => r.step === "loaded") || (run.attack === "nav-before-load" && run.hostHits.some(h => h.path.includes("/app.html") && h.status === 200) && (leaked.length > 0 || run.reports.length > 0 || run.variant === "open"));
  if (leaked.length > 0) return breach(`reached attacker${canaryLeaked ? " with projection canary" : ""}: ${leaked[0]?.split(" ").slice(0, 2).join(" ")}`);
  if (run.attack === "preconnect" && run.bare > 0) return breach(`${run.bare} bare TCP connection(s) to attacker`);
  if (run.attack === "webrtc-stun" && run.udp > 0) return breach(`${run.udp} STUN/UDP packet(s) to attacker`);
  if (run.parentPwned) return breach("wrote to parent DOM");
  if (run.popups.length) return breach(`popup opened: ${run.popups[0]}`);
  if (run.downloads.length) return breach(`download started: ${run.downloads[0]}`);
  if (!run.pageUrl.startsWith(`${origin}/lab/shell.html`)) return breach(`top navigated to ${run.pageUrl.slice(0, 80)}`);
  if (escapedFrame) return breach(`frame loaded ${escapedFrame.slice(0, 60)}`);

  if (!ran && run.attack !== "nav-before-load") { run.outcome = "not-run"; run.mechanism = `adapter script never ran: ${run.hostHits.filter(h => h.path.includes("/assets/")).map(h => `${h.path.split("/").pop()} ${h.status}`).join(", ") || "no asset request"}`; return; }
  switch (run.family) {
    case "dom": {
      const read = value(run, "read") ?? value(run, "write") ?? value(run, "open") ?? value(run, "opened");
      if (run.reports.some(r => r.value?.includes(run.canary))) return breach("read shell canary");
      if (run.attack.startsWith("storage-") && value(run, "opened") === "yes") return breach("storage API available in frame");
      if (run.attack === "storage-cookie" && read && !threw(read) && read !== "empty") return breach(`cookie readable: ${read}`);
      if (["parent-dom-read", "top-dom-read", "parent-location-read"].includes(run.attack) && !threw(read)) return breach(`read parent: ${read}`);
      return contain(read ?? "no report");
    }
    case "worker": {
      if (value(run, "message") === "ran" || value(run, "registered") === "yes") return breach(`worker ran: ${value(run, "message") ?? value(run, "registered")}`);
      const constructed = value(run, "worker") ?? value(run, "sw");
      const fetched = run.hostHits.find(h => h.path.includes("worker.js"));
      return contain(`${constructed ?? "?"}${value(run, "error") ? " then error event" : ""}${value(run, "registered") ? ` ${value(run, "registered")}` : ""}${fetched ? `; host saw worker.js ${fetched.status}` : ""}`);
    }
    case "message": {
      const effects = (s?.accepted ?? []).filter(type => type === "draft:change" || type === "action:propose");
      if (effects.length) return breach(`host admitted ${effects.join("+")}`);
      if (run.attack.startsWith("msg-ambient") || run.attack === "msg-second-port") return contain(`ignored ${s?.ambient ?? 0} ambient message(s); bridge ${s?.closed ?? "open"}`);
      if (!s?.closed) return breach("bridge stayed open after a violation");
      return contain(`bridge closed ${s.closed}`);
    }
    case "navigation": {
      if (run.attack === "nav-before-load") return s?.ready ? breach("a navigated-away document completed the handshake") : contain(`no handshake; ${s?.closed ?? "open"}`);
      return contain(`${s?.closed ? `bridge closed ${s.closed}` : "bridge open"}; loads=${s?.loads}; frame=${run.frameUrls[0]?.slice(0, 40) ?? "removed"}`);
    }
    default: {
      const host = run.hostHits.filter(h => h.path.includes("/api/desk/adapters/catalog") && h.origin !== origin);
      if (run.attack.endsWith("host-api") && host.length) {
        const read = value(run, "read");
        return read && !threw(read) ? breach(`read host API: ${read.slice(0, 40)}`) : contain(`reached host API ${host.map(h => h.status).join(",")} (unreadable)`);
      }
      return contain(run.reports.filter(r => r.step !== "done" && r.step !== "loaded" && r.step !== "init").map(r => `${r.step}=${r.value}`).join(" ") || "no report");
    }
  }
}

function protocolChecks(): { name: string; ok: boolean }[] {
  const identity: Identity = { protocol: "desk-ui", version: DESK_UI_WIRE_VERSION, instance: newInstance(), adapterId: "balance", connectionId: "connection-example", generationId: "gen-a", releaseDigest: "a".repeat(64) };
  const editor = new InboundGate(identity, { objectType: "task", view: "editor" });
  const m = (seq: number, type: string, body: unknown, extra: object = {}) => ({ ...identity, seq, type, body, ...extra });
  const checks: { name: string; ok: boolean }[] = [];
  const check = (name: string, ok: boolean): void => { checks.push({ name, ok }); };
  check("ready admitted", editor.admit(m(1, "ui:ready", { mount: { objectType: "task", view: "editor" } })).ok);
  check("draft:change admitted after ready", editor.admit(m(2, "draft:change", { draftId: "draft-1", baseRevision: 1, changes: [{ pointer: "/title", change: { kind: "set", value: "x" } }] })).ok);
  check("action:propose admitted in editor", editor.admit(m(3, "action:propose", { draftId: "draft-1", revision: 2 })).ok);
  const fresh = (view: "result" | "editor" = "editor") => { const g = new InboundGate(identity, { objectType: "task", view }); g.admit(m(1, "ui:ready", { mount: { objectType: "task", view } })); return g; };
  const rejects = (name: string, raw: unknown, violation: string, view: "result" | "editor" = "editor") => { const verdict = fresh(view).admit(raw); check(`${name} → ${violation}`, !verdict.ok && verdict.violation === violation); };
  rejects("replayed seq", m(1, "ui:resize", { height: 1 }), "replayed_or_out_of_order");
  rejects("unknown type", m(2, "action:execute", {}), "schema");
  rejects("extra body field", m(2, "ui:resize", { height: 1, grant: true }), "schema");
  rejects("extra envelope field", m(2, "ui:resize", { height: 1 }, { authority: "host" }), "schema");
  rejects("prototype version label", m(2, "ui:resize", { height: 1 }, { version: "1.0.0-prototype" }), "schema");
  rejects("wrong release", m(2, "ui:resize", { height: 1 }, { releaseDigest: "b".repeat(64) }), "identity_mismatch");
  rejects("propose in result view", m(2, "action:propose", { draftId: "d", revision: 1 }), "editor_only", "result");
  rejects("cross-connection navigate", m(2, "ui:navigate", { target: { kind: "object", ref: { adapterId: "balance", connectionId: "other", objectType: "task", canonicalId: "t" } } }), "cross_connection_reference");
  rejects("oversized", m(2, "ui:resize", { height: 1, pad: "x".repeat(70_000) }), "oversized");
  rejects("non-plain", m(2, "ui:resize", { height: new Map() }), "not_plain_json");
  rejects("own __proto__ key", JSON.parse(JSON.stringify(m(2, "ui:resize", { height: 1 })).replace("{", `{"__proto__":{"x":1},`)), "not_plain_json");
  const before = new InboundGate(identity, { objectType: "task", view: "editor" }).admit(m(1, "draft:change", { draftId: "d", baseRevision: 1, changes: [{ pointer: "/t", change: { kind: "omit" } }] }));
  check("message before ready → before_ready", !before.ok && before.violation === "before_ready");
  check("UI wire version equals the package UI protocol version", DESK_UI_WIRE_VERSION === DESK_UI_PROTOCOL_VERSION);
  check("ui:navigate reuses ObjectReferenceSchema", UiMessageSchema.options.some(o => o.shape.type.value === "ui:navigate") && ObjectReferenceSchema.safeParse({ adapterId: "a", connectionId: "c", objectType: "t", canonicalId: "i" }).success);
  const ui = (view: string) => ({ protocolVersion: "1.0.0", entry: "app.html", views: [{ objectType: "task", view }], files: [{ path: "app.html", sha256: "a".repeat(64), mediaType: "text/html" }] });
  check("package contract accepts a 1.0.0 result view", DeskAdapterUiSchema.safeParse(ui("result")).success);
  checks.push({ name: "package contract accepts a 1.0.0 editor view (expected false until the package schema widens)", ok: DeskAdapterUiSchema.safeParse(ui("editor")).success });
  return checks;
}

async function main(): Promise<void> {
  mkdirSync(EVIDENCE, { recursive: true });
  const checks = protocolChecks();
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} protocol: ${c.name}`);
  const { rig, releaseDigest } = await openLabPackage();
  const shellJs = await buildShell();
  const types: Record<string, BrowserType> = { chromium, firefox, webkit };
  const runs: Run[] = [];
  const versions: Record<string, string> = {};
  try {
    await Promise.all(browserArg.map(async name => {
      const type = types[name];
      if (!type) throw new Error(`unknown browser ${name}`);
      const browser = await type.launch();
      versions[name] = browser.version();
      try {
        await Promise.all(ROUTES.flatMap(route => VARIANTS.map(async variant => {
          const evil = await openEvil(route === "hosted");
          const cell = openCell(route, variant, rig, shellJs, evil.origin);
          try {
            for (const [attack, family] of SELECTED) {
              const run = await runAttack(browser, name, cell, evil, attack, family);
              runs.push(run);
              console.log(`${name.padEnd(8)} ${route.padEnd(6)} ${variant.padEnd(8)} ${attack.padEnd(24)} ${run.outcome.padEnd(9)} ${run.mechanism.slice(0, 110)}`);
            }
          } finally { await cell.stop(); evil.stop(); }
        })));
      } finally { await browser.close(); }
    }));
  } finally { await rig.close(); }
  const order = (r: Run) => `${browserArg.indexOf(r.browser)}${ROUTES.indexOf(r.route)}${VARIANTS.indexOf(r.variant)}${String(ATTACKS.findIndex(([a]) => a === r.attack)).padStart(3, "0")}`;
  runs.sort((a, b) => order(a).localeCompare(order(b)));
  writeFileSync(join(EVIDENCE, "results.json"), JSON.stringify({ at: new Date().toISOString(), versions, releaseDigest, protocolChecks: checks, runs }, null, 2));
  writeFileSync(join(EVIDENCE, "matrix.md"), matrix(runs, versions, checks));
  console.log(`\nWrote ${runs.length} runs to ${EVIDENCE}`);
}

function matrix(runs: Run[], versions: Record<string, string>, checks: { name: string; ok: boolean }[]): string {
  const cell = (r: Run | undefined): string => !r ? "—" : ({ contained: "✓", pass: "pass", fail: "**FAIL**", breached: "**✗**", "not-run": "n/r" } as const)[r.outcome];
  const cols = browserArg.flatMap(b => ROUTES.flatMap(route => VARIANTS.map(v => ({ b, route, v }))));
  const short: Record<string, string> = { open: "open", merged: "mrg", combined: "cmb", inline: "inl" };
  const lines = [
    "# Frame containment matrix", "",
    `Browsers: ${Object.entries(versions).map(([b, v]) => `${b} ${v}`).join(", ")}. ✓ contained, **✗** breached, n/r adapter script never ran (so the row proves nothing), pass/FAIL for positive controls. Columns: browser / route / variant (open = uncontained control, merged = production headers from #3325, combined = generation-scoped CSP over network assets, inline = host-inlined single document).`, "",
    `| attack | ${cols.map(c => `${c.b.slice(0, 2)} ${c.route.slice(0, 1)} ${short[c.v]}`).join(" | ")} |`,
    `| --- | ${cols.map(() => "---").join(" | ")} |`,
    ...ATTACKS.filter(([a]) => SELECTED.some(([s]) => s === a)).map(([attack]) => `| ${attack} | ${cols.map(c => cell(runs.find(r => r.attack === attack && r.browser === c.b && r.route === c.route && r.variant === c.v))).join(" | ")} |`),
    "", "## Breaches and failures outside the open control", "",
    ...runs.filter(r => r.variant !== "open" && r.outcome !== "contained" && r.outcome !== "pass").map(r => `- ${r.browser} ${r.route} ${r.variant} \`${r.attack}\`: ${r.mechanism}`),
    "", "## Positive controls", "",
    ...runs.filter(r => r.family === "control").map(r => `- ${r.browser} ${r.route} ${r.variant} \`${r.attack}\` ${r.outcome}: ${r.mechanism}`),
    "", "## Protocol checks", "", ...checks.map(c => `- ${c.ok ? "ok" : "**false**"}: ${c.name}`), "",
  ];
  return lines.join("\n");
}

await main();
