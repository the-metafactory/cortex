#!/usr/bin/env bun
/**
 * G-405: Automated Cloud Setup CLI
 *
 * Subcommands:
 *   cloud setup          — Full Cloudflare infrastructure provisioning
 *   cloud add-operator   — Create a new principal API key
 *   cloud status         — Check deployed Worker health and state
 *   cloud webhooks       — Check webhook delivery health for all tracked repos
 *
 * Usage:
 *   bun src/bot/commands/cloud.ts setup --cf-account-id X --cf-api-token Y
 *   bun src/bot/commands/cloud.ts add-operator --name "JC" --agent-name "Ivy" --endpoint URL --admin-key KEY
 *   bun src/bot/commands/cloud.ts status --endpoint URL [--admin-key KEY]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import YAML from "yaml";

// =============================================================================
// Pure functions (testable, no side effects)
// =============================================================================

/**
 * Generate a cryptographically random hex string.
 * @param bytes Number of random bytes (default 32 = 64 hex chars)
 */
export function generateSecret(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Parse `wrangler d1 create` output to extract database_id.
 * Expected line: `database_id = "UUID"`
 */
export function parseD1CreateOutput(output: string): string | null {
  const match = /database_id\s*=\s*"([^"]+)"/.exec(output);
  return match?.[1] ?? null;
}

/**
 * Parse `wrangler kv namespace create` output to extract namespace id.
 * Expected line: `id = "HEX"`
 */
export function parseKvCreateOutput(output: string): string | null {
  const match = /^id\s*=\s*"([^"]+)"/m.exec(output);
  return match?.[1] ?? null;
}

/**
 * Replace D1 database_id and KV namespace id in a wrangler.toml string.
 */
export function updateWranglerToml(
  content: string,
  ids: { d1DatabaseId: string; kvNamespaceId: string },
): string {
  let updated = content.replace(
    /database_id\s*=\s*"[^"]*"/,
    `database_id = "${ids.d1DatabaseId}"`,
  );
  // Match `id = "..."` only within the kv_namespaces section.
  // The KV `id` line follows the `binding = "GROVE_KEYS"` line.
  updated = updated.replace(
    /(binding\s*=\s*"GROVE_KEYS"\s*\n\s*)id\s*=\s*"[^"]*"/,
    `$1id = "${ids.kvNamespaceId}"`,
  );
  return updated;
}

/**
 * Build a bot.yaml snippet for a cloud-mode principal.
 *
 * The `operatorId:` YAML key matches `NetworkCloudSchema.operatorId`
 * in src/common/types/config.ts (rename owned by R2.I — the config
 * schema field). PR-R2d renames the CLI flag + JSON wire field; the
 * config-schema rename is the next breaking cut.
 */
export function buildBotYamlSnippet(opts: {
  endpoint: string;
  apiKey: string;
  principalId: string;
}): string {
  return `api:
  mode: cloud
  endpoint: ${opts.endpoint}
  apiKey: ${opts.apiKey}
  operatorId: ${opts.principalId}`;
}

/**
 * Build a credential summary for the admin to save.
 */
export function buildCredentialsSummary(opts: {
  workerUrl: string;
  adminSecret: string;
  principalKey: string;
  principalId: string;
  agentName: string;
  d1DatabaseId: string;
  kvNamespaceId: string;
}): string {
  return `# Cortex Cloud Credentials
# Generated: ${new Date().toISOString()}
# KEEP THIS FILE SAFE — contains admin secrets

Worker URL:       ${opts.workerUrl}
Admin Secret:     ${opts.adminSecret}
D1 Database ID:   ${opts.d1DatabaseId}
KV Namespace ID:  ${opts.kvNamespaceId}

## First Principal
Principal ID:     ${opts.principalId}
Agent Name:       ${opts.agentName}
API Key:          ${opts.principalKey}

## bot.yaml snippet
${buildBotYamlSnippet({
  endpoint: opts.workerUrl,
  apiKey: opts.principalKey,
  principalId: opts.principalId,
})}
`;
}

/**
 * Parse CLI arguments for the cloud subcommand.
 * Accepts: cloud <subcommand> [--flag value ...]
 */
export function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string>;
} {
  // Find "cloud" and take the next arg as the subcommand
  // If "cloud" is not in argv (direct script invocation), treat first arg as command
  const cloudIdx = argv.indexOf("cloud");
  const commandIdx = cloudIdx >= 0 ? cloudIdx + 1 : 0;
  const command = argv.length > commandIdx ? (argv[commandIdx] ?? "help") : "help";

  const flags: Record<string, string> = {};
  const startIdx = commandIdx + 1;

  for (let i = startIdx; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const next = argv[i + 1];
    if (arg.startsWith("--") && next !== undefined && !next.startsWith("--")) {
      const key = arg.slice(2);
      flags[key] = next;
      i++;
    }
  }

  return { command, flags };
}

// =============================================================================
// Wrangler runner — spawns wrangler commands via Bun.spawn
// =============================================================================

interface RunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runWrangler(
  args: string[],
  env: Record<string, string>,
  cwd: string,
): Promise<RunResult> {
  const proc = Bun.spawn(["npx", "wrangler", ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { ok: exitCode === 0, stdout, stderr, exitCode };
}

/**
 * Run wrangler secret put — pipes the secret value into stdin.
 */
async function runWranglerSecretPut(
  secretName: string,
  secretValue: string,
  env: Record<string, string>,
  cwd: string,
): Promise<RunResult> {
  const proc = Bun.spawn(
    ["npx", "wrangler", "secret", "put", secretName],
    {
      cwd,
      env: { ...process.env, ...env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  // Write the secret value to stdin and close. Both write/end return
  // Promise<void>; the stdin is fully consumed before we await stdout
  // below, so it's safe to fire-and-forget here.
  void proc.stdin.write(secretValue);
  void proc.stdin.end();

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  return { ok: exitCode === 0, stdout, stderr, exitCode };
}

// =============================================================================
// Step printer
// =============================================================================

function step(n: number, total: number, msg: string): void {
  console.log(`\n[${n}/${total}] ${msg}`);
}

function success(msg: string): void {
  console.log(`  OK: ${msg}`);
}

function fail(msg: string): void {
  console.error(`  FAIL: ${msg}`);
}

function warn(msg: string): void {
  console.log(`  WARN: ${msg}`);
}

// =============================================================================
// cloud setup
// =============================================================================

async function cloudSetup(flags: Record<string, string>): Promise<void> {
  const cfAccountId = flags["cf-account-id"];
  const cfApiToken = flags["cf-api-token"];

  if (!cfAccountId || !cfApiToken) {
    throw new Error(
      "Usage: grove-bot cloud setup --cf-account-id <ID> --cf-api-token <TOKEN>\n\n" +
      "Required Cloudflare API token permissions:\n" +
      "  - Workers Scripts: Edit\n" +
      "  - D1: Edit\n" +
      "  - Workers KV Storage: Edit",
    );
  }

  // Resolve paths relative to this script's location (src/bot/commands/)
  // import.meta.dir = .../src/bot/commands
  // Go up twice to reach .../src, then into worker/
  const srcDir = dirname(dirname(import.meta.dir)); // .../src
  const workerDir = join(srcDir, "worker");
  const wranglerTomlPath = join(workerDir, "wrangler.toml");
  const schemaPath = join(workerDir, "schema.sql");

  const cfEnv: Record<string, string> = {
    CLOUDFLARE_API_TOKEN: cfApiToken,
    CLOUDFLARE_ACCOUNT_ID: cfAccountId,
  };

  const TOTAL_STEPS = 11;

  // --- Step 1: Check wrangler ---
  step(1, TOTAL_STEPS, "Checking wrangler availability...");
  const wranglerCheck = await runWrangler(["--version"], cfEnv, workerDir);
  if (!wranglerCheck.ok) {
    throw new Error("wrangler not found. Install: bun add -g wrangler");
  }
  success(`wrangler ${wranglerCheck.stdout.trim()}`);

  // --- Step 2: Create D1 database ---
  step(2, TOTAL_STEPS, "Creating D1 database: grove-events...");
  const d1Result = await runWrangler(["d1", "create", "grove-events"], cfEnv, workerDir);
  let d1Id: string | null;
  if (d1Result.ok) {
    d1Id = parseD1CreateOutput(d1Result.stdout);
    if (d1Id) {
      success(`database_id = ${d1Id}`);
    } else {
      throw new Error(`Could not parse database_id from wrangler output:\n${d1Result.stdout}`);
    }
  } else {
    // Check if it already exists
    if (d1Result.stderr.includes("already exists") || d1Result.stdout.includes("already exists")) {
      console.log("  Database may already exist. Checking wrangler.toml for existing ID...");
      const existingToml = readFileSync(wranglerTomlPath, "utf-8");
      d1Id = parseD1CreateOutput(existingToml);
      if (d1Id) {
        success(`Using existing database_id = ${d1Id}`);
      } else {
        throw new Error(`D1 creation failed and no existing ID found:\n${d1Result.stderr}`);
      }
    } else {
      throw new Error(`D1 creation failed:\n${d1Result.stderr}`);
    }
  }

  // --- Step 3: Create KV namespace ---
  step(3, TOTAL_STEPS, "Creating KV namespace: grove-keys...");
  const kvResult = await runWrangler(["kv", "namespace", "create", "grove-keys"], cfEnv, workerDir);
  let kvId: string | null;
  if (kvResult.ok) {
    kvId = parseKvCreateOutput(kvResult.stdout);
    if (kvId) {
      success(`kv namespace id = ${kvId}`);
    } else {
      throw new Error(`Could not parse KV namespace id from wrangler output:\n${kvResult.stdout}`);
    }
  } else {
    if (kvResult.stderr.includes("already exists") || kvResult.stdout.includes("already exists")) {
      console.log("  KV namespace may already exist. Checking wrangler.toml for existing ID...");
      const existingToml = readFileSync(wranglerTomlPath, "utf-8");
      const existingKvMatch = /\[kv_namespaces\][\s\S]*?id\s*=\s*"([^"]+)"/.exec(existingToml);
      kvId = existingKvMatch?.[1] ?? null;
      if (kvId) {
        success(`Using existing kv id = ${kvId}`);
      } else {
        throw new Error(`KV creation failed and no existing ID found:\n${kvResult.stderr}`);
      }
    } else {
      throw new Error(`KV creation failed:\n${kvResult.stderr}`);
    }
  }

  // --- Step 4: Update wrangler.toml ---
  step(4, TOTAL_STEPS, "Updating wrangler.toml with resource IDs...");
  const tomlContent = readFileSync(wranglerTomlPath, "utf-8");
  const updatedToml = updateWranglerToml(tomlContent, {
    d1DatabaseId: d1Id,
    kvNamespaceId: kvId,
  });
  writeFileSync(wranglerTomlPath, updatedToml);
  success("wrangler.toml updated");

  // --- Step 5: Run D1 schema migration ---
  step(5, TOTAL_STEPS, "Running D1 schema migration...");
  const migrationResult = await runWrangler(
    ["d1", "execute", "grove-events", `--file=${schemaPath}`, "--remote"],
    cfEnv,
    workerDir,
  );
  if (migrationResult.ok) {
    success("Schema migration complete");
  } else {
    throw new Error(
      `Schema migration failed:\n${migrationResult.stderr}\n` +
      "Retry: wrangler d1 execute grove-events --file=src/worker/schema.sql --remote",
    );
  }

  // --- Step 6: Generate and set ADMIN_SECRET ---
  step(6, TOTAL_STEPS, "Setting ADMIN_SECRET...");
  const adminSecret = generateSecret(32);
  const adminSecretResult = await runWranglerSecretPut("ADMIN_SECRET", adminSecret, cfEnv, workerDir);
  if (adminSecretResult.ok) {
    success("ADMIN_SECRET set");
  } else {
    throw new Error(`Failed to set ADMIN_SECRET:\n${adminSecretResult.stderr}`);
  }

  // --- Step 7: Generate and set GITHUB_WEBHOOK_SECRET ---
  step(7, TOTAL_STEPS, "Setting GITHUB_WEBHOOK_SECRET...");
  const webhookSecret = generateSecret(32);
  const webhookResult = await runWranglerSecretPut("GITHUB_WEBHOOK_SECRET", webhookSecret, cfEnv, workerDir);
  if (webhookResult.ok) {
    success("GITHUB_WEBHOOK_SECRET set");
  } else {
    throw new Error(`Failed to set GITHUB_WEBHOOK_SECRET:\n${webhookResult.stderr}`);
  }

  // --- Step 8: Set GITHUB_REPOS ---
  step(8, TOTAL_STEPS, "Setting GITHUB_REPOS...");
  const defaultRepos = "the-metafactory/grove";
  // Try to read repos from bot.yaml if available
  let repos = defaultRepos;
  try {
    const configPath = join(process.env.HOME ?? "~", ".config", "grove", "bot.yaml");
    if (existsSync(configPath)) {
      const configContent = readFileSync(configPath, "utf-8");
      // Simple yaml parsing — look for repos array under github:
      const reposMatch = /repos:\s*\n((?:\s+-\s+.+\n?)+)/.exec(configContent);
      if (reposMatch?.[1]) {
        const parsed = reposMatch[1]
          .split("\n")
          .map((l) => l.trim().replace(/^-\s+/, "").replace(/["']/g, ""))
          .filter(Boolean);
        if (parsed.length > 0) repos = parsed.join(",");
      }
    }
  } catch (err) {
    console.warn("cortex: cloud setup: failed to read bot.yaml for repos:", err instanceof Error ? err.message : err);
  }

  const reposResult = await runWranglerSecretPut("GITHUB_REPOS", repos, cfEnv, workerDir);
  if (reposResult.ok) {
    success(`GITHUB_REPOS = ${repos}`);
  } else {
    fail("Failed to set GITHUB_REPOS");
    console.error(reposResult.stderr);
    // Non-fatal — continue
  }

  // --- Step 8b: Set GITHUB_TOKEN (optional, needed for /api/sync) ---
  const ghToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (ghToken) {
    const ghTokenResult = await runWranglerSecretPut("GITHUB_TOKEN", ghToken, cfEnv, workerDir);
    if (ghTokenResult.ok) {
      success("GITHUB_TOKEN set from environment");
    } else {
      warn("Failed to set GITHUB_TOKEN — /api/sync won't work");
    }
  } else {
    warn("GITHUB_TOKEN not found in environment — /api/sync will be unavailable");
    console.log("    Set it later: echo TOKEN | npx wrangler secret put GITHUB_TOKEN");
  }

  // --- Step 9: Deploy the Worker ---
  step(9, TOTAL_STEPS, "Deploying Worker...");
  const deployResult = await runWrangler(["deploy"], cfEnv, workerDir);
  if (!deployResult.ok) {
    throw new Error(
      `Worker deployment failed:\n${deployResult.stderr}\n` +
      "Retry: cd src/worker && npx wrangler deploy",
    );
  }

  // Extract worker URL from deploy output
  const urlMatch = /https:\/\/[^\s]+\.workers\.dev/.exec(deployResult.stdout);
  const workerUrl = urlMatch
    ? urlMatch[0]
    : "https://grove-api.<your-subdomain>.workers.dev";
  success(`Deployed to ${workerUrl}`);

  // --- Step 10: Create first principal key ---
  step(10, TOTAL_STEPS, "Creating first principal key...");

  // Default principal info
  const principalId = flags["principal-id"] ?? "admin";
  const agentName = flags["agent-name"] ?? "Luna";

  // Wait a moment for the worker to be live
  await new Promise((r) => setTimeout(r, 2000));

  let principalKey = "";
  try {
    const keyRes = await fetch(`${workerUrl}/admin/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminSecret}`,
      },
      body: JSON.stringify({
        principal_id: principalId,
        name: agentName,
      }),
    });

    if (keyRes.ok) {
      const keyData = (await keyRes.json()) as { key: string };
      principalKey = keyData.key;
      success(`Principal key created: ${principalKey.slice(0, 20)}...`);
    } else {
      const errText = await keyRes.text();
      fail(`Key creation failed: HTTP ${keyRes.status} — ${errText}`);
      console.error("You can create a key manually:");
      console.error(
        `  curl -X POST ${workerUrl}/admin/keys -H "Authorization: Bearer ${adminSecret}" -H "Content-Type: application/json" -d '{"principal_id":"${principalId}","name":"${agentName}"}'`,
      );
    }
  } catch (err) {
    fail(`Could not reach worker: ${err instanceof Error ? err.message : String(err)}`);
    console.error("The worker may still be propagating. Try creating a key manually:");
    console.error(
      `  curl -X POST ${workerUrl}/admin/keys -H "Authorization: Bearer ${adminSecret}" -H "Content-Type: application/json" -d '{"principal_id":"${principalId}","name":"${agentName}"}'`,
    );
  }

  // --- Step 11: Print summary & save credentials ---
  step(11, TOTAL_STEPS, "Saving credentials and printing summary...");

  const credDir = join(process.env.HOME ?? "~", ".config", "grove");
  mkdirSync(credDir, { recursive: true });
  const credPath = join(credDir, "cloud-credentials.txt");

  const summary = buildCredentialsSummary({
    workerUrl,
    adminSecret,
    principalKey: principalKey || "(create manually — see above)",
    principalId,
    agentName,
    d1DatabaseId: d1Id,
    kvNamespaceId: kvId,
  });

  writeFileSync(credPath, summary, { mode: 0o600 });
  success(`Credentials saved to ${credPath} (chmod 600)`);

  // Print summary with admin secret redacted (full secret is in the saved file)
  const redactedSummary = summary.replace(
    /Admin Secret:\s+\S+/,
    `Admin Secret:     ${adminSecret.slice(0, 8)}...REDACTED (see ${credPath})`,
  );
  console.log("\n" + "=".repeat(60));
  console.log("  CORTEX CLOUD SETUP COMPLETE");
  console.log("=".repeat(60));
  console.log(redactedSummary);
  console.log("=".repeat(60));

  if (principalKey) {
    console.log("\nAdd this to your bot.yaml:");
    console.log("─".repeat(40));
    console.log(
      buildBotYamlSnippet({
        endpoint: workerUrl,
        apiKey: principalKey,
        principalId,
      }),
    );
    console.log("─".repeat(40));
  }

  console.log("\nNext steps:");
  console.log("  1. Add the bot.yaml snippet above to ~/.config/grove/bot.yaml");
  console.log("  2. Restart cortex: cortex stop && cortex start");
  console.log("  3. Add more principals: cortex cloud add-operator --name JC --agent-name Ivy --endpoint URL --admin-key SECRET");
}

// =============================================================================
// cloud add-operator
// =============================================================================

async function cloudAddOperator(flags: Record<string, string>): Promise<void> {
  const name = flags.name;
  const agentName = flags["agent-name"];
  const endpoint = flags.endpoint;
  const adminKey = flags["admin-key"];

  if (!name || !agentName || !endpoint || !adminKey) {
    throw new Error(
      "Usage: cortex cloud add-operator --name <principal> --agent-name <agent> --endpoint <URL> --admin-key <SECRET>",
    );
  }

  const principalId = name.toLowerCase().replace(/[^a-z0-9-]/g, "");

  console.log(`Creating principal key for ${name} (${agentName})...`);

  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/admin/keys`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminKey}`,
      },
      body: JSON.stringify({
        principal_id: principalId,
        name: agentName,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Failed: HTTP ${res.status} — ${errText}`);
    }

    const data = (await res.json()) as { key: string; principal_id: string; name: string };

    console.log("\nPrincipal key created successfully!");
    console.log(`  Principal: ${name} (${principalId})`);
    console.log(`  Agent:     ${agentName}`);
    console.log(`  Key:       ${data.key}`);
    console.log("\nAdd this to their bot.yaml:");
    console.log("─".repeat(40));
    console.log(
      buildBotYamlSnippet({
        endpoint: endpoint.replace(/\/+$/, ""),
        apiKey: data.key,
        principalId,
      }),
    );
    console.log("─".repeat(40));
  } catch (err) {
    throw new Error(`Error: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

// =============================================================================
// cloud status
// =============================================================================

async function cloudStatus(flags: Record<string, string>): Promise<void> {
  const endpoint = flags.endpoint;
  // Note: `--admin-key` flag is accepted by the parser for future admin-only
  // queries (e.g., operator-key listings) but the current `status` command
  // only reads public endpoints. The flag stays in the usage line so the
  // help text matches the parser's contract.

  if (!endpoint) {
    throw new Error("Usage: grove-bot cloud status --endpoint <URL> [--admin-key <SECRET>]");
  }

  const base = endpoint.replace(/\/+$/, "");

  // Health check
  console.log("Checking Worker health...");
  try {
    const healthRes = await fetch(`${base}/api/health`);
    if (healthRes.ok) {
      const health = (await healthRes.json()) as Record<string, unknown>;
      console.log(`  Status:  ${String(health.status)}`);
      console.log(`  Runtime: ${String(health.runtime)}`);
    } else {
      console.error(`  Health check failed: HTTP ${healthRes.status}`);
    }
  } catch (err) {
    console.error(`  Cannot reach endpoint: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // State snapshot
  console.log("\nFetching state...");
  try {
    const stateRes = await fetch(`${base}/api/state`);
    if (stateRes.ok) {
      const state = (await stateRes.json()) as {
        agents?: { id: string; name: string; status: string }[];
        sessions?: { session_id: string; status: string; agent_name: string }[];
      };

      const agents = state.agents ?? [];
      const sessions = state.sessions ?? [];
      const activeSessions = sessions.filter((s) => s.status === "active");

      console.log(`  Agents:          ${agents.length}`);
      console.log(`  Total sessions:  ${sessions.length}`);
      console.log(`  Active sessions: ${activeSessions.length}`);

      if (agents.length > 0) {
        console.log("\n  Connected agents:");
        for (const agent of agents) {
          console.log(`    - ${agent.name} (${agent.id}) [${agent.status}]`);
        }
      }

      if (activeSessions.length > 0) {
        console.log("\n  Active sessions:");
        for (const s of activeSessions) {
          console.log(`    - ${s.session_id.slice(0, 12)}... (${s.agent_name})`);
        }
      }
    } else {
      console.error(`  State fetch failed: HTTP ${stateRes.status}`);
    }
  } catch (err) {
    console.error(`  Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// =============================================================================
// cloud repos — Repo management (bot.yaml + Worker secret + D1)
// =============================================================================

const DEFAULT_CONFIG_PATH = join(process.env.HOME ?? "~", ".config", "grove", "bot.yaml");

interface BotYamlGithub {
  repos?: string[];
  [key: string]: unknown;
}

interface BotYamlApi {
  endpoint?: string;
  apiKey?: string;
  cfAccessClientId?: string;
  cfAccessClientSecret?: string;
  [key: string]: unknown;
}

interface BotYaml {
  github?: BotYamlGithub;
  api?: BotYamlApi;
  [key: string]: unknown;
}

/** S-058: Inject CF Access service token headers for M2M auth if configured. */
function injectCfAccessHeaders(headers: Record<string, string>, api: BotYamlApi | undefined): void {
  if (api?.cfAccessClientId && api.cfAccessClientSecret) {
    headers["CF-Access-Client-Id"] = api.cfAccessClientId;
    headers["CF-Access-Client-Secret"] = api.cfAccessClientSecret;
  }
}

function loadBotYaml(configPath: string): { raw: string; parsed: BotYaml } {
  if (!existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);
  const raw = readFileSync(configPath, "utf-8");
  const parsed = YAML.parse(raw) as BotYaml;
  return { raw, parsed };
}

function readAdminSecret(): string | null {
  const credPath = join(process.env.HOME ?? "~", ".config", "grove", "cloud-credentials.txt");
  if (!existsSync(credPath)) return null;
  const content = readFileSync(credPath, "utf-8");
  const match = /Admin Secret:\s+(\S+)/.exec(content);
  return match?.[1] ?? null;
}

async function cloudRepos(subcommand: string, flags: Record<string, string>, extraArgs: string[]): Promise<void> {
  const configPath = flags.config ?? DEFAULT_CONFIG_PATH;

  switch (subcommand) {
    case "list":
      await cloudReposList(configPath);
      break;
    case "add": {
      const target = extraArgs[0];
      if (!target) throw new Error("Usage: grove-bot cloud repos add <owner/repo>");
      await cloudReposAdd(configPath, target, flags);
      break;
    }
    case "remove": {
      const target = extraArgs[0];
      if (!target) throw new Error("Usage: grove-bot cloud repos remove <owner/repo>");
      await cloudReposRemove(configPath, target, flags);
      break;
    }
    default:
      console.log("grove-bot cloud repos — Manage tracked repositories\n");
      console.log("Commands:");
      console.log("  list            Show repos in bot.yaml github.repos");
      console.log("  add <repo>      Add a repo (updates bot.yaml + Worker secret + triggers sync)");
      console.log("  remove <repo>   Remove a repo (updates bot.yaml + Worker secret + prunes D1)\n");
      console.log("Options:");
      console.log("  --config PATH   Path to bot.yaml (default: ~/.config/grove/bot.yaml)");
      console.log("  --cf-api-token  Cloudflare API token (for updating Worker secret)");
      console.log("  --admin-key     Admin secret (for D1 prune; auto-detected from credentials)\n");
      console.log("Examples:");
      console.log("  grove-bot cloud repos list");
      console.log("  grove-bot cloud repos add the-metafactory/new-repo");
      console.log("  grove-bot cloud repos remove the-metafactory/old-repo");
      break;
  }
}

// eslint-disable-next-line @typescript-eslint/require-await
async function cloudReposList(configPath: string): Promise<void> {
  // Body is sync; signature stays async to match the cloud command
  // handler's `await fn(...)` invocation pattern alongside the I/O-
  // bound `cloudReposAdd` / `cloudReposRemove` siblings.
  const { parsed } = loadBotYaml(configPath);
  const repos = parsed.github?.repos ?? [];

  console.log(`Tracked repos (${repos.length}):`);
  for (const repo of repos) {
    console.log(`  ${repo}`);
  }
}

async function cloudReposAdd(configPath: string, repo: string, flags: Record<string, string>): Promise<void> {
  if (!repo.includes("/")) throw new Error(`Repo must be in owner/name format: ${repo}`);

  const { parsed } = loadBotYaml(configPath);
  const repos = parsed.github?.repos ?? [];

  if (repos.includes(repo)) {
    console.log(`${repo} is already tracked`);
    return;
  }

  // 1. Update bot.yaml
  console.log(`[1/3] Adding ${repo} to bot.yaml...`);
  repos.push(repo);
  repos.sort();

  // Surgical YAML edit: insert the new repo into the github.repos array
  parsed.github = parsed.github ?? {};
  parsed.github.repos = repos;
  const updated = YAML.stringify(parsed, { lineWidth: 120 });
  writeFileSync(configPath, updated);
  success(`bot.yaml updated (${repos.length} repos)`);

  // 2. Update GITHUB_REPOS Worker secret
  console.log(`[2/3] Updating GITHUB_REPOS Worker secret...`);
  await updateGithubReposSecret(repos, flags);

  // 3. Wait for Worker secret propagation before syncing
  console.log(`[3/4] Waiting for Worker secret propagation (15s)...`);
  await new Promise((resolve) => setTimeout(resolve, 15_000));

  // 4. Trigger sync (with retry if new repo missing)
  console.log(`[4/4] Triggering sync...`);
  const syncResult = await triggerSync(parsed, flags);
  const syncRepoCount = syncResult && typeof syncResult.repos === 'number' ? syncResult.repos : null;
  if (syncRepoCount !== null && syncRepoCount < repos.length) {
    console.log(`Sync returned ${syncRepoCount} repos, expected ${repos.length} — retrying in 10s...`);
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await triggerSync(parsed, flags);
  }

  console.log(`\n${repo} added successfully`);
}

async function cloudReposRemove(configPath: string, repo: string, flags: Record<string, string>): Promise<void> {
  if (!repo.includes("/")) throw new Error(`Repo must be in owner/name format: ${repo}`);

  const { parsed } = loadBotYaml(configPath);
  const repos = parsed.github?.repos ?? [];

  if (!repos.includes(repo)) {
    console.log(`${repo} is not tracked`);
    return;
  }

  // 1. Update bot.yaml
  console.log(`[1/3] Removing ${repo} from bot.yaml...`);
  const updated_repos = repos.filter((r) => r !== repo);

  parsed.github = parsed.github ?? {};
  parsed.github.repos = updated_repos;
  const updated = YAML.stringify(parsed, { lineWidth: 120 });
  writeFileSync(configPath, updated);
  success(`bot.yaml updated (${updated_repos.length} repos)`);

  // 2. Update GITHUB_REPOS Worker secret
  console.log(`[2/3] Updating GITHUB_REPOS Worker secret...`);
  await updateGithubReposSecret(updated_repos, flags);

  // 3. Delete D1 records via admin API
  console.log(`[3/3] Pruning D1 records for ${repo}...`);
  await pruneRepoFromD1(repo, parsed, flags);

  console.log(`\n${repo} removed successfully`);
}

async function updateGithubReposSecret(repos: string[], flags: Record<string, string>): Promise<void> {
  const cfToken = flags["cf-api-token"] ?? process.env.CLOUDFLARE_API_TOKEN;
  if (!cfToken) {
    warn("No CF API token — skipping Worker secret update");
    console.log("    Set CLOUDFLARE_API_TOKEN or pass --cf-api-token");
    console.log(`    Manual: echo "${repos.join(",")}" | bunx wrangler secret put GITHUB_REPOS`);
    return;
  }

  const srcDir = dirname(dirname(import.meta.dir));
  const workerDir = join(srcDir, "worker");
  const cfEnv: Record<string, string> = { CLOUDFLARE_API_TOKEN: cfToken };

  if (process.env.CLOUDFLARE_ACCOUNT_ID) {
    cfEnv.CLOUDFLARE_ACCOUNT_ID = process.env.CLOUDFLARE_ACCOUNT_ID;
  }

  const result = await runWranglerSecretPut("GITHUB_REPOS", repos.join(","), cfEnv, workerDir);
  if (result.ok) {
    success("GITHUB_REPOS secret updated");
  } else {
    fail(`Failed to update secret: ${result.stderr.trim()}`);
  }
}

async function triggerSync(config: BotYaml, flags: Record<string, string>): Promise<Record<string, unknown> | null> {
  const endpoint = config.api?.endpoint;
  const apiKey = flags["api-key"] ?? config.api?.apiKey;

  if (!endpoint || !apiKey) {
    warn("No endpoint/apiKey in bot.yaml — skipping sync trigger");
    return null;
  }

  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
    injectCfAccessHeaders(headers, config.api);
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/api/sync`, {
      method: "POST",
      headers,
    });
    if (res.ok) {
      const data = await res.json() as Record<string, unknown>;
      success(`Sync complete: ${String(data.repos)} repos`);
      return data;
    } else {
      fail(`Sync failed: HTTP ${res.status}`);
      return null;
    }
  } catch (err) {
    fail(`Sync request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

async function pruneRepoFromD1(repo: string, config: BotYaml, flags: Record<string, string>): Promise<void> {
  const endpoint = config.api?.endpoint;
  const adminKey = flags["admin-key"] ?? readAdminSecret();

  if (!endpoint || !adminKey) {
    warn("No endpoint or admin key — skipping D1 prune");
    console.log("    Pass --admin-key or ensure ~/.config/grove/cloud-credentials.txt exists");
    return;
  }

  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    fail(`Invalid repo format: ${repo}`);
    return;
  }

  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${adminKey}` };
    injectCfAccessHeaders(headers, config.api);
    const res = await fetch(`${endpoint.replace(/\/+$/, "")}/admin/repos/${owner}/${name}`, {
      method: "DELETE",
      headers,
    });
    if (res.ok) {
      const data = await res.json() as { deleted: Record<string, number> };
      const total = Object.values(data.deleted).reduce((a, b) => a + b, 0);
      success(`D1 pruned: ${total} records deleted`);
    } else {
      fail(`D1 prune failed: HTTP ${res.status} — ${await res.text()}`);
    }
  } catch (err) {
    fail(`D1 prune request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// =============================================================================
// cloud webhooks — Webhook health check
// =============================================================================

async function cloudWebhooksCheck(flags: Record<string, string>): Promise<void> {
  const configPath = flags.config ?? DEFAULT_CONFIG_PATH;
  const { parsed } = loadBotYaml(configPath);
  const repos = parsed.github?.repos ?? [];

  if (repos.length === 0) {
    warn("No repos configured in bot.yaml github.repos");
    return;
  }

  const ghToken = flags["github-token"] ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!ghToken) {
    throw new Error(
      "GitHub token required. Pass --github-token or set GITHUB_TOKEN/GH_TOKEN env var.\n" +
      "Needs 'admin:repo_hook' scope to read webhook delivery status."
    );
  }

  console.log(`Checking webhook health for ${repos.length} repos...\n`);

  let healthy = 0;
  let unhealthy = 0;

  for (const repo of repos) {
    try {
      const hooksRes = await fetch(`https://api.github.com/repos/${repo}/hooks`, {
        headers: {
          Authorization: `Bearer ${ghToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "grove-cloud-cli",
        },
      });

      if (!hooksRes.ok) {
        fail(`${repo}: could not fetch hooks (HTTP ${hooksRes.status})`);
        unhealthy++;
        continue;
      }

      const hooks = await hooksRes.json() as {
        id: number;
        active: boolean;
        config: { url: string };
        last_response: { code: number; message: string };
      }[];

      const groveHook = hooks.find((h) => h.config.url.includes("/api/github/webhook"));
      if (!groveHook) {
        fail(`${repo}: no Grove webhook configured`);
        unhealthy++;
        continue;
      }

      const code = groveHook.last_response.code;
      const active = groveHook.active;

      if (!active) {
        fail(`${repo}: webhook disabled (hook ${groveHook.id})`);
        unhealthy++;
      } else if (code === 200) {
        success(`${repo}: healthy (last delivery: 200)`);
        healthy++;
      } else if (code === 0) {
        warn(`${repo}: no deliveries yet or timeout (code 0)`);
        unhealthy++;
      } else {
        fail(`${repo}: last delivery failed (code ${code}: ${groveHook.last_response.message})`);
        unhealthy++;
      }
    } catch (err) {
      fail(`${repo}: ${err instanceof Error ? err.message : String(err)}`);
      unhealthy++;
    }
  }

  console.log(`\nResult: ${healthy} healthy, ${unhealthy} unhealthy out of ${repos.length} repos`);
  if (unhealthy > 0) {
    console.log("\nTo fix webhook secrets, run:");
    console.log("  1. Set Worker secret:  echo '<secret>' | wrangler secret put GITHUB_WEBHOOK_SECRET");
    console.log("  2. Update each repo:   gh api repos/OWNER/REPO/hooks/HOOK_ID -X PATCH -f 'config[secret]=<secret>'");
  }
}

// =============================================================================
// Main — called when this script runs directly or from grove-bot CLI
// =============================================================================

export async function runCloudCommand(argv: string[]): Promise<void> {
  const { command, flags } = parseArgs(argv);

  switch (command) {
    case "setup":
      await cloudSetup(flags);
      break;
    case "add-operator":
      await cloudAddOperator(flags);
      break;
    case "status":
      await cloudStatus(flags);
      break;
    case "repos": {
      // Parse repos subcommand: cloud repos <sub> [args...]
      const reposIdx = argv.indexOf("repos");
      const sub = reposIdx >= 0 && argv.length > reposIdx + 1 ? (argv[reposIdx + 1] ?? "help") : "help";
      // Collect non-flag arguments after the subcommand
      const extraArgs: string[] = [];
      for (let i = reposIdx + 2; i < argv.length; i++) {
        const arg = argv[i] ?? "";
        if (arg.startsWith("--")) { i++; continue; } // skip --flag value pairs
        extraArgs.push(arg);
      }
      await cloudRepos(sub, flags, extraArgs);
      break;
    }
    case "webhooks":
      await cloudWebhooksCheck(flags);
      break;
    default:
      console.log("grove-bot cloud — Automated cloud infrastructure management\n");
      console.log("Commands:");
      console.log("  setup           Provision D1, KV, deploy Worker, create first key");
      console.log("  add-operator    Create a new operator API key on the deployed Worker");
      console.log("  status          Check Worker health and connected operators");
      console.log("  repos           Manage tracked repositories (list, add, remove)");
      console.log("  webhooks        Check webhook delivery health for all tracked repos\n");
      console.log("Examples:");
      console.log("  grove-bot cloud setup --cf-account-id X --cf-api-token Y");
      console.log('  grove-bot cloud add-operator --name "JC" --agent-name "Ivy" --endpoint URL --admin-key KEY');
      console.log("  grove-bot cloud status --endpoint URL --admin-key KEY");
      console.log("  grove-bot cloud repos list");
      console.log("  grove-bot cloud repos add the-metafactory/new-repo");
      console.log("  grove-bot cloud repos remove the-metafactory/old-repo");
      console.log("  grove-bot cloud webhooks");
      break;
  }
}

// If run directly as a script (not imported)
if (import.meta.main) {
  runCloudCommand(process.argv.slice(2)).catch((err: unknown) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
