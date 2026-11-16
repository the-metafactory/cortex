import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodexAuth, createCodexRuntime } from "../src/conversations/codex-auth";

const probeDir = process.argv[2];
if (!probeDir) {
  process.stderr.write("usage: bun scripts/desk-codex-recovery-run.ts <probe-pi-agent-dir>\n");
  process.exit(2);
}
const production = join(process.env.HOME ?? homedir(), ".pi", "agent");
const same = (a: string, b: string): boolean => { try { return realpathSync(a) === realpathSync(b); } catch (_err) { return a === b; } };
if (same(probeDir, production) || same(probeDir, process.env.PI_CODING_AGENT_DIR ?? production)) {
  process.stderr.write("refusing: the probe store must be a throwaway directory, never the production Pi agent directory\n");
  process.exit(2);
}

const auth = new CodexAuth(() => createCodexRuntime(probeDir));
const refreshed = await auth.refresh();
process.stdout.write(`refresh: ${JSON.stringify(refreshed)}\n`);
if (!refreshed.ok) {
  const started = auth.startLogin();
  for (let seen = ""; ; await Bun.sleep(500)) {
    const view = auth.loginState();
    if (!view || view.id !== started.id) break;
    if (view.url && view.url !== seen) { seen = view.url; process.stdout.write(`open: ${view.url}\n`); }
    if (view.state === "awaiting-input" && view.prompt) {
      process.stdout.write(`${view.prompt.message}: `);
      const line = await new Promise<string>(resolve => { process.stdin.once("data", chunk => { resolve(String(chunk).trim()); }); });
      auth.answer(view.id, line);
    }
    if (view.state === "signed-in" || view.state === "failed" || view.state === "cancelled") break;
  }
  await auth.whenSettled();
  process.stdout.write(`sign-in: ${auth.loginState()?.state ?? "none"}\n`);
  process.stdout.write(`refresh after sign-in: ${JSON.stringify(await auth.refresh())}\n`);
}
process.exit(0);
