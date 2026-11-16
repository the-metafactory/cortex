import { describe, expect, test } from "bun:test";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { CodexAuth, isCodexAuthExpiry, type CodexRuntime } from "../codex-auth";

interface Fake extends CodexRuntime { calls: { providerId: string; minOAuthValidityMs?: number }[]; release: () => void }
function fake(options: { auth?: "ok" | "none" | "reject"; login?: (interaction: AuthInteraction) => Promise<void> } = {}): Fake {
  const calls: Fake["calls"] = [];
  let release = (): void => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  return {
    calls, release,
    async getAuth(providerId, overrides) {
      calls.push({ providerId, ...(overrides?.minOAuthValidityMs !== undefined ? { minOAuthValidityMs: overrides.minOAuthValidityMs } : {}) });
      await gate;
      if (options.auth === "reject") throw new Error("invalid_grant secret-token-value");
      return options.auth === "none" ? undefined : { auth: {}, source: "stored" };
    },
    async login(_provider, _type, interaction) { await options.login?.(interaction); return {} as never; },
  };
}

describe("codex authentication expiry", () => {
  test("only the codex provider's expiry text is recognized", () => {
    expect(isCodexAuthExpiry("openai-codex", "pi did not answer: Your authentication token has expired. Please try refreshing it.")).toBe(true);
    expect(isCodexAuthExpiry("spark", "Your authentication token has expired.")).toBe(false);
    expect(isCodexAuthExpiry("openai-codex", "rate limit exceeded")).toBe(false);
  });
});

describe("codex refresh", () => {
  test("forces a refresh past the advertised expiry through Pi's public auth route", async () => {
    const runtime = fake();
    runtime.release();
    expect(await new CodexAuth(() => Promise.resolve(runtime)).refresh()).toEqual({ ok: true });
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]?.providerId).toBe("openai-codex");
    expect(runtime.calls[0]?.minOAuthValidityMs).toBeGreaterThan(5 * 365 * 24 * 3600 * 1000);
  });

  test("concurrent failures share one refresh", async () => {
    const runtime = fake();
    const auth = new CodexAuth(() => Promise.resolve(runtime));
    const both = Promise.all([auth.refresh(), auth.refresh(), auth.refresh()]);
    runtime.release();
    expect(await both).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(runtime.calls).toHaveLength(1);
  });

  test("a rejected refresh and a missing sign-in are reported without the provider's text", async () => {
    const rejected = fake({ auth: "reject" });
    rejected.release();
    const result = await new CodexAuth(() => Promise.resolve(rejected)).refresh();
    expect(result).toEqual({ ok: false, reason: "rejected" });
    expect(JSON.stringify(result)).not.toContain("secret-token-value");
    const none = fake({ auth: "none" });
    none.release();
    expect(await new CodexAuth(() => Promise.resolve(none)).refresh()).toEqual({ ok: false, reason: "not-signed-in" });
  });
});

describe("codex reconnect", () => {
  test("shows the sign-in link, takes the pasted answer and ends signed in", async () => {
    let received = "";
    const runtime = fake({ login: async interaction => {
      interaction.notify({ type: "auth_url", url: "https://auth.example.invalid/start" });
      received = await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
    } });
    const auth = new CodexAuth(() => Promise.resolve(runtime));
    const started = auth.startLogin();
    await Bun.sleep(20);
    const waiting = auth.loginState();
    expect(waiting?.state).toBe("awaiting-input");
    expect(waiting?.url).toBe("https://auth.example.invalid/start");
    expect(auth.startLogin().id).toBe(started.id);
    expect(auth.answer("someone-else", "x")).toBeNull();
    auth.answer(started.id, "pasted-code");
    await auth.whenSettled();
    expect(received).toBe("pasted-code");
    expect(auth.loginState()?.state).toBe("signed-in");
    expect(JSON.stringify(auth.loginState())).not.toContain("pasted-code");
  });

  test("cancelling leaves an actionable message", async () => {
    const runtime = fake({ login: async interaction => { await interaction.prompt({ type: "manual_code", message: "Paste" }); } });
    const auth = new CodexAuth(() => Promise.resolve(runtime));
    const { id } = auth.startLogin();
    await Bun.sleep(20);
    auth.cancel(id);
    await auth.whenSettled();
    expect(auth.loginState()?.state).toBe("cancelled");
    expect(auth.loginState()?.error).toContain("message is still in the conversation");
  });

  test("a failed sign-in reports a restartable failure", async () => {
    const runtime = fake({ login: () => Promise.reject(new Error("access_denied")) });
    const auth = new CodexAuth(() => Promise.resolve(runtime));
    auth.startLogin();
    await auth.whenSettled();
    expect(auth.loginState()).toMatchObject({ state: "failed", error: "The sign-in did not complete. Start it again." });
    expect(auth.startLogin().state).toBe("starting");
  });
});
