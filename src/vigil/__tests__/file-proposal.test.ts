import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { initDatabase } from "../../surface/mc/db/init";
import { getAttentionItem } from "../../surface/mc/db/attention";
import { handleAttentionLifecycle, handleListAttention } from "../../surface/mc/api/attention";
import { DEFAULT_CONFIG } from "../../surface/mc/config";
import { startServer } from "../../surface/mc/server";
import { flushVigilResolutions } from "../resolution";
import { runProposalCommand, type ProposalFilingOptions, type ProposalCommandRunner } from "../file-proposal";
import { ingestLedgerEnvelope, ENDED_AT, ledgerEnvelope, temporaryVigilDatabaseFile } from "./fixtures";

const REF = "soma:proposals/proposal.md";
const ID = `att:vigil:proposal:${REF}`;
const NODE = "example/repo#12";
const TOKEN = "principal-test-token-never-persist";
const success = (created = true) => ({ ok: true as const, stdout: JSON.stringify({ ref: NODE, created }) });
const options = (over: ProposalFilingOptions = {}): ProposalFilingOptions => ({
  proposal_token_env: "PROPOSAL_TOKEN", proposal_timeout_ms: 1234,
  env: { PROPOSAL_TOKEN: TOKEN, PATH: "/usr/bin", GH_TOKEN: "machine-token", OTHER_SECRET: "unrelated" },
  ...over,
});
let db: Database;

function seed(database = db) {
  ingestLedgerEnvelope(database, ledgerEnvelope({ outcome: "succeeded", proposal_refs: [REF] }), ENDED_AT);
}

beforeEach(() => { db = initDatabase(":memory:"); seed(); });
afterEach(() => { db.close(); });

test("approval awaits filing, passes argv and child-only principal token, then publishes the filed ref", async () => {
  const run = mock<ProposalCommandRunner>(async (argv, input) => {
    expect(argv).toEqual(["soma", "graph", "file-proposal", REF, "--json"]);
    expect(input).toEqual({ timeout_ms: 1234, env: { PATH: "/usr/bin", GH_TOKEN: TOKEN, SOMA_HOME: "/tmp/proposal-home" } });
    expect(getAttentionItem(db, ID)?.status).toBe("open");
    expect(db.query("SELECT * FROM vigil_attention_resolutions").all()).toEqual([]);
    await Promise.resolve();
    return success();
  });
  const env = options().env!;
  const before = { ...env };
  const response = await handleAttentionLifecycle(db, ID, "resolve", options({ env, run, somaHome: "/tmp/proposal-home" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "resolved", id: ID, filed: NODE });
  expect(env).toEqual(before);
  expect(getAttentionItem(db, ID)).toMatchObject({ status: "resolved", resolution: "approved" });
  const publish = mock<import("../resolution").ResolutionLedger["publish"]>(async () => {});
  await flushVigilResolutions(db, { principal: "example", stack: "default", publish });
  expect(publish).toHaveBeenCalledTimes(1);
  expect(publish.mock.calls[0]?.[0]).toMatchObject({ payload: { key: REF, filed: NODE, resolution: "approved" } });
  expect(JSON.stringify(publish.mock.calls)).not.toContain(TOKEN);
  expect(db.serialize().includes(Buffer.from(TOKEN))).toBe(false);
  expect((await handleAttentionLifecycle(db, ID, "resolve", options({ run }))).status).toBe(404);
  expect(run).toHaveBeenCalledTimes(1);
});

test.each([
  { name: "non-zero exit", result: { ok: false as const, reason: "exit-1" }, status: 502, error: "proposal filing exited non-zero" },
  { name: "timeout", result: { ok: false as const, reason: "timeout-1234ms" }, status: 504, error: "proposal filing timed out" },
  { name: "malformed JSON", result: { ok: true as const, stdout: `bad ${TOKEN}` }, status: 502, error: "invalid proposal filing JSON" },
  { name: "wrong JSON shape", result: { ok: true as const, stdout: '{"ref":"example/repo#12"}' }, status: 502, error: "invalid proposal filing JSON" },
  { name: "invalid node", result: { ok: true as const, stdout: '{"ref":"invalid","created":true}' }, status: 502, error: "proposal filing returned invalid node or resolution could not be recorded" },
  { name: "secret in reason", result: { ok: false as const, reason: `spawn: ${TOKEN}` }, status: 502, error: "proposal filing failed" },
])("$name leaves item open and records a visible safe error without a resolution", async ({ result, status, error }) => {
  const logs = [spyOn(console, "log"), spyOn(console, "warn"), spyOn(console, "error")];
  try {
    const run = mock(async () => result);
    const response = await handleAttentionLifecycle(db, ID, "resolve", options({ run }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    expect(getAttentionItem(db, ID)).toMatchObject({ status: "open", resolution: null });
    expect(db.query("SELECT * FROM vigil_attention_resolutions").all()).toEqual([]);
    const queue = await (await handleListAttention(db)).json();
    expect(queue.attention).toContainEqual(expect.objectContaining({ item: expect.objectContaining({ id: ID }), error }));
    expect(JSON.stringify(queue)).not.toContain(TOKEN);
    expect(db.serialize().includes(Buffer.from(TOKEN))).toBe(false);
    expect(JSON.stringify(logs.flatMap((log) => log.mock.calls))).not.toContain(TOKEN);
    const publish = mock<import("../resolution").ResolutionLedger["publish"]>(async () => {});
    await flushVigilResolutions(db, { principal: "example", stack: "default", publish });
    expect(publish).not.toHaveBeenCalled();
  } finally { for (const log of logs) log.mockRestore(); }
});

test("spawn exceptions containing the token are never returned, persisted or logged", async () => {
  const log = spyOn(console, "error");
  try {
    const response = await handleAttentionLifecycle(db, ID, "resolve", options({ run: async () => { throw new Error(TOKEN); } }));
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain(TOKEN);
    expect(db.serialize().includes(Buffer.from(TOKEN))).toBe(false);
    expect(log).not.toHaveBeenCalled();
    expect(getAttentionItem(db, ID)?.status).toBe("open");
  } finally { log.mockRestore(); }
});

test("retry after a completed filing reported as timeout resolves the same node and clears the error", async () => {
  let filed: string | undefined;
  const run = mock(async () => {
    if (!filed) { filed = NODE; return { ok: false as const, reason: "timeout-1234ms" }; }
    return { ok: true as const, stdout: JSON.stringify({ ref: filed, created: false }) };
  });
  expect((await handleAttentionLifecycle(db, ID, "resolve", options({ run }))).status).toBe(504);
  expect((await handleAttentionLifecycle(db, ID, "resolve", options({ run }))).status).toBe(200);
  expect(db.query("SELECT filed FROM vigil_attention_resolutions").all()).toEqual([{ filed: NODE }]);
  expect(db.query("SELECT filing_error FROM vigil_proposals").get()).toEqual({ filing_error: null });
});

test("a resolution write failure rolls back approval and allows an idempotent retry", async () => {
  db.run("CREATE TRIGGER fail_proposal_receipt BEFORE INSERT ON vigil_attention_resolutions BEGIN SELECT RAISE(ABORT, 'receipt unavailable'); END");
  const run = mock(async () => success(false));
  expect((await handleAttentionLifecycle(db, ID, "resolve", options({ run }))).status).toBe(502);
  expect(getAttentionItem(db, ID)).toMatchObject({ status: "open", resolution: null });
  expect(db.query("SELECT * FROM vigil_attention_resolutions").all()).toEqual([]);
  db.run("DROP TRIGGER fail_proposal_receipt");
  expect((await handleAttentionLifecycle(db, ID, "resolve", options({ run }))).status).toBe(200);
  expect(db.query("SELECT filed FROM vigil_attention_resolutions").all()).toEqual([{ filed: NODE }]);
});

test.each([{}, { proposal_token_env: "MISSING" }, { proposal_token_env: "PROPOSAL_TOKEN", env: { PROPOSAL_TOKEN: "" } }])(
  "missing configured token fails visibly without running", async (config) => {
    const run = mock(async () => success());
    const response = await handleAttentionLifecycle(db, ID, "resolve", { env: {}, ...config, run });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "no proposal token configured" });
    expect(run).not.toHaveBeenCalled();
    expect(getAttentionItem(db, ID)?.status).toBe("open");
  },
);

test.each(["soma:", "soma:/absolute", "soma:proposals/../bad.md", "soma:proposals\\bad.md", "soma:bad\0.md", "--token=bad", "/tmp/bad"])(
  "invalid proposal_ref %s is refused before running", async (ref) => {
    db.query("UPDATE vigil_proposals SET proposal_ref = ? WHERE attention_id = ?").run(ref, ID);
    const run = mock(async () => success());
    expect((await handleAttentionLifecycle(db, ID, "resolve", options({ run }))).status).toBe(400);
    expect(run).not.toHaveBeenCalled();
    expect(getAttentionItem(db, ID)?.status).toBe("open");
  },
);

test("a valid path with shell metacharacters remains one argv argument", async () => {
  const ref = "soma:proposals/$(touch nope); --other.md";
  db.query("UPDATE vigil_proposals SET proposal_ref = ? WHERE attention_id = ?").run(ref, ID);
  const run = mock<ProposalCommandRunner>(async (argv) => { expect(argv).toEqual(["soma", "graph", "file-proposal", ref, "--json"]); return success(); });
  expect((await handleAttentionLifecycle(db, ID, "resolve", options({ run }))).status).toBe(200);
});

test("dismiss requires no token and never runs the filing verb", async () => {
  const run = mock(async () => success());
  expect((await handleAttentionLifecycle(db, ID, "dismiss", { run })).status).toBe(200);
  expect(run).not.toHaveBeenCalled();
  expect(getAttentionItem(db, ID)).toMatchObject({ status: "dismissed", resolution: "dismissed" });
});

test("in-flight filing rejects concurrent approvals and dismissals", async () => {
  const deferred = Promise.withResolvers<ReturnType<typeof success>>();
  const run = mock(() => deferred.promise);
  const first = handleAttentionLifecycle(db, ID, "resolve", options({ run }));
  expect((await handleAttentionLifecycle(db, ID, "resolve", options({ run }))).status).toBe(409);
  expect((await handleAttentionLifecycle(db, ID, "dismiss")).status).toBe(409);
  deferred.resolve(success());
  expect((await first).status).toBe(200);
  expect(run).toHaveBeenCalledTimes(1);
});

test("filing errors survive reopening an existing database and migration is idempotent", async () => {
  using file = temporaryVigilDatabaseFile("proposal-error-");
  const existing = initDatabase(file.path);
  seed(existing);
  existing.run("ALTER TABLE vigil_proposals DROP COLUMN filing_error");
  existing.close();
  for (let n = 0; n < 2; n++) {
    const reopened = initDatabase(file.path);
    try {
      if (n === 0) await handleAttentionLifecycle(reopened, ID, "resolve", {});
      const queue = await (await handleListAttention(reopened)).json();
      expect(queue.attention[0].error).toBe("no proposal token configured");
      expect(getAttentionItem(reopened, ID)?.status).toBe("open");
    } finally { reopened.close(); }
  }
});

test("the default runner captures stdout, suppresses stderr and enforces its watchdog", async () => {
  const result = await runProposalCommand([process.execPath, "-e", "console.error(process.env.GH_TOKEN); console.log(JSON.stringify({ref:'example/repo#12',created:true}))"], {
    timeout_ms: 1000, env: { GH_TOKEN: TOKEN },
  });
  expect(result).toEqual({ ok: true, stdout: `${success().stdout}\n` });
  const timeout = await runProposalCommand([process.execPath, "-e", "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"], {
    timeout_ms: 50, env: {},
  });
  expect(timeout).toEqual({ ok: false, reason: "timeout-50ms" });
});

test("the guarded HTTP route awaits the injected filing runner and rejects an untrusted origin", async () => {
  const run = mock(async () => success(false));
  const ctx = startServer({ ...DEFAULT_CONFIG, port: 0, governance: { localPrincipal: "principal@example.test", principals: ["principal@example.test"] } }, db, {
    vigil: { enabled: true, ...options({ run }) },
  });
  try {
    const url = `http://127.0.0.1:${ctx.port}/api/attention/${encodeURIComponent(ID)}/resolve`;
    const denied = await fetch(url, { method: "POST", headers: { origin: "https://untrusted.example" } });
    expect(denied.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
    const response = await fetch(url, { method: "POST", headers: { origin: `http://127.0.0.1:${ctx.port}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ filed: NODE });
    expect(run).toHaveBeenCalledTimes(1);
  } finally { ctx.stop(true); }
});
