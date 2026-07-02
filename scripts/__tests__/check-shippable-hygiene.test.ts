// Tests for the L2 shippable-config hygiene gate (design doc §4 L2, compass#81/#87).
//
// SELF-CONFLICT FIX (design doc §4 L2): every forbidden string this suite uses
// is CONSTRUCTED AT RUNTIME by concatenation, never written as a literal. That
// keeps this test file itself clean under the gate (and under L1's scanner), so
// the gate is green over its own scripts/ subtree. The synthetic ids/emails
// below are obviously-fake (1234…, gmail.com) — NEVER a real deployment id.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";
import { scanTree, formatFindings, type Finding } from "../check-shippable-hygiene";

// --- runtime-built forbidden strings (never literals) ---------------------
const SYNTH_SNOWFLAKE = "1234567890" + "12345678"; // 18 digits, obviously fake
const SYNTH_INTERNAL_EMAIL = "leak" + "@" + "meta-factory.ai"; // org's own domain
const SYNTH_REAL_SEED_EMAIL = "real.person" + "@" + "gmail.com"; // non-placeholder
const PLACEHOLDER_SEED_EMAIL = "operator@example.com"; // RFC-reserved → OK

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `hygiene-${prefix}-`));
}
function write(root: string, rel: string, body: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}
function rules(fs: Finding[]): string[] {
  return fs.map((f) => f.rule).sort();
}

describe("check-shippable-hygiene — clean fragments pass", () => {
  test("generic-marked, all-placeholder agent fragment → 0 findings", () => {
    const root = tmp("clean-generic");
    write(
      root,
      "agents.d/bot.yaml",
      [
        "# audience: generic",
        "id: bot",
        "presence:",
        "  discord:",
        "    enabled: true",
        "    token: __BOT_TOKEN__",
        "    guildId: __BOT_GUILD_ID__",
        "    agentChannelId: __BOT_CHANNEL_ID__",
      ].join("\n") + "\n",
    );
    const findings = scanTree({ root });
    expect(findings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test(".example template with zeroed ids is exempt (not scanned for live ids)", () => {
    const root = tmp("clean-example");
    write(
      root,
      "agents.d/bot.yaml.example",
      [
        "id: bot",
        "presence:",
        "  discord:",
        "    guildId: \"000000000000000000\"",
        "    agentChannelId: \"000000000000000000\"",
      ].join("\n") + "\n",
    );
    const findings = scanTree({ root });
    expect(findings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("all-zero / all-same-digit ids are treated as zeroed sentinels (pass)", () => {
    const root = tmp("clean-zeroed");
    write(
      root,
      "agents.d/bot.yaml",
      [
        "# audience: generic",
        "presence:",
        "  discord:",
        "    guildId: \"000000000000000000\"",
        "    agentChannelId: \"111111111111111111\"",
      ].join("\n") + "\n",
    );
    const findings = scanTree({ root });
    expect(findings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("seed with an RFC-reserved placeholder email (@example.com) passes", () => {
    const root = tmp("clean-seed");
    write(
      root,
      "migrations/0002_seed.sql",
      `INSERT INTO users (id, email) VALUES ('operator', '${PLACEHOLDER_SEED_EMAIL}');\n`,
    );
    const findings = scanTree({ root });
    expect(findings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("check-shippable-hygiene — deployment leaks BLOCK", () => {
  test("live snowflake in an agent fragment → block (masked)", () => {
    const root = tmp("live-id");
    write(
      root,
      "agents.d/clientbot.yaml",
      [
        "# audience: generic",
        "presence:",
        "  discord:",
        `    guildId: "${SYNTH_SNOWFLAKE}"`,
      ].join("\n") + "\n",
    );
    const findings = scanTree({ root });
    expect(rules(findings)).toContain("agent-fragment-live-platform-id");
    // MASKING: the literal id must NEVER appear in the rendered output.
    const out = formatFindings(findings);
    expect(out).not.toContain(SYNTH_SNOWFLAKE);
    expect(out).toContain("agents.d/clientbot.yaml");
    rmSync(root, { recursive: true, force: true });
  });

  test("the marker does NOT exempt a live literal (no escape hatch)", () => {
    const root = tmp("marker-no-escape");
    // Marker present AND a live id present → still blocks. The marker is a
    // declaration, not a suppression (design doc §4 L2 "generic fragment …
    // passing the rules").
    write(
      root,
      "arc-manifest-clientbot.yaml",
      [
        "# audience: generic",
        "name: clientbot",
        "presence:",
        "  discord:",
        `    logChannelId: "${SYNTH_SNOWFLAKE}"`,
      ].join("\n") + "\n",
    );
    const findings = scanTree({ root });
    expect(rules(findings)).toContain("agent-fragment-live-platform-id");
    rmSync(root, { recursive: true, force: true });
  });

  test("internal-domain email in a fragment → block (masked)", () => {
    const root = tmp("internal-email");
    write(
      root,
      "personas/clientbot.md",
      `# Client bot\n\nContact: ${SYNTH_INTERNAL_EMAIL}\n`,
    );
    const findings = scanTree({ root });
    expect(rules(findings)).toContain("agent-fragment-internal-email");
    const out = formatFindings(findings);
    expect(out).not.toContain(SYNTH_INTERNAL_EMAIL);
    rmSync(root, { recursive: true, force: true });
  });

  test("real (non-placeholder) identity in seed SQL → block (masked)", () => {
    const root = tmp("seed-identity");
    write(
      root,
      "src/db/migrations/0002_seed_data.sql",
      `INSERT INTO users (email) VALUES ('${SYNTH_REAL_SEED_EMAIL}');\n`,
    );
    const findings = scanTree({ root });
    expect(rules(findings)).toContain("seed-real-identity");
    const out = formatFindings(findings);
    expect(out).not.toContain(SYNTH_REAL_SEED_EMAIL);
    rmSync(root, { recursive: true, force: true });
  });

  test("presence-bearing fragment missing the generic marker → block with remediation", () => {
    const root = tmp("missing-marker");
    write(
      root,
      "agents.d/undeclared.yaml",
      [
        "id: undeclared",
        "presence:",
        "  discord:",
        "    guildId: __X_GUILD_ID__",
      ].join("\n") + "\n",
    );
    const findings = scanTree({ root });
    const f = findings.find((x) => x.rule === "presence-fragment-missing-marker");
    expect(f).toBeDefined();
    expect(f!.remediation).toContain("# audience: generic");
    rmSync(root, { recursive: true, force: true });
  });
});

describe("check-shippable-hygiene — fail-closed + scope", () => {
  test("unparseable YAML fragment fails closed (block)", () => {
    const root = tmp("bad-yaml");
    write(root, "agents.d/broken.yaml", "id: [unterminated\n  : : :\n");
    const findings = scanTree({ root });
    expect(rules(findings)).toContain("unparseable-fragment");
    rmSync(root, { recursive: true, force: true });
  });

  test("test/fixture paths are excluded from scanning", () => {
    const root = tmp("excluded");
    // A would-fail fragment placed under __tests__/fixtures is NOT shippable.
    write(
      root,
      "src/foo/__tests__/fixtures/agents.d/bot.yaml",
      `presence:\n  discord:\n    guildId: "${SYNTH_SNOWFLAKE}"\n`,
    );
    const findings = scanTree({ root });
    expect(findings).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  test("manifest-derived provides.files widens scope to a novel ship path", () => {
    const root = tmp("manifest-derived");
    // A fragment shipped from a NON-standard directory (not agents.d/…) must
    // still be scanned because a manifest declares it as a provided file.
    write(
      root,
      "arc-manifest-x.yaml",
      [
        "# audience: generic",
        "name: x",
        "provides:",
        "  files:",
        "    - source: config/clientbot.yaml",
        "      target: ~/.config/cortex/agents.d/clientbot.yaml",
      ].join("\n") + "\n",
    );
    write(
      root,
      "config/clientbot.yaml",
      [
        "# audience: generic",
        "presence:",
        "  discord:",
        `    guildId: "${SYNTH_SNOWFLAKE}"`,
      ].join("\n") + "\n",
    );
    const findings = scanTree({ root });
    expect(
      findings.some(
        (f) =>
          f.rule === "agent-fragment-live-platform-id" &&
          f.file === "config/clientbot.yaml",
      ),
    ).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });
});

describe("check-shippable-hygiene — committed pass fixtures", () => {
  test("the committed passing fixtures scan clean", () => {
    const fixtures = join(__dirname, "fixtures", "shippable-hygiene", "pass");
    const findings = scanTree({ root: fixtures });
    expect(findings).toEqual([]);
  });
});

describe("check-shippable-hygiene — GREEN on cortex's real tree", () => {
  test("scanning the whole cortex tree yields 0 findings (acceptance)", () => {
    const repoRoot = join(__dirname, "..", "..");
    const findings = scanTree({ root: repoRoot });
    if (findings.length) {
      // Surface masked findings to make a regression legible without leaking.
      // eslint-disable-next-line no-console
      console.error(formatFindings(findings));
    }
    expect(findings).toEqual([]);
  });
});
