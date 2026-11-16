import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AuthEvent, AuthInteraction, AuthPrompt, AuthResult, Credential } from "@earendil-works/pi-ai";

import { CODEX_PROVIDER, type LoginView } from "./codex-auth-contract";

export { CODEX_SIGN_IN_NEEDED } from "./codex-auth-contract";
const FORCE_REFRESH_VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 60 * 1000;
const EXPIRY_PATTERN = /authentication token (?:has )?expired|try refreshing it|token_expired|refresh token (?:has )?(?:expired|been revoked)/i;

export const isCodexAuthExpiry = (provider: string, message: string): boolean => provider === CODEX_PROVIDER && EXPIRY_PATTERN.test(message);

export interface CodexRuntime {
  getAuth(providerId: string, overrides?: { minOAuthValidityMs?: number; signal?: AbortSignal }): Promise<AuthResult | undefined>;
  login(providerId: string, type: "oauth", interaction: AuthInteraction): Promise<Credential>;
}

export type RefreshOutcome = { ok: true } | { ok: false; reason: "not-signed-in" | "rejected" | "timeout" | "cancelled" };

interface Pending { message: string; options?: { id: string; label: string }[]; resolve: (answer: string) => void; reject: (error: Error) => void }
interface Login { view: LoginView; abort: AbortController; pending: Pending | null; done: Promise<void> }

function piAuthPath(agentDir: string): string {
  return join(agentDir, "auth.json");
}

export async function createCodexRuntime(agentDir: string): Promise<CodexRuntime> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  return ModelRuntime.create({ authPath: piAuthPath(agentDir), refreshOnCreate: false });
}

export class CodexAuth {
  private runtime: Promise<CodexRuntime> | null = null;
  private refreshing: Promise<RefreshOutcome> | null = null;
  private current: Login | null = null;

  constructor(private readonly open: () => Promise<CodexRuntime>) {}

  private runtimeOf(): Promise<CodexRuntime> {
    this.runtime ??= this.open().catch((error: unknown) => { this.runtime = null; throw error; });
    return this.runtime;
  }

  refresh(signal?: AbortSignal): Promise<RefreshOutcome> {
    this.refreshing ??= this.refreshOnce(signal).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async refreshOnce(signal?: AbortSignal): Promise<RefreshOutcome> {
    const timeout = AbortSignal.timeout(REFRESH_TIMEOUT_MS);
    const bound = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const runtime = await this.runtimeOf();
      const auth = await runtime.getAuth(CODEX_PROVIDER, { minOAuthValidityMs: FORCE_REFRESH_VALIDITY_MS, signal: bound });
      return auth ? { ok: true } : { ok: false, reason: "not-signed-in" };
    } catch (_err) {
      if (signal?.aborted) return { ok: false, reason: "cancelled" };
      return { ok: false, reason: timeout.aborted ? "timeout" : "rejected" };
    }
  }

  loginState(): LoginView | null {
    return this.current ? { ...this.current.view } : null;
  }

  startLogin(): LoginView {
    if (this.current && (this.current.view.state === "starting" || this.current.view.state === "awaiting-browser" || this.current.view.state === "awaiting-input")) return { ...this.current.view };
    const abort = new AbortController();
    const login: Login = { view: { id: randomUUID(), state: "starting" }, abort, pending: null, done: Promise.resolve() };
    this.current = login;
    const timer = setTimeout(() => { abort.abort(new Error("timeout")); }, LOGIN_TIMEOUT_MS);
    login.done = this.runLogin(login).finally(() => { clearTimeout(timer); });
    return { ...login.view };
  }

  whenSettled(): Promise<void> {
    return this.current?.done ?? Promise.resolve();
  }

  private async runLogin(login: Login): Promise<void> {
    const { view } = login;
    const interaction: AuthInteraction = {
      signal: login.abort.signal,
      notify: (event: AuthEvent) => {
        if (event.type === "auth_url") { view.state = "awaiting-browser"; view.url = event.url; if (event.instructions) view.instructions = event.instructions; }
        else if (event.type === "device_code") { view.state = "awaiting-browser"; view.userCode = event.userCode; view.verificationUri = event.verificationUri; }
        else view.message = event.message;
      },
      prompt: (prompt: AuthPrompt) => new Promise<string>((resolve, reject) => {
        const options = prompt.type === "select" ? prompt.options.map(({ id, label }) => ({ id, label })) : undefined;
        login.pending = { message: prompt.message, ...(options ? { options } : {}), resolve, reject };
        view.state = "awaiting-input";
        view.prompt = { message: prompt.message, ...(options ? { options } : {}) };
        login.abort.signal.addEventListener("abort", () => { reject(new Error("cancelled")); }, { once: true });
      }),
    };
    try {
      const runtime = await this.runtimeOf();
      await runtime.login(CODEX_PROVIDER, "oauth", interaction);
      view.state = "signed-in";
    } catch (_err) {
      const timedOut = login.abort.signal.aborted && (login.abort.signal.reason as Error | undefined)?.message === "timeout";
      view.state = login.abort.signal.aborted && !timedOut ? "cancelled" : "failed";
      view.error = timedOut ? "The sign-in timed out. Start it again." : view.state === "cancelled" ? "The sign-in was cancelled. Your message is still in the conversation." : "The sign-in did not complete. Start it again.";
    } finally {
      login.pending = null;
      delete view.prompt;
    }
  }

  answer(id: string, text: string): LoginView | null {
    const login = this.current;
    if (login?.view.id !== id || !login.pending) return null;
    const pending = login.pending;
    login.pending = null;
    delete login.view.prompt;
    login.view.state = "starting";
    pending.resolve(text);
    return { ...login.view };
  }

  cancel(id: string): LoginView | null {
    const login = this.current;
    if (login?.view.id !== id) return null;
    if (login.view.state === "starting" || login.view.state === "awaiting-browser" || login.view.state === "awaiting-input") login.abort.abort(new Error("cancelled"));
    return { ...login.view };
  }
}
