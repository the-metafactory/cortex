import { realpath } from "node:fs/promises";
import { implementationDigest, readWriterManifest, writerVersionAtLeast } from "./writer-manifest";

export async function launchManagedWriter(root: string, stack: string, executable: string, args: string[]): Promise<number> {
  const manifest = await readWriterManifest(root);
  const entries = Object.values(manifest.entries).filter(entry => entry.stack === stack);
  if (!entries.length) return passThrough(await realpath(executable), args);
  if (entries.some(entry => !entry.enabled || !entry.receiptRef)) throw new Error("Managed mutation is disabled; resume the explicit verified writer cutover.");
  const selected = await realpath(executable);
  const digest = await implementationDigest(selected);
  if (entries.some(entry => entry.implementation.sha256 !== digest || entry.retiredDigests.includes(digest) || !writerVersionAtLeast(entry.implementation.version, entry.minimumVersion))) throw new Error("Selected managed executable is retired or below the persistent writer floor.");
  const revision = manifest.revision;
  const version = Bun.spawn([selected, "--version"], { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10_000) });
  const [code, stdout, stderr] = await Promise.all([version.exited, new Response(version.stdout).text(), new Response(version.stderr).text()]);
  if (code !== 0 || entries.some(entry => stdout.trim() !== entry.implementation.version)) throw new Error(`Approved executable version verification failed (${code}): ${stderr}`);
  const current = await readWriterManifest(root);
  if (current.revision !== revision || await implementationDigest(selected) !== digest) throw new Error("Writer manifest or executable changed during launch; admission refused.");
  return passThrough(selected, args);
}

function passThrough(selected: string, args: string[]): Promise<number> {
  const child = Bun.spawn([selected, ...args], { stdio: ["inherit", "inherit", "inherit"] });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => { child.kill(signal); });
  return child.exited;
}

if (import.meta.main) {
  const [root, stack, executable, ...args] = process.argv.slice(2);
  try {
    if (!root || !stack || !executable) throw new Error("Managed launcher requires manifest root, stack and executable.");
    process.exitCode = await launchManagedWriter(root, stack, executable, args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Managed launcher refused unknown writer state.");
    process.exitCode = 78;
  }
}
