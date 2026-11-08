import { verifyGuardedWriterService } from "./writer-service";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { CommandEvidence, SupervisorReceipt, WriterRecord } from "../conversations/domain-adapters/operations/writer-authority";
import { durableWriterFile, PersistentWriterManifest } from "./writer-manifest";

export interface SupervisorPlatform {
  run(argv: string[]): Promise<{ exitCode: number; stdout: string }>;
  pids(entry: WriterRecord["plan"]["entries"][number]): Promise<number[]>;
  jobs(entry: WriterRecord["plan"]["entries"][number]): Promise<string[]>;
}
export const checkedSupervisorCommand = async (platform: SupervisorPlatform, argv: string[]): Promise<CommandEvidence> => {
  const result = await platform.run(argv);
  if (result.exitCode !== 0) throw new Error(`Supervisor command failed (${result.exitCode}): ${argv.join(" ")}`);
  return { argv, exitCode: 0, stdout: result.stdout };
};
const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export class ManagedWriterSupervisor {
  constructor(private readonly platform: SupervisorPlatform, readonly manifest: PersistentWriterManifest, private readonly launchdDomain: string, private readonly approvedService: { kind: "launchd" | "systemd"; label: string; definition: string }) {}

  private async installLauncher(): Promise<void> {
    await mkdir(this.manifest.root, { recursive: true, mode: 0o700 });
    try { await access(join(this.manifest.root, "launch")); return; }
    catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    const built = await Bun.build({ entrypoints: [join(import.meta.dir, "writer-launcher.ts")], target: "bun", minify: true });
    if (!built.success || !built.outputs[0]) throw new Error("Cannot build persistent managed writer launcher.");
    await durableWriterFile(join(this.manifest.root, "guard.mjs"), await built.outputs[0].text(), 0o500);
    await durableWriterFile(join(this.manifest.root, "launch"), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(join(this.manifest.root, "guard.mjs"))} ${shellQuote(this.manifest.root)} "$@"\n`, 0o500);
  }

  async disable(record: WriterRecord): Promise<CommandEvidence[]> {
    await this.manifest.set(record, false);
    await this.installLauncher();
    const commands: CommandEvidence[] = [];
    for (const entry of record.plan.entries) {
      if (entry.kind === "unmanaged") throw new Error(`Unmanaged writer ${entry.label}: stop it and reconcile process/startup inventory before activation.`);
      commands.push(await checkedSupervisorCommand(this.platform, entry.kind === "launchd" ? ["launchctl", "disable", `${this.launchdDomain}/${entry.label}`] : ["systemctl", "--user", "stop", entry.label]));
    }
    return commands;
  }

  async stop(record: WriterRecord): Promise<CommandEvidence[]> {
    const commands: CommandEvidence[] = [];
    for (const entry of record.plan.entries) {
      if (entry.kind === "unmanaged") throw new Error("Cannot certify an unmanaged writer.");
      if (entry.kind === "launchd") {
        if ((await this.platform.jobs(entry)).length) commands.push(await checkedSupervisorCommand(this.platform, ["launchctl", "bootout", `${this.launchdDomain}/${entry.label}`]));
        else commands.push({ argv: ["inspect-absent-job", entry.label], exitCode: 0, stdout: "absent" });
        await rm(entry.definition, { force: true });
        try { await access(entry.definition); throw new Error("Retired startup definition remains."); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      } else commands.push(await checkedSupervisorCommand(this.platform, ["systemctl", "--user", "mask", entry.label]));
    }
    return commands;
  }

  async verify(record: WriterRecord): Promise<SupervisorReceipt> {
    const commands: CommandEvidence[] = [];
    for (const entry of record.plan.entries) {
      if (entry.kind === "unmanaged" || (await this.platform.pids(entry)).length || (await this.platform.jobs(entry)).length) throw new Error(`Retired writer ${entry.label} still has PIDs/jobs or cannot be inspected; activation remains disabled.`);
      if (entry.kind === "launchd") {
        const disabled = await checkedSupervisorCommand(this.platform, ["launchctl", "print-disabled", this.launchdDomain]);
        if (!new RegExp(`"${entry.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\s*=>\\s*true`).test(disabled.stdout)) throw new Error("Retired launchd label is not persistently disabled.");
        commands.push(disabled);
        try { await access(entry.definition); throw new Error("Retired launchd startup definition remains."); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
      } else {
        const masked = await checkedSupervisorCommand(this.platform, ["systemctl", "--user", "show", entry.label, "--property=UnitFileState", "--value"]);
        if (masked.stdout.trim() !== "masked") throw new Error("Retired systemd unit is not persistently masked.");
        commands.push(masked);
      }
    }
    return { receiptRef: randomUUID(), inventoryRef: record.plan.inventoryRef, stoppedLabels: record.plan.entries.map(entry => entry.label), commands, remainingPids: [], remainingJobs: [] };
  }

  async prepare(record: WriterRecord): Promise<void> {
    if (this.approvedService.kind === "systemd" && basename(this.approvedService.definition) !== this.approvedService.label) throw new Error("Approved systemd definition must match its unit label.");
    await verifyGuardedWriterService(this.approvedService, this.manifest.root, record.plan.binding.stack);
    if (record.plan.entries.some(entry => entry.label === this.approvedService.label)) throw new Error("Approved service must use a distinct guarded label; retired routes remain fenced.");
    await this.manifest.set(record, true);
  }

  async enable(record: WriterRecord): Promise<CommandEvidence[]> {
    const commands: CommandEvidence[] = [];
    try {
    commands.push(await checkedSupervisorCommand(this.platform, this.approvedService.kind === "launchd" ? ["launchctl", "enable", `${this.launchdDomain}/${this.approvedService.label}`] : ["systemctl", "--user", "enable", this.approvedService.definition]));
    if (this.approvedService.kind === "systemd") commands.push(await checkedSupervisorCommand(this.platform, ["systemctl", "--user", "daemon-reload"]));
    if (this.approvedService.kind === "launchd" && (await this.platform.jobs({ ...this.approvedService, pids: [], connectionQualified: true })).length) commands.push(await checkedSupervisorCommand(this.platform, ["launchctl", "bootout", `${this.launchdDomain}/${this.approvedService.label}`]));
    commands.push(await checkedSupervisorCommand(this.platform, this.approvedService.kind === "launchd" ? ["launchctl", "bootstrap", this.launchdDomain, this.approvedService.definition] : ["systemctl", "--user", "start", this.approvedService.label]));
    return commands;
    } catch (error) {
      await this.manifest.set(record, false);
      throw error;
    }
  }
}

export function localSupervisorPlatform(cgroupRoot = "/sys/fs/cgroup"): SupervisorPlatform {
  const run: SupervisorPlatform["run"] = async argv => {
    const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(10_000) });
    const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (stderr) process.stderr.write(stderr);
    return { exitCode, stdout };
  };
  const inspect = async (entry: WriterRecord["plan"]["entries"][number]): Promise<{ pids: number[]; jobs: string[] }> => {
    if (entry.kind === "launchd") {
      const listed = await run(["launchctl", "list"]);
      if (listed.exitCode !== 0 || !listed.stdout.startsWith("PID")) throw new Error("Launchd inventory command failed or returned unknown output.");
      const rows = listed.stdout.trim().split("\n").slice(1).map(line => line.trim().split(/\s+/));
      if (rows.some(row => row.length !== 3)) throw new Error("Launchd inventory is malformed.");
      const matching = rows.filter(row => row[2] === entry.label);
      const pids = matching.flatMap(row => row[0] && /^\d+$/.test(row[0]) ? [Number(row[0])] : []);
      for (const pid of entry.pids) {
        try { process.kill(pid, 0); pids.push(pid); }
        catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
      }
      return { pids, jobs: matching.map(row => row[2] ?? entry.label) };
    }
    if (entry.kind === "unmanaged") throw new Error("Unmanaged process inventory is unavailable.");
    const result = await checkedSupervisorCommand({ run, pids: () => Promise.reject(new Error("unused inspection")), jobs: () => Promise.reject(new Error("unused inspection")) }, ["systemctl", "--user", "show", entry.label, "--property=MainPID,ControlPID,ControlGroup,ActiveState"]);
    const values: Record<string, string> = {};
    for (const line of result.stdout.trim().split("\n")) {
      const at = line.indexOf("=");
      if (at < 1) throw new Error("Malformed systemd inspection output.");
      values[line.slice(0, at)] = line.slice(at + 1);
    }
    if (values.ActiveState !== "inactive" || values.MainPID !== "0" || values.ControlPID !== "0" || values.ControlGroup === undefined) throw new Error("Systemd stop evidence is unavailable.");
    const group = resolve(cgroupRoot, `.${values.ControlGroup}`);
    if (group !== resolve(cgroupRoot) && !group.startsWith(`${resolve(cgroupRoot)}/`)) throw new Error("Invalid cgroup inspection path.");
    const scan = async (path: string): Promise<number[]> => {
      const result = (await readFile(join(path, "cgroup.procs"), "utf8")).trim().split(/\s+/).filter(Boolean).map(Number);
      for (const item of await readdir(path, { withFileTypes: true })) if (item.isDirectory()) result.push(...await scan(join(path, item.name)));
      return result;
    };
    const pids = values.ControlGroup ? await scan(group) : [];
    const pending = await run(["systemctl", "--user", "list-jobs", "--no-legend"]);
    if (pending.exitCode !== 0) throw new Error("Systemd pending job inspection failed.");
    const rows = pending.stdout.trim() ? pending.stdout.trim().split("\n").map(line => line.trim().split(/\s+/)) : [];
    if (rows.some(row => row.length < 4)) throw new Error("Systemd pending job inspection is malformed.");
    const jobs = rows.filter(row => row[1] === entry.label).map(row => row[0] ?? entry.label);
    return { pids: [...pids, ...entry.pids.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error instanceof Error && "code" in error && error.code === "ESRCH") return false; throw error; } })], jobs };
  };
  return { run, pids: async entry => (await inspect(entry)).pids, jobs: async entry => (await inspect(entry)).jobs };
}
