// cortex#2396 (vision#11) — `cortex github-token` CLI tests. The GitHub API
// call is injected via `__setFetchForTests` so tests stay hermetic (no real
// network call, no real private key needed beyond a generated test fixture).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { generateKeyPairSync } from "node:crypto";
import { join } from "path";
import { tmpdir } from "os";

import {
  __setFetchForTests,
  dispatchGithubToken,
  parseGithubTokenArgs,
  runGithubTokenList,
  runGithubTokenMint,
} from "../github-token";
import { CliArgsError } from "../_shared/arg-error";

const { privateKey: TEST_PRIVATE_KEY_PEM } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

describe("parseGithubTokenArgs", () => {
  test("parses mint with identity + flags", () => {
    const parsed = parseGithubTokenArgs(["mint", "atlas", "--json"]);
    expect(parsed.subcommand).toBe("mint");
    expect(parsed.identity).toBe("atlas");
    expect(parsed.json).toBe(true);
  });

  test("parses list", () => {
    const parsed = parseGithubTokenArgs(["list"]);
    expect(parsed.subcommand).toBe("list");
  });

  test("no args → unknown with empty rawSubcommand", () => {
    const parsed = parseGithubTokenArgs([]);
    expect(parsed.subcommand).toBe("unknown");
    expect(parsed.rawSubcommand).toBe("");
  });

  test("mint without identity throws via missing-positional path (caught by dispatch)", () => {
    // parseSubcommandArgs throws MissingPositionalError; parseGithubTokenArgs
    // catches it and degrades to a usable args object (mirrors creds.ts).
    const parsed = parseGithubTokenArgs(["mint"]);
    expect(parsed.subcommand).toBe("mint");
    expect(parsed.identity).toBeUndefined();
  });

  test("unknown flag throws CliArgsError", () => {
    expect(() => parseGithubTokenArgs(["mint", "atlas", "--bogus"])).toThrow(CliArgsError);
  });
});

describe("runGithubTokenMint + runGithubTokenList (hermetic fixture)", () => {
  let dir: string;
  let configPath: string;
  let keyPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "github-token-cli-"));
    keyPath = join(dir, "atlas.pem");
    writeFileSync(keyPath, TEST_PRIVATE_KEY_PEM, "utf8");
    chmodSync(keyPath, 0o600);

    configPath = join(dir, "apps.yaml");
    writeFileSync(
      configPath,
      `atlas:\n  appId: "4391087"\n  installationId: "148931136"\n  keyPath: "${keyPath}"\n`,
      "utf8",
    );
  });

  afterEach(() => {
    __setFetchForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  test("mint prints the bare token on stdout, expiry on stderr, exit 0", async () => {
    __setFetchForTests(
      (async () =>
        new Response(
          JSON.stringify({ token: "ghs_cli_test", expires_at: "2026-07-26T01:00:00Z" }),
          { status: 201 },
        )) as unknown as typeof fetch,
    );

    const result = await runGithubTokenMint({
      subcommand: "mint",
      rawSubcommand: "mint",
      identity: "atlas",
      config: configPath,
      json: false,
      help: false,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ghs_cli_test\n");
    expect(result.stderr).toMatch(/atlas.*expires 2026-07-26T01:00:00Z/);
  });

  test("mint --json wraps token + expiresAt in the envelope", async () => {
    __setFetchForTests(
      (async () =>
        new Response(
          JSON.stringify({ token: "ghs_json_test", expires_at: "2026-07-26T02:00:00Z" }),
          { status: 201 },
        )) as unknown as typeof fetch,
    );

    const result = await runGithubTokenMint({
      subcommand: "mint",
      rawSubcommand: "mint",
      identity: "atlas",
      config: configPath,
      json: true,
      help: false,
    });

    expect(result.exitCode).toBe(0);
    const envelope = JSON.parse(result.stdout);
    expect(envelope.status).toBe("ok");
    expect(envelope.items).toEqual([
      { identity: "atlas", token: "ghs_json_test", expiresAt: "2026-07-26T02:00:00Z" },
    ]);
  });

  test("mint with unknown identity exits 1 with a clear stderr message", async () => {
    const result = await runGithubTokenMint({
      subcommand: "mint",
      rawSubcommand: "mint",
      identity: "nonexistent",
      config: configPath,
      json: false,
      help: false,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/unknown GitHub App identity "nonexistent"/);
  });

  test("list surfaces configured identity names without secrets", () => {
    const result = runGithubTokenList({
      subcommand: "list",
      rawSubcommand: "list",
      identity: undefined,
      config: configPath,
      json: false,
      help: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("atlas\tapp=4391087\tinstallation=148931136\n");
    expect(result.stdout).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  test("dispatchGithubToken routes mint through end-to-end", async () => {
    __setFetchForTests(
      (async () =>
        new Response(
          JSON.stringify({ token: "ghs_dispatch_test", expires_at: "2026-07-26T03:00:00Z" }),
          { status: 201 },
        )) as unknown as typeof fetch,
    );

    const result = await dispatchGithubToken(["mint", "atlas", "--config", configPath]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ghs_dispatch_test\n");
  });

  test("dispatchGithubToken with no subcommand exits 2 with usage error", async () => {
    const result = await dispatchGithubToken([]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/usage error/);
  });

  test("dispatchGithubToken with unknown subcommand exits 2", async () => {
    const result = await dispatchGithubToken(["bogus"]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/unknown subcommand "bogus"/);
  });
});
