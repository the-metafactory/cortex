import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VIGIL_ATTENTION_RESOLVED_TYPE, validateVigilAttentionResolved } from "@the-metafactory/myelin";
import type { Envelope } from "../../../bus/myelin/envelope-validator";
import { ingestLedgerEnvelope } from "../../../vigil/ingest";
import { ENDED_AT, ledgerEnvelope } from "../../../vigil/__tests__/fixtures";
import { LEDGER_REPLAY_HANDLERS } from "../../../vigil/replay";
import { readSomaOutput } from "../../../vigil/soma-output";
import { DEFAULT_CONFIG } from "../config";
import { initDatabase } from "../db/init";
import { TABLE_NAMES } from "../db/schema";
import { getAttentionItem, setAttentionItemStatus } from "../db/attention";
import { startServer, type ServerContext } from "../server";

const REF = "soma:outputs/G5-2026-W42.md";
const attentionId = (ref = REF) => `att:vigil:result:${ref}`;
let db: Database;
let home: string;
let ctx: ServerContext;
let published: { envelope: Envelope; subject: string }[];
let publish: ReturnType<typeof mock<(envelope: Envelope, subject: string) => Promise<void>>>;

function seed(ref = REF, target = db): void {
  ingestLedgerEnvelope(target, ledgerEnvelope({ outcome: "succeeded", result_ref: ref }), ENDED_AT);
}

function openRef(ref = REF, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${ctx.port}/results/${encodeURIComponent(ref)}`, init);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mc-results-"));
  mkdirSync(join(home, "outputs"));
  writeFileSync(join(home, "outputs", "G5-2026-W42.md"), "# Weekly result\n\nPrivate **draft** contents.\n");
  db = initDatabase(":memory:");
  published = [];
  publish = mock(async (envelope: Envelope, subject: string) => { published.push({ envelope, subject }); });
  ctx = startServer({ ...DEFAULT_CONFIG, hostname: "127.0.0.1", port: 0 }, db, {
    results: { somaHome: home, ledger: { principal: "example", stack: "default", publish } },
    vigil: { enabled: true },
  });
});

afterEach(() => {
  ctx.stop(true);
  db.close();
  rmSync(home, { recursive: true, force: true });
});

test("serves fresh markdown and health on the existing loopback listener without persisting content", async () => {
  seed();
  const response = await openRef();
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.text()).toContain("<h1>Weekly result</h1>");
  writeFileSync(join(home, "outputs", "G5-2026-W42.md"), "# Revised result\n\nPrivate **revised** contents.");
  const revised = await (await openRef()).text();
  expect(revised).toContain("<strong>revised</strong>");
  expect(revised).not.toContain("Weekly result");
  expect((await fetch(`http://127.0.0.1:${ctx.port}/health`)).status).toBe(200);
  expect(ctx.server.hostname).toBe("127.0.0.1");
  for (const table of TABLE_NAMES) {
    const stored = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
    for (const text of ["Weekly result", "Revised result", "Private", "draft", "revised"]) expect(stored).not.toContain(text);
  }
});

test("renders an existing output even without an attention item", async () => {
  expect((await openRef()).status).toBe(200);
  expect(db.query("SELECT * FROM vigil_attention_resolutions").all()).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

test.each([
  "soma:outputs/../outside.md", "soma:outputs/a/../../outside.md", "soma:outputs//etc/passwd",
  "soma:outputs/C:/outside.md", "soma:outputs/", "soma:outputs/missing.md", "soma:profile/goals/G5.md",
  "/etc/passwd", "soma:/etc/passwd", "soma:outputs/escape.md", "soma:outputs/escape-dir/outside.md",
  "soma:outputs/neighbor/outside.md", "soma:outputs/folder", "soma:outputs/back\\slash.md", "soma:outputs/null\0.md",
])("returns 404 without reading another file or resolving attention for %s", async (ref) => {
  writeFileSync(join(home, "outside.md"), "Outside secret");
  mkdirSync(join(home, "outputs-neighbor"));
  writeFileSync(join(home, "outputs-neighbor", "outside.md"), "Outside secret");
  symlinkSync(join(home, "outside.md"), join(home, "outputs", "escape.md"));
  symlinkSync(home, join(home, "outputs", "escape-dir"));
  symlinkSync(join(home, "outputs-neighbor"), join(home, "outputs", "neighbor"));
  mkdirSync(join(home, "outputs", "folder"));
  seed();
  const response = await openRef(ref);
  expect(response.status).toBe(404);
  expect(await response.text()).toBe("Not Found");
  expect(getAttentionItem(db, attentionId())?.status).toBe("open");
  expect(db.query("SELECT * FROM vigil_attention_resolutions").all()).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

test("refuses encoded dot-dot and malformed encoding over HTTP", async () => {
  writeFileSync(join(home, "outside.md"), "Outside secret");
  const base = `http://127.0.0.1:${ctx.port}/results/`;
  for (const suffix of ["soma%3Aoutputs%2F%2e%2e%2Foutside.md", "soma:outputs/%2e%2e/outside.md", "%", "%FF", "soma%3Aoutputs%2F%00"]) {
    const response = await fetch(base + suffix);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Outside secret");
  }
});

test("escaping realpaths and traversal never open a file", async () => {
  writeFileSync(join(home, "outside.md"), "Outside secret");
  symlinkSync(join(home, "outside.md"), join(home, "outputs", "escape.md"));
  const open = spyOn(fs, "open");
  try {
    for (const ref of ["soma:outputs/escape.md", "soma:outputs/../outside.md", "soma:outputs//outside.md", "soma:outputs/missing.md"]) {
      expect(await readSomaOutput(ref, home)).toBeNull();
    }
    expect(open).not.toHaveBeenCalled();
  } finally {
    open.mockRestore();
  }
});

test("allows nested files and symlinks whose realpath remains under outputs", async () => {
  mkdirSync(join(home, "outputs", "nested"));
  writeFileSync(join(home, "outputs", "nested", "note.md"), "# Nested result");
  symlinkSync(join(home, "outputs", "nested", "note.md"), join(home, "outputs", "alias.md"));
  for (const ref of ["soma:outputs/nested/note.md", "soma:outputs/alias.md"]) {
    expect(await (await openRef(ref)).text()).toContain("<h1>Nested result</h1>");
  }
  unlinkSync(join(home, "outputs", "nested", "note.md"));
  expect((await openRef("soma:outputs/alias.md")).status).toBe(404);
});

test("disables raw HTML and sanitizes generated links under restrictive CSP", async () => {
  writeFileSync(join(home, "outputs", "G5-2026-W42.md"), `# Hostile result

<script>fetch('/api/attention')</script>
<img src=x onerror="alert(1)">
<svg onload="alert(1)"><a href="javascript:alert(1)">SVG</a></svg>

[bad](javascript:alert%281%29)
[encoded](jav&#x61;script:alert%281%29)
[control](java&#x09;script:alert%281%29)
[data](data:text/html,evil)
[relative](/api/attention)
[good](https://example.test/result)
![bad image](javascript:alert%281%29)
`);
  const response = await openRef();
  expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'none'; style-src 'self' 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  const html = await response.text();
  expect(html).toContain("&lt;script&gt;");
  const tags: string[] = [];
  const attributes: [string, string][] = [];
  new HTMLRewriter().on("*", { element(el) { tags.push(el.tagName); attributes.push(...el.attributes); } }).transform(html);
  expect(tags).not.toContain("script");
  expect(tags).not.toContain("img");
  expect(tags).not.toContain("svg");
  expect(attributes.filter(([name]) => name.startsWith("on"))).toEqual([]);
  expect(attributes.filter(([name]) => name === "href")).toEqual([["href", "https://example.test/result"]]);
});

test("concurrent opens resolve read and publish exactly one metadata-only ledger line", async () => {
  seed();
  const responses = await Promise.all(Array.from({ length: 5 }, () => openRef()));
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(getAttentionItem(db, attentionId())).toMatchObject({ status: "resolved", resolution: "read" });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(published[0]?.subject).toBe("local.example.default.vigil.attention.resolved");
  const receipt = published[0]!.envelope;
  const { id, source, type, timestamp, sovereignty, payload } = receipt;
  expect(validateVigilAttentionResolved({ id, source, type, timestamp, sovereignty, payload })).toEqual({ valid: true, errors: [] });
  expect(receipt.payload).toEqual({ key: REF, kind: "result", resolution: "read", ran_ref: "daily-sweep", resolved_at: expect.any(String) });
  expect(db.query("SELECT * FROM vigil_attention_resolutions").all()).toHaveLength(1);
  const before = db.query("SELECT total_changes() AS changes").get();
  expect((await openRef()).status).toBe(200);
  expect(db.query("SELECT total_changes() AS changes").get()).toEqual(before);
  expect(publish).toHaveBeenCalledTimes(1);
});

test.each(["dismissed", "expired", "superseded"] as const)("opening a %s item preserves its resolution", async (resolution) => {
  seed();
  setAttentionItemStatus(db, attentionId(), resolution === "dismissed" ? "dismissed" : "resolved", resolution);
  expect((await openRef()).status).toBe(200);
  expect(getAttentionItem(db, attentionId())?.resolution).toBe(resolution);
  expect(db.query("SELECT * FROM vigil_attention_resolutions").all()).toEqual([]);
  expect(publish).not.toHaveBeenCalled();
});

test("failed publication keeps a durable read receipt and retries with the same envelope ID", async () => {
  seed();
  publish.mockImplementationOnce(async (envelope, subject) => {
    published.push({ envelope, subject });
    throw new Error("bus unavailable");
  });
  const warning = spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    expect((await openRef()).status).toBe(200);
    expect(getAttentionItem(db, attentionId())?.resolution).toBe("read");
    expect(db.query("SELECT published FROM vigil_attention_resolutions").get()).toEqual({ published: 0 });
    expect((await openRef()).status).toBe(200);
    expect(published).toHaveLength(2);
    expect(published[0]?.envelope).toEqual(published[1]?.envelope);
    expect(db.query("SELECT published FROM vigil_attention_resolutions").get()).toEqual({ published: 1 });
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    warning.mockRestore();
  }
});

test("LEDGER replay restores read state and receipt without re-emitting", async () => {
  seed();
  await openRef();
  const rebuilt = initDatabase(":memory:");
  try {
    seed(REF, rebuilt);
    const handler = LEDGER_REPLAY_HANDLERS.get(VIGIL_ATTENTION_RESOLVED_TYPE)!;
    expect(handler(rebuilt, published[0]!.envelope)).toBeUndefined();
    expect(handler(rebuilt, published[0]!.envelope)).toBeUndefined();
    expect(getAttentionItem(rebuilt, attentionId())).toMatchObject({ status: "resolved", resolution: "read" });
    expect(rebuilt.query("SELECT published FROM vigil_attention_resolutions").all()).toEqual([{ published: 1 }]);
    expect(publish).toHaveBeenCalledTimes(1);
  } finally {
    rebuilt.close();
  }
});

test("rejects non-GET methods and foreign Host or Origin without reading an item", async () => {
  seed();
  expect((await openRef(REF, { method: "POST" })).status).toBe(405);
  expect((await openRef(REF, { method: "HEAD" })).status).toBe(405);
  expect((await openRef(REF, { headers: { host: "foreign.example" } })).status).toBe(403);
  expect((await openRef(REF, { headers: { origin: "https://foreign.example" } })).status).toBe(403);
  expect(getAttentionItem(db, attentionId())?.status).toBe("open");
  expect(publish).not.toHaveBeenCalled();
});

test("does not expose the route on a non-loopback bind", async () => {
  seed();
  ctx.stop(true);
  ctx = startServer({ ...DEFAULT_CONFIG, hostname: "0.0.0.0", port: 0 }, db, { results: { somaHome: home } });
  expect((await openRef()).status).toBe(404);
  expect(getAttentionItem(db, attentionId())?.status).toBe("open");
});

const PROPOSAL = "soma:proposals/first.md";
function openProposal(ref = PROPOSAL, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${ctx.port}/proposals/${encodeURIComponent(ref)}`, init);
}

function seedProposal(): void {
  mkdirSync(join(home, "proposals"));
  writeFileSync(join(home, "proposals", "first.md"), "# Private proposal title\nPrivate **proposal body**\n<script>alert(1)</script>\n[bad](javascript:alert(1))");
  ingestLedgerEnvelope(db, ledgerEnvelope({ outcome: "succeeded", proposal_refs: [PROPOSAL] }), ENDED_AT);
}

test("proposal markdown is sanitized and fresh, opening never resolves or copies content to MC or LEDGER", async () => {
  seedProposal();
  const before = db.query("SELECT total_changes() AS changes").get();
  const response = await openProposal();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("content-security-policy")).toContain("script-src 'none'");
  const html = await response.text();
  expect(html).toContain("<h1>Private proposal title</h1>");
  expect(html).toContain("<strong>proposal body</strong>");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain('href="javascript:');
  writeFileSync(join(home, "proposals", "first.md"), "# Revised proposal title\nPrivate revised proposal");
  expect(await (await openProposal()).text()).toContain("<h1>Revised proposal title</h1>");
  expect(getAttentionItem(db, `att:vigil:proposal:${PROPOSAL}`)).toMatchObject({ status: "open", resolution: null });
  expect(db.query("SELECT total_changes() AS changes").get()).toEqual(before);
  expect(publish).not.toHaveBeenCalled();
  for (const table of TABLE_NAMES) {
    const stored = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
    for (const text of ["Private proposal title", "proposal body", "Revised proposal title", "Private revised proposal"]) expect(stored).not.toContain(text);
  }
});

test.each([
  "../outside.md", "a/../../outside.md", "%2e%2e/outside.md", "%252e%252e/outside.md", "/etc/passwd",
  "C:/outside.md", "", "missing.md", "escape.md", "escape-dir/outside.md", "neighbor/outside.md",
  "folder", "back\\slash.md", "null\0.md",
])("proposal containment refuses %s", async (relative) => {
  seedProposal();
  writeFileSync(join(home, "outside.md"), "Outside secret");
  mkdirSync(join(home, "proposals-neighbor"));
  writeFileSync(join(home, "proposals-neighbor", "outside.md"), "Outside secret");
  symlinkSync(join(home, "outside.md"), join(home, "proposals", "escape.md"));
  symlinkSync(home, join(home, "proposals", "escape-dir"));
  symlinkSync(join(home, "proposals-neighbor"), join(home, "proposals", "neighbor"));
  mkdirSync(join(home, "proposals", "folder"));
  for (const encoded of ["%2e%2e", "%252e%252e"]) {
    mkdirSync(join(home, "proposals", encoded));
    writeFileSync(join(home, "proposals", encoded, "outside.md"), "Encoded traversal file");
  }
  const response = await openProposal(`soma:proposals/${relative}`);
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("Outside secret");
  expect(getAttentionItem(db, `att:vigil:proposal:${PROPOSAL}`)?.status).toBe("open");
  expect(publish).not.toHaveBeenCalled();
});

test("proposal route refuses absolute refs, cross-directory refs and encoded traversal over HTTP", async () => {
  seedProposal();
  for (const ref of ["/etc/passwd", "soma:/etc/passwd", REF, "soma:profile/goals/G5.md"]) {
    expect((await openProposal(ref)).status).toBe(404);
  }
  const base = `http://127.0.0.1:${ctx.port}/proposals/`;
  for (const suffix of ["soma%3Aproposals%2F%2e%2e%2Foutside.md", "soma:proposals/%2e%2e/outside.md", "%", "%FF"]) {
    expect((await fetch(base + suffix)).status).toBe(404);
  }
  expect((await openRef(PROPOSAL)).status).toBe(404);
});

test("proposal route permits nested files and contained symlinks with no attention item", async () => {
  seedProposal();
  mkdirSync(join(home, "proposals", "nested"));
  writeFileSync(join(home, "proposals", "nested", "allowed.md"), "# Nested proposal");
  symlinkSync(join(home, "proposals", "nested", "allowed.md"), join(home, "proposals", "link.md"));
  for (const ref of ["soma:proposals/nested/allowed.md", "soma:proposals/link.md"]) {
    const response = await openProposal(ref);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<h1>Nested proposal</h1>");
  }
  expect(publish).not.toHaveBeenCalled();
});

test("proposal route keeps the result route's loopback, method and rebind guards", async () => {
  seedProposal();
  expect((await openProposal(PROPOSAL, { method: "POST" })).status).toBe(405);
  expect((await openProposal(PROPOSAL, { method: "HEAD" })).status).toBe(405);
  expect((await openProposal(PROPOSAL, { headers: { host: "foreign.example" } })).status).toBe(403);
  expect((await openProposal(PROPOSAL, { headers: { origin: "https://foreign.example" } })).status).toBe(403);
  ctx.stop(true);
  ctx = startServer({ ...DEFAULT_CONFIG, hostname: "0.0.0.0", port: 0 }, db, { results: { somaHome: home } });
  expect((await openProposal()).status).toBe(404);
});
