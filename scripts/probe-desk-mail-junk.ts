import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startServer } from "../src/surface/mc/server";
import { DEFAULT_CONFIG } from "../src/surface/mc/config";
import { initDatabase } from "../src/surface/mc/db/init";
import type { SourceMail } from "../src/surface/mc/desk/sources/command";
import type { DeskView } from "../src/surface/mc/desk/types";
import { trustedViews } from "../src/surface/mc/desk/mail-trust";
import { suspicionContext, suspicionOf } from "../src/surface/mc/desk/mail-suspicion";
import { runWithTemporaryHome } from "./probe-temp-home";
import { buildDeskProbeBundle, deskProbeEntry, serveDeskProbe } from "./lib/desk-browser-probe";

const provider = `
const [mode, path] = process.argv.slice(2);
const state = await Bun.file(path).json();
if (mode === "read") process.stdout.write(JSON.stringify(state));
else {
  const request = JSON.parse(await Bun.stdin.text());
  const restore = request.action === "restore" && request.from === "junk";
  const spam = request.action === "move" && request.target === "junk";
  const from = restore ? state.junk : state.items;
  const to = restore ? state.items : state.junk;
  const index = from.findIndex(mail => mail.id === request.messageId && mail.account === request.account);
  if ((!restore && !spam) || index < 0) { process.stderr.write("Fixture location conflict"); process.exit(3); }
  to.push(...from.splice(index, 1));
  await Bun.write(path, JSON.stringify(state));
  process.stdout.write(JSON.stringify({ folder: restore ? "INBOX" : "Junk" }));
}
`;

async function probe() {
  const dir = await mkdtemp(join(tmpdir(), "desk-junk-"));
  const db = initDatabase(join(dir, "mc.sqlite"));
  const script = join(dir, "provider.ts");
  const statePath = join(dir, "mailbox.json");
  const at = new Date(Date.now() - 1000).toISOString();
  const junk: SourceMail[] = ["one", "two"].map(id => ({ kind: "mail", id, from: { address: `${id}@example.org` }, subject: `Fixture ${id}`, receivedAt: at, account: "fixture", unread: true, firstParagraph: "PRIVATE JUNK BODY", headers: { replyTo: "other@example.net" } }));
  const first = junk[0];
  assert(first);
  const later = { ...first, id: "later", subject: "Later sender mail" };
  assert.deepEqual(suspicionOf(later, suspicionContext(db)).map(r => r.code), ["reply-to"]);
  await writeFile(script, provider);
  await writeFile(statePath, JSON.stringify({ items: [later], junk }));
  const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { principals: ["principal@example.org"] } }, db, { desk: {
    enabled: true, displayName: "", topN: 5, rangerUrl: "", areas: [],
    sources: [{ id: "fixture-mail", command: [process.execPath, script, "read", statePath], everySeconds: 300, timeoutSeconds: 10 }],
    mailActions: { move: [process.execPath, script, "move", statePath], timeoutSeconds: 10 },
  } });
  const base = `http://localhost:${ctx.port}`;
  const get = async (): Promise<DeskView> => {
    const response = await fetch(`${base}/api/desk`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const post = async (body: unknown) => fetch(`${base}/api/desk/mail`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, "Cf-Access-Authenticated-User-Email": "principal@example.org" }, body: JSON.stringify(body) });
  let browser;
  let pageServer;
  try {
    const before = await get();
    const reviews = before.items.filter(i => i.kind === "mail-junk");
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0]?.junkReview?.mails.length, 2);
    assert.equal(before.items.find(i => i.key === "mail:later")?.suspicious, true);
    assert(!JSON.stringify(reviews).includes("PRIVATE JUNK BODY"));
    console.log("GET /api/desk: 200, one review item, two junk headers, no body.");
    const key = reviews[0]?.junkReview?.mails[0]?.key;
    assert(key);
    let undo: string;
    if (process.env.DESK_JUNK_BROWSER === "1") {
      pageServer = serveDeskProbe(await buildDeskProbeBundle(deskProbeEntry("desk-attention/browser-probe.tsx")), { desk: get, extra: async (request, url) => url.pathname === "/api/desk/mail" ? post(await request.json()) : url.pathname.startsWith("/api/") ? fetch(`${base}${url.pathname}${url.search}`) : null });
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(pageServer.url.toString());
      await page.getByRole("region", { name: "Catch-up preview" }).getByRole("button", { name: /Open inbox/ }).click();
      await page.getByRole("button", { name: "Review Junk in fixture", exact: true }).click();
      const list = page.getByRole("list", { name: "Recent junk mail" });
      assert.equal(await list.getByRole("button", { name: "Not spam", exact: true }).count(), 2);
      await page.waitForFunction(() => { const panel = document.querySelector("aside.desk-panel"); return panel && panel.getBoundingClientRect().right <= innerWidth + 1; });
      await page.screenshot({ path: "/tmp/node-3649-junk-review.png", fullPage: true, animations: "disabled" });
      await list.getByRole("button", { name: "Not spam", exact: true }).first().click();
      await page.getByText("Moved back to INBOX.", { exact: true }).first().waitFor();
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Recent junk mail"] button').length === 1);
      assert.equal(await list.getByRole("button", { name: "Not spam", exact: true }).count(), 1);
      await page.screenshot({ path: "/tmp/node-3649-junk-restored.png", fullPage: true, animations: "disabled" });
      undo = (await get()).autonomy.done.find(d => d.title.startsWith("Not spam:"))?.undo ?? "";
      console.log("Browser: two review controls; Not spam restores one, leaves the other and shows its receipt.");
    } else {
      const response = await post({ action: "mail.notspam", key });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.ok, true);
      undo = result.undo;
      console.log(`POST mail.notspam: 200, ${result.message}, Undo offered.`);
    }
    assert(undo);
    const mailbox = JSON.parse(await readFile(statePath, "utf8"));
    assert.deepEqual(mailbox.items.map((m: SourceMail) => m.id), ["later", "one"]);
    assert.deepEqual(mailbox.junk.map((m: SourceMail) => m.id), ["two"]);
    assert.equal((await get()).items.find(i => i.kind === "mail-junk")?.junkReview?.mails.length, 1);
    const trustedMail = (await get()).items.find(i => i.key === "mail:later");
    assert(trustedMail);
    assert.equal(trustedMail.suspicious, undefined);
    assert.equal(trustedViews(db)[0]?.notSpam, true);
    assert.equal(trustedViews(db)[0]?.sender, "one@example.org");
    assert.deepEqual(suspicionOf(later, suspicionContext(db)), []);
    assert(suspicionOf({ ...later, headers: { authResults: { dmarc: "fail" } } }, suspicionContext(db)).some(r => r.code === "dmarc"));
    assert.equal((await get()).autonomy.done[0]?.undo, undo);
    console.log("Mailbox: one in INBOX, two in Junk. Trusted sender: one@example.org; later mail waives Reply-To, DMARC failures still flag.");
    const undone = await post({ action: "undo", move: undo });
    assert.equal(undone.status, 200);
    assert.equal(trustedViews(db).length, 0);
    assert.deepEqual(suspicionOf(later, suspicionContext(db)).map(r => r.code), ["reply-to"]);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).junk.length, 2);
    assert.equal((await get()).items.find(i => i.kind === "mail-junk")?.junkReview?.mails.length, 2);
    assert.equal((await get()).items.find(i => i.key === "mail:later")?.suspicious, true);
    console.log("POST Undo: 200, back in Junk; both review rows return; trusted correction withdrawn.");
  } finally {
    await browser?.close();
    await pageServer?.stop(true);
    ctx.stop(true);
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

await runWithTemporaryHome(import.meta.path, probe);
