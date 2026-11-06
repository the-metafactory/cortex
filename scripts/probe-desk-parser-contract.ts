import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ParserRoutingSchema } from "../src/surface/mc/desk/parser-routing";

const { values } = parseArgs({ options: { adapter: { type: "string" }, ranger: { type: "string" } } });
assert(values.adapter && values.ranger, "Pass --adapter and --ranger source checkout directories");
const adapter = resolve(values.adapter), ranger = resolve(values.ranger);
const root = mkdtempSync(join(tmpdir(), "desk-parser-contract-"));
const bin = join(root, "bin"), log = join(root, "calls.jsonl");
mkdirSync(bin);
const env = { HOME: root, PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: root };
const executable = (name: string, code: string) => {
  const path = join(bin, name);
  writeFileSync(path, `#!${process.execPath}\n${code}`, { mode: 0o700 });
  return path;
};
async function run(argv: string[], stdin = "", extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn(argv, { cwd: root, env: { ...env, ...extraEnv }, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  try {
    const [stdout, stderr, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(status, 0, stderr);
    return stdout.trim();
  } finally { clearTimeout(timer); }
}

try {
  for (const path of [adapter, ranger]) await run(["git", "-C", path, "diff", "--exit-code", "HEAD", "--", "src", "bin"]);
  const selector = executable("selector", `const child = Bun.spawn([process.execPath, ${JSON.stringify(join(ranger, "src/cli.ts"))}, ...process.argv.slice(2)], { stdio: ["inherit", "inherit", "inherit"] }); process.exit(await child.exited);`);
  for (const name of ["claude", "codex", "pi"]) executable(name, 'throw new Error("Unexpected quota reader or provider invocation");');
  const provider = executable("provider", `
import { appendFileSync } from "node:fs";
const argv = process.argv.slice(2);
if (argv.includes("--help")) { console.log("--no-tools --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files --no-session --print --mode --system-prompt --provider --model --thinking"); process.exit(0); }
const input = await new Response(Bun.stdin.stream()).text();
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, input }) + "\\n");
const quota = process.env.PROBE_QUOTA === "true" && argv.includes("openai-codex");
console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", stopReason: quota ? "error" : "stop", ...(quota ? { errorMessage: "rate_limit 429", content: [] } : { content: [{ type: "text", text: JSON.stringify({ kind: "note", fields: { text: "Probe" } }) }] }) } }));
process.exit(quota ? 1 : 0);
`);
  const config = join(root, "ranger.json"), routing = join(root, "routing.json");
  writeFileSync(config, JSON.stringify({ version: 1, maps: [{ repo: "example/project", root: 1 }], state: { journalPath: join(root, "journal.db"), worktreesDir: join(root, "worktrees") }, selection: { substrates: ["codex", "pi"] } }));
  writeFileSync(routing, JSON.stringify({ version: 1, ranger: { command: selector, config }, timeoutMs: 15000, permitted: ["codex", "pi"], providers: { codex: { command: provider, model: "test-model" }, pi: { command: provider, provider: "local-test", model: "test-model" } } }));
  const seed = join(root, "seed.ts");
  writeFileSync(seed, `
import { loadConfig } from ${JSON.stringify(join(ranger, "src/config.ts"))};
import { openJournal } from ${JSON.stringify(join(ranger, "src/journal.ts"))};
const journal = openJournal(loadConfig(${JSON.stringify(config)}).config);
try { journal.upsertSubstrateReading({ substrate: "codex", readAt: new Date().toISOString(), fiveHourUsedPct: 10, sevenDayUsedPct: 10, fiveHourResetsAt: null, sevenDayResetsAt: null, resetsAt: null, capped: process.argv[2] === "true", cappedUntil: null }); } finally { journal.close(); }
`);
  const cases = [];
  for (const scenario of [
    { name: "Codex eligible", capped: false, quota: false, permitted: ["codex", "pi"], provider: "codex", attempts: ["codex"] },
    { name: "Codex exhausted to Pi", capped: true, quota: false, permitted: ["codex", "pi"], provider: "pi", attempts: ["pi"] },
    { name: "Codex quota failure to Pi", capped: false, quota: true, permitted: ["codex", "pi"], provider: "pi", attempts: ["codex", "pi"] },
    { name: "no permitted alternative", capped: true, quota: false, permitted: ["codex"], provider: null, attempts: [] },
  ]) {
    await run([process.execPath, seed, String(scenario.capped)]);
    writeFileSync(log, "");
    const output: unknown = JSON.parse(await run([process.execPath, join(adapter, "bin/desk-parse.ts"), "--routing-config", routing], JSON.stringify({ text: "note Probe", now: "2026-11-06T12:00:00Z", timeZone: "UTC", kinds: ["note"], maps: [], routing: { permitted: scenario.permitted } }), { PROBE_QUOTA: String(scenario.quota) }));
    const parsed = z.object({ kind: z.enum(["note", "none"]), routing: ParserRoutingSchema }).parse(output);
    assert.equal(parsed.routing.kind, scenario.provider ? "selected" : "unavailable");
    if (parsed.routing.kind === "selected") assert.equal(parsed.routing.provider, scenario.provider);
    assert.deepEqual(parsed.routing.attempted, scenario.attempts);
    assert.deepEqual(parsed.routing.candidates.find(c => c.substrate === "claude"), { substrate: "claude", reason: "not-configured" });
    const calls = (await Bun.file(log).text()).trim().split("\n").filter(Boolean).map(line => z.object({ argv: z.array(z.string()), input: z.string() }).parse(JSON.parse(line)));
    assert.deepEqual(calls.map(call => call.argv[call.argv.indexOf("--provider") + 1]), scenario.attempts.map(provider => provider === "codex" ? "openai-codex" : "local-test"));
    assert.deepEqual(parsed.routing.fallbackReasons, scenario.quota ? [{ provider: "codex", reason: "quota-exhausted" }] : []);
    for (const call of calls) for (const flag of ["--no-tools", "--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-session"]) assert(call.argv.includes(flag));
    assert(new Set(calls.map(call => call.input)).size <= 1);
    cases.push({ name: scenario.name, permitted: scenario.permitted, output });
  }
  const revision = (path: string) => run(["git", "-C", path, "rev-parse", "HEAD"]);
  process.stdout.write(`${JSON.stringify({ sources: { adapter: await revision(adapter), ranger: await revision(ranger) }, cases }, null, 2)}\n`);
} finally { rmSync(root, { recursive: true, force: true }); }
