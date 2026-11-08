import { describe, expect, test } from "bun:test";
import { join } from "node:path";

async function run(scenario: string) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "configured-runtime-fixture.ts"), scenario], { stdout: "pipe", stderr: "pipe" });
  const [output, errors] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect(await child.exited, errors).toBe(0);
  return JSON.parse(output);
}
describe("configured native bus bootstrap", () => {
  test("pins identity, signs, uses explicit domain and subscribes to nothing by default", async () => {
    expect(await run("valid")).toMatchObject({ name: "synthetic-sdk", dialOptions: { servers: ["nats://localhost:4222"], ignoreClusterUpdates: true, waitOnFirstConnect: false, maxReconnectAttempts: -1, timeout: 5000 }, ok: true, calls: 1, subjects: [], signed: true, did: "did:mf:synthetic-work", mode: "drop", domain: "synthetic-domain" });
  });
  for (const [scenario, error] of Object.entries({ "wrong-stack": "configured bus identity differs from expected stack", "wrong-key": "configured bus identity differs from expected stack", "timeout-low": "configured bus connection timeout invalid", "timeout-high": "configured bus connection timeout invalid", "timeout-fraction": "configured bus connection timeout invalid", "public-seed": "configured bus signer unavailable; unsigned fallback refused", "invalid-seed": "configured bus signer unavailable; unsigned fallback refused", query: "configured bus requires authenticated localhost transport with private credentials", fragment: "configured bus requires authenticated localhost transport with private credentials", userinfo: "configured bus requires authenticated localhost transport with private credentials", backslash: "configured bus requires authenticated localhost transport with private credentials", path: "configured bus requires authenticated localhost transport with private credentials", tls: "configured bus requires authenticated localhost transport with private credentials", mtls: "configured bus mTLS posture unsupported; refusing to weaken policy", "missing-pin": "configured bus identity differs from expected stack", "undefined-pin": "configured bus requires explicit expected identity pins", "seed-mismatch": "configured bus signer unavailable; unsigned fallback refused", "missing-file": "configured bus requires authenticated localhost transport with private credentials", "public-creds": "configured bus requires authenticated localhost transport with private credentials", lookalike: "configured bus requires authenticated localhost transport with private credentials", remote: "configured bus requires authenticated localhost transport with private credentials", "missing-credentials": "configured bus requires authenticated localhost transport with private credentials", off: "configured bus signer unavailable; unsigned fallback refused", "missing-signer": "configured bus signer unavailable; unsigned fallback refused" })) {
    test(`rejects ${scenario} before opening transport`, async () => {
      expect(await run(scenario)).toMatchObject({ ok: false, calls: 0, error });
    });
  }
  for (const scenario of ["schemeless", "http"]) {
    test(`native config rejects ${scenario} before transport`, async () => { expect(await run(scenario)).toMatchObject({ ok: false, calls: 0 }); });
  }
  for (const scenario of ["ipv4", "ipv6", "permissive", "default-signing", "no-domain"]) {
    test(`accepts ${scenario} with strict signing and zero subscriptions`, async () => {
      expect(await run(scenario)).toMatchObject({ ok: true, calls: 1, subjects: [], signed: true, mode: "drop" });
    });
  }
  test("stop rejection preserves bootstrap error", async () => {
    expect(await run("stop-rejects")).toMatchObject({ ok: false, calls: 1, stopped: true, error: "configured bus runtime unavailable" });
  });
  test("stops a disabled runtime and refuses unsigned continuation", async () => {
    expect(await run("disabled")).toMatchObject({ ok: false, calls: 1, stopped: true, error: "configured bus runtime unavailable" });
  });
});
