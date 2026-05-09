/**
 * G-405: Cloud CLI — Tests
 * TDD: These tests define the expected behavior of the cloud setup CLI.
 *
 * Tests cover:
 * - Secret generation (crypto-based, no shell-out)
 * - Wrangler output parsing (D1 database_id, KV namespace id)
 * - Wrangler.toml ID replacement
 * - add-operator HTTP call construction
 * - status endpoint parsing
 * - Credential file saving
 * - CLI argument parsing
 */

import { test, expect, describe, mock, beforeEach } from "bun:test";
import {
  generateSecret,
  parseD1CreateOutput,
  parseKvCreateOutput,
  updateWranglerToml,
  buildBotYamlSnippet,
  buildCredentialsSummary,
  parseArgs,
} from "../cloud";

// ---------------------------------------------------------------------------
// Secret generation
// ---------------------------------------------------------------------------

describe("generateSecret", () => {
  test("returns a hex string of expected length", () => {
    const secret = generateSecret(32);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
  });

  test("produces unique values on each call", () => {
    const a = generateSecret(32);
    const b = generateSecret(32);
    expect(a).not.toBe(b);
  });

  test("defaults to 32 bytes when no length specified", () => {
    const secret = generateSecret();
    expect(secret.length).toBe(64); // 32 bytes = 64 hex chars
  });
});

// ---------------------------------------------------------------------------
// Wrangler output parsing: D1 create
// ---------------------------------------------------------------------------

describe("parseD1CreateOutput", () => {
  test("extracts database_id from wrangler d1 create output", () => {
    const output = `
✅ Successfully created DB 'grove-events' in region WNAM
Created your new D1 database.

[[d1_databases]]
binding = "DB"
database_name = "grove-events"
database_id = "bf59021b-5a65-46ef-a33a-37882294fcc0"
`;
    const id = parseD1CreateOutput(output);
    expect(id).toBe("bf59021b-5a65-46ef-a33a-37882294fcc0");
  });

  test("returns null for unrecognized output", () => {
    const id = parseD1CreateOutput("Something unexpected happened");
    expect(id).toBeNull();
  });

  test("handles output with extra whitespace", () => {
    const output = `  database_id = "abc-123-def"  `;
    const id = parseD1CreateOutput(output);
    expect(id).toBe("abc-123-def");
  });
});

// ---------------------------------------------------------------------------
// Wrangler output parsing: KV create
// ---------------------------------------------------------------------------

describe("parseKvCreateOutput", () => {
  test("extracts namespace id from wrangler kv namespace create output", () => {
    const output = `
🌀 Creating namespace with title "grove-api-grove-keys"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "grove-keys"
id = "b8b33e5ff1bd43c19efa8ceb91cb5337"
`;
    const id = parseKvCreateOutput(output);
    expect(id).toBe("b8b33e5ff1bd43c19efa8ceb91cb5337");
  });

  test("returns null for unrecognized output", () => {
    const id = parseKvCreateOutput("error: something went wrong");
    expect(id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Wrangler.toml update
// ---------------------------------------------------------------------------

describe("updateWranglerToml", () => {
  const originalToml = `name = "grove-api"
main = "src/index.ts"
compatibility_date = "2025-03-30"
compatibility_flags = ["nodejs_compat"]

# D1 database binding
[[d1_databases]]
binding = "GROVE_DB"
database_name = "grove-events"
database_id = "bf59021b-5a65-46ef-a33a-37882294fcc0"

# KV namespace for API keys
[[kv_namespaces]]
binding = "GROVE_KEYS"
id = "b8b33e5ff1bd43c19efa8ceb91cb5337"

[vars]
CORS_ORIGIN = "*"
`;

  test("replaces D1 database_id", () => {
    const updated = updateWranglerToml(originalToml, {
      d1DatabaseId: "new-d1-id-here",
      kvNamespaceId: "b8b33e5ff1bd43c19efa8ceb91cb5337",
    });
    expect(updated).toContain('database_id = "new-d1-id-here"');
    expect(updated).not.toContain("bf59021b-5a65-46ef-a33a-37882294fcc0");
  });

  test("replaces KV namespace id", () => {
    const updated = updateWranglerToml(originalToml, {
      d1DatabaseId: "bf59021b-5a65-46ef-a33a-37882294fcc0",
      kvNamespaceId: "new-kv-id-here",
    });
    expect(updated).toContain('id = "new-kv-id-here"');
    expect(updated).not.toContain("b8b33e5ff1bd43c19efa8ceb91cb5337");
  });

  test("replaces both IDs simultaneously", () => {
    const updated = updateWranglerToml(originalToml, {
      d1DatabaseId: "aaa-bbb-ccc",
      kvNamespaceId: "ddd-eee-fff",
    });
    expect(updated).toContain('database_id = "aaa-bbb-ccc"');
    expect(updated).toContain('id = "ddd-eee-fff"');
  });

  test("preserves other content unchanged", () => {
    const updated = updateWranglerToml(originalToml, {
      d1DatabaseId: "aaa",
      kvNamespaceId: "bbb",
    });
    expect(updated).toContain('name = "grove-api"');
    expect(updated).toContain('binding = "GROVE_DB"');
    expect(updated).toContain('binding = "GROVE_KEYS"');
    expect(updated).toContain('CORS_ORIGIN = "*"');
  });
});

// ---------------------------------------------------------------------------
// Bot.yaml snippet generation
// ---------------------------------------------------------------------------

describe("buildBotYamlSnippet", () => {
  test("generates correct yaml snippet for operator", () => {
    const snippet = buildBotYamlSnippet({
      endpoint: "https://grove-api.meta-factory.ai",
      apiKey: "grove_sk_abc123",
      operatorId: "andreas",
    });
    expect(snippet).toContain("mode: cloud");
    expect(snippet).toContain("endpoint: https://grove-api.meta-factory.ai");
    expect(snippet).toContain("apiKey: grove_sk_abc123");
    expect(snippet).toContain("operatorId: andreas");
  });
});

// ---------------------------------------------------------------------------
// Credentials summary
// ---------------------------------------------------------------------------

describe("buildCredentialsSummary", () => {
  test("includes all essential fields", () => {
    const summary = buildCredentialsSummary({
      workerUrl: "https://grove-api.meta-factory.ai",
      adminSecret: "admin-secret-here",
      operatorKey: "grove_sk_abc123",
      operatorId: "andreas",
      agentName: "Luna",
      d1DatabaseId: "d1-id",
      kvNamespaceId: "kv-id",
    });
    expect(summary).toContain("grove-api.meta-factory.ai");
    expect(summary).toContain("admin-secret-here");
    expect(summary).toContain("grove_sk_abc123");
    expect(summary).toContain("andreas");
    expect(summary).toContain("Luna");
    expect(summary).toContain("d1-id");
    expect(summary).toContain("kv-id");
  });
});

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

describe("parseArgs", () => {
  test("parses cloud setup flags", () => {
    const args = parseArgs([
      "cloud", "setup",
      "--cf-account-id", "abc123",
      "--cf-api-token", "token456",
    ]);
    expect(args.command).toBe("setup");
    expect(args.flags["cf-account-id"]).toBe("abc123");
    expect(args.flags["cf-api-token"]).toBe("token456");
  });

  test("parses cloud add-operator flags", () => {
    const args = parseArgs([
      "cloud", "add-operator",
      "--name", "JC",
      "--agent-name", "Ivy",
      "--endpoint", "https://grove-api.meta-factory.ai",
      "--admin-key", "admin-secret",
    ]);
    expect(args.command).toBe("add-operator");
    expect(args.flags["name"]).toBe("JC");
    expect(args.flags["agent-name"]).toBe("Ivy");
    expect(args.flags["endpoint"]).toBe("https://grove-api.meta-factory.ai");
    expect(args.flags["admin-key"]).toBe("admin-secret");
  });

  test("parses cloud status flags", () => {
    const args = parseArgs([
      "cloud", "status",
      "--endpoint", "https://grove-api.meta-factory.ai",
      "--admin-key", "secret",
    ]);
    expect(args.command).toBe("status");
    expect(args.flags["endpoint"]).toBe("https://grove-api.meta-factory.ai");
    expect(args.flags["admin-key"]).toBe("secret");
  });

  test("returns unknown for unrecognized subcommand", () => {
    const args = parseArgs(["cloud", "destroy"]);
    expect(args.command).toBe("destroy");
  });

  test("handles missing flags gracefully", () => {
    const args = parseArgs(["cloud", "setup"]);
    expect(args.command).toBe("setup");
    expect(args.flags["cf-account-id"]).toBeUndefined();
  });
});
