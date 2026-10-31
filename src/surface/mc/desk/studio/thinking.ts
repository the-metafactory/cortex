import { realpath } from "node:fs/promises";
import { z } from "zod";
import type { RangerCli, RangerRunner } from "../actions";
import { runCommand } from "../spawn";
import type { StudioAct } from "./acts";
import type { StudioView } from "./view";

const RunSchema = z.object({
  runUuid: z.uuid(),
  params: z.object({ thread: z.string(), mode: z.string().optional(), requestId: z.string().optional() }),
  status: z.enum(["queued", "running", "succeeded", "failed"]),
  reason: z.string().nullable(),
  startedAt: z.string().nullable(),
  policy: z.enum(["local", "cloud"]).nullable(),
});
const StatusSchema = z.object({ directory: z.string(), dailyRuns: z.object({ local: z.number().int().nonnegative(), cloud: z.number().int().nonnegative() }), runs: z.array(RunSchema) });
export type StudioThinking = { kind: "ready"; dailyRuns: z.infer<typeof StatusSchema>["dailyRuns"]; runs: z.infer<typeof RunSchema>[] } | { kind: "unavailable"; reason: string };

const nativeRun: RangerRunner = (argv) => runCommand(argv, 10_000, undefined, Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL"].map(key => [key, process.env[key]])));
const command = (cli: RangerCli, args: string[]): string[] => [cli.bin, "job", ...args, ...(cli.config ? ["--config", cli.config] : [])];

export async function readThinking(dir: string, cli: RangerCli | undefined, run: RangerRunner = nativeRun): Promise<StudioThinking> {
  if (!cli?.bin) return { kind: "unavailable", reason: "Thinking needs Ranger configured on this stack." };
  try {
    const result = await run(command(cli, ["list", "--studio"]));
    if (result.code !== 0) throw new Error("Ranger could not read its Studio queue.");
    const status = StatusSchema.parse(JSON.parse(result.stdout));
    if (await realpath(status.directory) !== await realpath(dir)) throw new Error("Ranger is configured for another Studio directory.");
    return { kind: "ready", dailyRuns: status.dailyRuns, runs: status.runs };
  } catch {
    return { kind: "unavailable", reason: "The thinking queue is unavailable. Check Ranger's Studio configuration." };
  }
}

export async function withThinking(studio: StudioView, dir: string, cli: RangerCli | undefined, run?: RangerRunner): Promise<StudioView> {
  return { ...studio, thinking: await readThinking(dir, cli, run) };
}

export async function enqueueSparring(input: { studio: StudioView; dir: string; cli: RangerCli | undefined; act: Extract<StudioAct, { act: "spar" }>; requestId: string; run?: RangerRunner }): Promise<{ ok: true; message: string } | { ok: false; status: number; error: string }> {
  const { act, studio, cli } = input;
  const thread = [...studio.active, ...studio.parked, ...studio.closed].find(t => t.slug === act.thread);
  if (!thread) return { ok: false, status: 404, error: "This thread is not in the Studio." };
  if (thread.state === "closed") return { ok: false, status: 409, error: "This thread is closed." };
  if (act.mode.startsWith("persona:") && !studio.personas?.includes(act.mode.slice(8))) return { ok: false, status: 400, error: "Choose a perspective from the configured personas." };
  const thinking = await readThinking(input.dir, cli, input.run);
  if (thinking.kind === "unavailable" || !cli) return { ok: false, status: 503, error: thinking.kind === "unavailable" ? thinking.reason : "Ranger is unavailable." };
  const receipt = thinking.runs.find(run => run.params.requestId === input.requestId);
  if (receipt && (receipt.params.thread !== act.thread || receipt.params.mode !== act.mode)) return { ok: false, status: 409, error: "This request id already belongs to another thinking request." };
  try {
    const result = await (input.run ?? nativeRun)(command(cli, ["enqueue", "ivy-think", "--param", `thread=${act.thread}`, "--param", `mode=${act.mode}`, "--param", `trigger=You asked: ${act.mode}`, "--param", `requestId=${input.requestId}`]));
    if (result.code !== 0) return { ok: false, status: 503, error: "Ranger did not confirm this request. Retry uses the same request id." };
    z.object({ runId: z.number().int().positive(), queued: z.boolean() }).parse(JSON.parse(result.stdout));
    return { ok: true, message: `Asked Ivy: ${act.mode.replaceAll("-", " ")}. The note will appear here when it lands.` };
  } catch {
    return { ok: false, status: 503, error: "The queue receipt was not received. Retry uses the same request id." };
  }
}
