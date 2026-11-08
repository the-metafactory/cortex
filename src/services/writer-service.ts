import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { durableWriterFile } from "./writer-manifest";

export interface GuardedWriterService { kind: "launchd" | "systemd"; label: string; definition: string }
const xmlEscape = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
export async function renderGuardedWriterService(service: GuardedWriterService, root: string, stack: string, executable: string, config: string, home: string): Promise<void> {
  if (![root, stack, executable, config, home, service.label].every(value => value.length > 0 && !/[\r\n]/.test(value))) throw new Error("Invalid managed service route.");
  const launcher = join(root, "launch");
  const args = [launcher, stack, executable, "start", "--config", config];
  let content: string;
  if (service.kind === "launchd") {
    content = await readFile(join(import.meta.dir, "ai.meta-factory.cortex.stack.plist"), "utf8");
    content = content.replace("ai.meta-factory.cortex.__STACK_SLUG__", xmlEscape(service.label))
      .replace(/<array>[\s\S]*?<\/array>/, `<array>${args.map(value => `<string>${xmlEscape(value)}</string>`).join("")}</array>`);
    const replacements: Record<string, string> = { __HOME__: home, __STACK_SLUG__: stack, __CONFIG_PATH__: config, __WORKSPACE_DIR__: join(home, ".local/share/metafactory/cortex", stack, "workspace") };
    for (const [key, value] of Object.entries(replacements)) content = content.replaceAll(key, xmlEscape(value));
  } else {
    const quote = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;
    content = (await readFile(join(import.meta.dir, "cortex@.service"), "utf8"))
      .replace(/^ExecStart=.*$/m, `ExecStart=${args.map(quote).join(" ")}`).replaceAll("%i", stack.replaceAll("%", "%%"));
  }
  await durableWriterFile(service.definition, content, 0o600);
}

export async function readGuardedWriterService(service: GuardedWriterService): Promise<{ label: string; argv: string[] }> {
  const source = await readFile(service.definition, "utf8");
  const script = service.kind === "launchd" ? "import plistlib,sys,json; p=plistlib.loads(sys.stdin.buffer.read()); print(json.dumps([p['Label'],p['ProgramArguments']]))" : "import sys,shlex,json; s=sys.stdin.read(); a=[line.split('=',1)[1] for line in s.splitlines() if line.startswith('ExecStart=')]; assert len(a)==1; print(json.dumps(['',shlex.split(a[0])]))";
  const child = Bun.spawn(["python3", "-c", script], { stdin: new Blob([source]), stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (code !== 0) throw new Error(`Cannot verify guarded service route: ${stderr}`);
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed) || typeof parsed[0] !== "string" || !Array.isArray(parsed[1]) || !parsed[1].every((value: unknown) => typeof value === "string")) throw new Error("Unknown managed service command.");
  return { label: parsed[0], argv: parsed[1] };
}

export async function verifyGuardedWriterService(service: GuardedWriterService, root: string, stack: string): Promise<void> {
  const selected = await readGuardedWriterService(service);
  if (selected.argv[0] !== join(root, "launch") || selected.argv[1] !== stack || service.kind === "launchd" && selected.label !== service.label) throw new Error("Approved service must enter the persistent launcher for the exact stack.");
}
