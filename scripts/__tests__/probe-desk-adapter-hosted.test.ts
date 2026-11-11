import { afterAll, expect, test } from "bun:test";
import { CF_ACCESS_JWT_HEADER } from "../../src/surface/mc/api/networks-admission";
import { preflight } from "../probe-desk-adapter-hosted";
import { redactor } from "../desk-adapter-hosted/preflight";
import { runHostedChecks } from "../desk-adapter-hosted/checks";
import { openSyntheticStack } from "../desk-adapter-hosted/stack";

const HOST = "probe.example.test";
const config = (extra = "") => `hostname: ${HOST}\nlocal_port: 18767\naccess_client_id: id-1\naccess_client_secret: secret-1\ntunnel_token: tunnel-1\n${extra}`;
const now = new Date("2026-11-11T12:00:00Z");

test("a complete configuration passes the preflight", () => {
  expect(preflight({ rawConfig: config(), target: undefined, now }).ok).toBe(true);
});

test("a missing configuration or service token is not run, with the reason", () => {
  expect(preflight({ rawConfig: undefined, target: undefined, now })).toEqual({ ok: false, reason: expect.stringContaining("not found") });
  const tokenless = "hostname: probe.example.test\nlocal_port: 18767\ntunnel_token: t\n";
  expect(preflight({ rawConfig: tokenless, target: undefined, now })).toEqual({ ok: false, reason: expect.stringContaining("no Cloudflare Access service token") });
});

test("an expired token is refused", () => {
  expect(preflight({ rawConfig: config("access_token_expires_at: 2026-11-01\n"), target: undefined, now })).toEqual({ ok: false, reason: expect.stringContaining("expired") });
});

test("a target other than the configured stack is refused and the reason names no host", () => {
  const result = preflight({ rawConfig: config(), target: "real-stack.example.org", now });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).not.toContain("real-stack");
  expect(preflight({ rawConfig: config(), target: HOST.toUpperCase(), now }).ok).toBe(true);
});

test("the redactor removes the hostname and every credential", () => {
  const checked = preflight({ rawConfig: config(), target: undefined, now });
  if (!checked.ok) throw new Error(checked.reason);
  expect(redactor(checked.config)("get https://probe.example.test with secret-1 id-1 tunnel-1")).toBe("get https://[redacted] with [redacted] [redacted] [redacted]");
});

const stack = await openSyntheticStack(HOST);
afterAll(() => stack.close());

test("the checks pass behind a front that enforces the token, and the refusal check fails when the front lets a tokenless request through", async () => {
  const route = (assertion: boolean) => (method: string, path: string, body?: unknown) => Promise.resolve(stack.handle(new Request(`https://${HOST}${path}`, {
    method, headers: { host: HOST, "content-type": "application/json", ...(assertion ? { [CF_ACCESS_JWT_HEADER]: "service-assertion" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })));
  const results: [boolean, string][] = [];
  const probe = { check: (ok: boolean, label: string) => { results.push([ok, label]); }, finish: (): never => { throw new Error("unused"); } };
  const refusingFront = () => Promise.resolve(new Response("forbidden", { status: 403 }));
  await runHostedChecks(stack, route(true), refusingFront, probe);
  expect(results.filter(([ok]) => !ok)).toEqual([]);
  expect(results.length).toBe(8);

  results.length = 0;
  const leaky = await openSyntheticStack(HOST);
  try {
    await runHostedChecks(leaky, (method, path, body) => Promise.resolve(leaky.handle(new Request(`https://${HOST}${path}`, { method, headers: { host: HOST, "content-type": "application/json", [CF_ACCESS_JWT_HEADER]: "service-assertion" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }))), (method, path) => Promise.resolve(leaky.handle(new Request(`https://${HOST}${path}`, { method, headers: { host: HOST } }))), probe);
  } finally { await leaky.close(); }
  expect(results.find(([, label]) => label.startsWith("Access refuses"))?.[0]).toBe(false);
});
