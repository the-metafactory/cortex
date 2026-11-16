import { afterEach, describe, expect, test } from "bun:test";
import { openConversationHost, type HostStatus } from "../../../../conversations/host";
import { CodexAuth, type CodexRuntime } from "../../../../conversations/codex-auth";
import { answering, scratchDirs } from "../../../../conversations/__tests__/fixtures/scratch";
import { handleConversations } from "../conversations";
import { buildAllowedHostnames, type MutationGuardContext } from "../mutation-guard";

const LABEL = "ai.meta-factory.cortex.fixture";
const OTHER = { "cf-access-authenticated-user-email": "someone-else@example.invalid" };
const dirs = scratchDirs("conversations-codex-auth-");
const statuses: HostStatus[] = [];
afterEach(async () => {
  for (const status of statuses.splice(0)) if (status.state === "ready") await status.host.close().catch(() => undefined);
  await dirs.clean();
});

const guard: MutationGuardContext = { isLoopback: true, allowedHostnames: buildAllowedHostnames("127.0.0.1"), listenPort: 8767, principals: new Set() };
const runtime = (refreshed: boolean): CodexRuntime => ({
  getAuth: () => refreshed ? Promise.resolve({ auth: {}, source: "stored" } as never) : Promise.reject(new Error("invalid_grant")),
  login: async (_provider, _type, interaction) => { interaction.notify({ type: "auth_url", url: "https://auth.example.invalid/x" }); await interaction.prompt({ type: "manual_code", message: "Paste the code" }); return {} as never; },
});

async function rig(refreshed = true) {
  const status = await openConversationHost({ dir: await dirs.make(), stack: "api", label: LABEL, expectedLabel: LABEL, lanes: { cloud: { provider: "test", model: "m" } }, turns: answering(() => "ok") });
  statuses.push(status);
  const auth = new CodexAuth(() => Promise.resolve(runtime(refreshed)));
  const access = Object.assign(() => status, { codexAuth: () => auth });
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    handleConversations(new Request(`http://127.0.0.1:8767${path}`, { method, headers: { host: "127.0.0.1:8767", "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), new URL(`http://127.0.0.1:8767${path}`), guard, access);
  return { call, auth };
}

describe("Codex recovery endpoints", () => {
  test("another identity or a rebound host cannot refresh, sign in, answer or cancel", async () => {
    const { call, auth } = await rig();
    for (const [method, path, body] of [["POST", "/refresh", {}], ["POST", "/login", {}], ["POST", "/login/input", { id: "x", answer: "y" }], ["POST", "/login/cancel", { id: "x" }], ["GET", "/login", undefined]] as const) {
      expect((await call(method, `/api/conversations/codex-auth${path}`, body, OTHER)).status).toBe(403);
      expect((await call(method, `/api/conversations/codex-auth${path}`, body, { host: "rebound.example:8767" })).status).toBe(403);
    }
    expect(auth.loginState()).toBeNull();
  });

  test("the principal refreshes, and a rejected refresh is reported without provider text", async () => {
    const ok = await rig(true);
    expect(await (await ok.call("POST", "/api/conversations/codex-auth/refresh", {})).json()).toEqual({ ok: true, refreshed: true });
    const bad = await rig(false);
    const body = await (await bad.call("POST", "/api/conversations/codex-auth/refresh", {})).json();
    expect(body).toEqual({ ok: true, refreshed: false, reason: "rejected" });
  });

  test("the principal starts, answers and cancels a sign-in; the answer never comes back", async () => {
    const { call, auth } = await rig();
    const started = await (await call("POST", "/api/conversations/codex-auth/login", {})).json() as { login: { id: string } };
    await Bun.sleep(20);
    const polled = await (await call("GET", "/api/conversations/codex-auth/login")).json() as { login: { state: string; url: string } };
    expect(polled.login).toMatchObject({ state: "awaiting-input", url: "https://auth.example.invalid/x" });
    expect((await call("POST", "/api/conversations/codex-auth/login/input", { id: "wrong", answer: "z" })).status).toBe(409);
    const answered = await call("POST", "/api/conversations/codex-auth/login/input", { id: started.login.id, answer: "secret-code" });
    expect(answered.status).toBe(200);
    expect(JSON.stringify(await answered.json())).not.toContain("secret-code");
    await auth.whenSettled();
    expect((await call("POST", "/api/conversations/codex-auth/login/cancel", { id: "none" })).status).toBe(404);
  });

  test("a stack without Codex sign-in says so", async () => {
    const status = await openConversationHost({ dir: await dirs.make(), stack: "api", label: LABEL, expectedLabel: LABEL, lanes: { cloud: { provider: "test", model: "m" } }, turns: answering(() => "ok") });
    statuses.push(status);
    const response = await handleConversations(new Request("http://127.0.0.1:8767/api/conversations/codex-auth", { headers: { host: "127.0.0.1:8767" } }), new URL("http://127.0.0.1:8767/api/conversations/codex-auth"), guard, () => status);
    expect(response.status).toBe(503);
  });
});
