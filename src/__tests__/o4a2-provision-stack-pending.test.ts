/**
 * O-4a.2 — provision-stack register handles PENDING gracefully.
 *
 * After a successful registration (2xx), the issuance request is PENDING.
 * The CLI must not exit with an error; it must surface a clear message
 * telling the principal that the credential is awaiting admin grant.
 *
 * Test strategy:
 *   1. Generate a temp NKey seed via `dispatchProvisionStack generate`.
 *   2. Call `dispatchProvisionStack register` with a mock fetch that returns
 *      HTTP 201 with a minimal signed-assertion body.
 *   3. Assert exit code 0 and stdout contains the PENDING message.
 */

import { describe, test, expect } from "bun:test";
import { unlinkSync, existsSync } from "fs";
import { dispatchProvisionStack } from "../cli/cortex/commands/provision-stack";

const MOCK_PRINCIPAL_RECORD = {
  payload: {
    principal_id: "testprincipal",
    stacks: [],
    capabilities: [],
    updated_at: new Date().toISOString(),
  },
  issued_at: new Date().toISOString(),
  registry: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
  signature: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==",
};

describe("provision-stack register — PENDING note (O-4a.2)", () => {
  test("successful register outputs 'awaiting admin grant' message and exits 0", async () => {
    const tmpSeedPath = `/tmp/o4a2-pending-test-seed-${Date.now().toString()}.nk`;
    let capturedUrl = "";

    try {
      // Step 1: generate a fresh seed.
      const genResult = await dispatchProvisionStack([
        "generate",
        "testprincipal",
        "--seed-path",
        tmpSeedPath,
      ]);
      expect(genResult.exitCode).toBe(0);
      expect(existsSync(tmpSeedPath)).toBe(true);

      // Step 2: register with a mock fetch returning 201.
      // Cast to globalThis.fetch type: the Bun type requires `preconnect` on the
      // function object, which a plain async arrow doesn't have. The cast is safe
      // here — the mock only exercises the fetch(url, init) call path.
      const mockFetch = (async (input: URL | RequestInfo, _init?: RequestInit | BunFetchRequestInit) => {
        capturedUrl = typeof input === "string" ? input : (input as Request).url;
        return new Response(JSON.stringify(MOCK_PRINCIPAL_RECORD), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }) as unknown as typeof globalThis.fetch;

      const origFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const regResult = await dispatchProvisionStack([
          "register",
          "testprincipal",
          "--seed-path",
          tmpSeedPath,
          "--registry-url",
          "https://registry.test",
        ]);

        // Step 3: assert PENDING note + clean exit.
        expect(regResult.exitCode).toBe(0);
        expect(regResult.stdout).toContain("awaiting admin grant");
        expect(regResult.stderr).toBe("");
        expect(capturedUrl).toContain("testprincipal");
      } finally {
        globalThis.fetch = origFetch;
      }
    } finally {
      if (existsSync(tmpSeedPath)) {
        unlinkSync(tmpSeedPath);
      }
    }
  });

  test("failed register (4xx) still exits with error code 1", async () => {
    const tmpSeedPath = `/tmp/o4a2-pending-test-seed-fail-${Date.now().toString()}.nk`;
    try {
      const genResult = await dispatchProvisionStack([
        "generate",
        "testprincipal",
        "--seed-path",
        tmpSeedPath,
      ]);
      expect(genResult.exitCode).toBe(0);

      const mockFetch = (async (_input: URL | RequestInfo, _init?: RequestInit | BunFetchRequestInit) => {
        return new Response(
          JSON.stringify({ error: "admin_not_configured" }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      }) as unknown as typeof globalThis.fetch;

      const origFetch = globalThis.fetch;
      globalThis.fetch = mockFetch;
      try {
        const regResult = await dispatchProvisionStack([
          "register",
          "testprincipal",
          "--seed-path",
          tmpSeedPath,
          "--registry-url",
          "https://registry.test",
        ]);
        // A 503 (ok:false) is a real failure — must exit 1.
        expect(regResult.exitCode).toBe(1);
        expect(regResult.stderr).toContain("503");
      } finally {
        globalThis.fetch = origFetch;
      }
    } finally {
      if (existsSync(tmpSeedPath)) {
        unlinkSync(tmpSeedPath);
      }
    }
  });
});
