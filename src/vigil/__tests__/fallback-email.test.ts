import { expect, mock, test } from "bun:test";
import { runBoundedProcess, type Spawn } from "../../bus/process-runner";
import { VigilSchema } from "../../common/types/config";
import { createVigilEmailFallback } from "../fallback-email";

const email = { command: "email", account: "alerts", to: "principal@example.test" };
const config = (timeout_ms = 10000) => VigilSchema.parse({ fallback: { email: { ...email, timeout_ms } } });

test("missing email config returns null and warns once at factory creation", () => {
  const warn = mock((_message: string) => {});
  const run = mock(runBoundedProcess);
  expect(createVigilEmailFallback({}, { warn, run })).toBeNull();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0]?.[0]).toContain("vigil.fallback.email");
  expect(run).not.toHaveBeenCalled();
});

test("passes command, subject and multiline body as individual argv entries with default timeout", async () => {
  const run = mock<typeof runBoundedProcess>(async () => ({ ok: true }));
  const warn = mock(() => {});
  const fallback = createVigilEmailFallback(config(), { run, warn });
  const subject = "[Vigil] 2 text(s)";
  const body = "Vigil: goal $(touch /tmp/unwanted) — on-track → off-track\nVigil: `echo never` {token}";
  expect(await fallback?.(subject, body)).toEqual({ ok: true });
  expect(run.mock.calls).toEqual([[["email", "send", "-a", email.account, "-t", email.to, "-s", subject, "-b", body, "--no-markdown"], { timeout_ms: 10000 }]]);
  expect(warn).not.toHaveBeenCalled();
});

test.each([["exit-7", "exit 7"], ["timeout-123ms", "timeout"]])("maps runner failure %s", async (reason, error) => {
  const run = mock<typeof runBoundedProcess>(async () => ({ ok: false, reason }));
  const fallback = createVigilEmailFallback(config(123), { run });
  expect(await fallback?.("subject", "body")).toEqual({ ok: false, error });
  expect(run.mock.calls[0]?.[1]).toEqual({ timeout_ms: 123 });
});

test("spawn failures return a code without exception text", async () => {
  const fallback = createVigilEmailFallback(config(), { run: async () => { throw new Error("command missing"); } });
  expect(await fallback?.("subject", "body")).toEqual({ ok: false, error: "exception" });
});

test.each(["wait:private rendered body", "exit-private rendered body"])("runner reason %s returns only a failure code", async (reason) => {
  const fallback = createVigilEmailFallback(config(), { run: async () => ({ ok: false, reason }) });
  expect(await fallback?.("subject", "body")).toEqual({ ok: false, error: "fallback-failed" });
});

test.each([0, 4])("shared bounded runner handles exit %s without spawning a real process", async (exitCode) => {
  const spawn: Spawn = mock(() => ({ exited: Promise.resolve(exitCode), kill: mock(() => {}) }));
  const fallback = createVigilEmailFallback(config(), { run: (argv, options) => runBoundedProcess(argv, { ...options, spawn }) });
  expect(await fallback?.("subject", "body")).toEqual(exitCode === 0 ? { ok: true } : { ok: false, error: "exit 4" });
});

test.each([false, true])("shared watchdog reports timeout even on clean termination, ignores SIGTERM: %s", async (ignoreSigterm) => {
  const { promise, resolve } = Promise.withResolvers<number>();
  const kill = mock((signal?: string) => {
    if (!ignoreSigterm || signal === "SIGKILL") resolve(0);
  });
  const spawn: Spawn = () => ({ exited: promise, kill });
  const fallback = createVigilEmailFallback(config(5), {
    run: (argv, options) => runBoundedProcess(argv, { ...options, spawn, sigkillGraceMs: 5 }),
  });
  expect(await fallback?.("subject", "body")).toEqual({ ok: false, error: "timeout" });
  expect(kill.mock.calls.map(([signal]) => signal ?? "SIGTERM")).toEqual(ignoreSigterm ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
});
