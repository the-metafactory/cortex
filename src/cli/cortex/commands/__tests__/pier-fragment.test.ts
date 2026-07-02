/**
 * Pier P1 (cortex#1142 / ADR-0015) — package-validity tests for the Pier
 * onboarding-concierge agent fragment and persona.
 *
 * These tests verify that the Pier arc-installable bot package:
 *   1. Has a well-formed agents.d/pier.yaml fragment (loads via loadAgentFromFile)
 *   2. Has a well-formed personas/pier.md persona (required displayName, valid fields)
 *   3. The fragment's id, displayName, capabilities, and presence fields match the
 *      spec in ADR-0015 + docs/design-arc-agent-bots.md
 *
 * All file references are relative to the test fixtures so these tests run
 * offline without a real cortex daemon.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { parse as parseYaml } from "yaml";

// ---------------------------------------------------------------------------
// Paths to the Pier package artifacts under test
// ---------------------------------------------------------------------------

const REPO_ROOT = join(import.meta.dir, "../../../../..");  // Cortex-pier-p1/
const AGENTS_D  = join(REPO_ROOT, "agents.d");
const PERSONAS  = join(REPO_ROOT, "personas");
const FRAGMENT  = join(AGENTS_D, "pier.yaml");
const PERSONA   = join(PERSONAS, "pier.md");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadFragment(): Record<string, unknown> {
  const raw = readFileSync(FRAGMENT, "utf-8");
  const parsed = parseYaml(raw);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Fragment YAML did not parse to an object");
  }
  return parsed as Record<string, unknown>;
}

function loadPersonaFrontmatter(): Record<string, unknown> {
  const raw = readFileSync(PERSONA, "utf-8");
  // Extract YAML frontmatter between first two "---" delimiters.
  const match = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (match?.[1] === undefined) throw new Error("Persona file has no YAML frontmatter block");
  const parsed = parseYaml(match[1]);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Persona frontmatter did not parse to an object");
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Fragment tests
// ---------------------------------------------------------------------------

describe("Pier agent fragment (agents.d/pier.yaml)", () => {
  test("file exists at agents.d/pier.yaml", () => {
    expect(existsSync(FRAGMENT)).toBe(true);
  });

  test("parses as valid YAML", () => {
    expect(() => loadFragment()).not.toThrow();
  });

  test("id is 'pier'", () => {
    const f = loadFragment();
    expect(f.id).toBe("pier");
  });

  test("displayName is 'Pier'", () => {
    const f = loadFragment();
    expect(f.displayName).toBe("Pier");
  });

  test("does NOT carry a retired `roles` field (AgentSchema.roles[] retired at v2.0.0, cortex#297)", () => {
    const f = loadFragment();
    // Authorization moved to policy.principals[]; the agent fragment must not
    // re-introduce the retired field (Zod would silently strip it).
    expect(f.roles).toBeUndefined();
  });

  test("trust includes 'luna'", () => {
    const f = loadFragment();
    expect(Array.isArray(f.trust)).toBe(true);
    expect(f.trust as string[]).toContain("luna");
  });

  test("runtime.substrate is 'claude-code' (in-process shape)", () => {
    const f = loadFragment();
    const rt = f.runtime as Record<string, unknown>;
    expect(rt.substrate).toBe("claude-code");
    expect(rt.mode).toBe("in-process");
  });

  test("runtime.capabilities includes 'onboarding' and 'chat'", () => {
    const f = loadFragment();
    const rt = f.runtime as Record<string, unknown>;
    const caps = rt.capabilities as string[];
    expect(caps).toContain("onboarding");
    expect(caps).toContain("chat");
  });

  test("presence.discord.enabled is true", () => {
    const f = loadFragment();
    const presence = f.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    expect(discord.enabled).toBe(true);
  });

  // compass#84 (L2) — the shippable fragment carries NO live snowflakes. Every
  // surface id is an `__ENV__` placeholder resolved at cortex load from the
  // daemon environment (the guild id, the public entry channel, and — most
  // sensitively — the PRIVATE back-office channel). These assertions pin the
  // placeholder form; a regression that re-hardcodes a literal id fails here.
  test("presence.discord.guildId is a resolve-at-install placeholder (no literal snowflake)", () => {
    const f = loadFragment();
    const presence = f.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    expect(discord.guildId).toBe("__PIER_GUILD_ID__");
    // defence in depth: never a bare 17-20 digit snowflake
    expect(discord.guildId as string).not.toMatch(/^\d{17,20}$/);
  });

  test("presence.discord.agentChannelId (PUBLIC entry) is a placeholder", () => {
    const f = loadFragment();
    const presence = f.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    // Pier greets newcomers in a channel they can reach BEFORE holding the
    // community-fleet role — the public entry, shipped as a placeholder.
    expect(discord.agentChannelId).toBe("__PIER_AGENT_CHANNEL_ID__");
    expect(discord.agentChannelId as string).not.toMatch(/^\d{17,20}$/);
  });

  test("presence.discord.logChannelId (PRIVATE back-office) is a placeholder", () => {
    const f = loadFragment();
    const presence = f.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    // Admission audit trail lands in the private back-office (principal + Pier
    // only). This id is the most sensitive — it MUST never be committed literally.
    expect(discord.logChannelId).toBe("__PIER_LOG_CHANNEL_ID__");
    expect(discord.logChannelId as string).not.toMatch(/^\d{17,20}$/);
  });

  test("presence.discord.token references env var placeholder (not a real token)", () => {
    const f = loadFragment();
    const presence = f.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    // Must be an `__ENV__` placeholder (the form the cortex config loader
    // resolves), never a hardcoded token.
    const token = discord.token as string;
    expect(token).toMatch(/^__[A-Z0-9_]*TOKEN[A-Z0-9_]*__$/);
  });

  test("presence.discord.dmOwner is false (Pier is public-channel only)", () => {
    const f = loadFragment();
    const presence = f.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    expect(discord.dmOwner).toBe(false);
  });

  test("fragment carries a persona path field", () => {
    const f = loadFragment();
    expect(typeof f.persona).toBe("string");
    expect((f.persona as string).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Persona tests
// ---------------------------------------------------------------------------

describe("Pier persona (personas/pier.md)", () => {
  test("file exists at personas/pier.md", () => {
    expect(existsSync(PERSONA)).toBe(true);
  });

  test("has YAML frontmatter block", () => {
    const raw = readFileSync(PERSONA, "utf-8");
    expect(raw).toMatch(/^---\n[\s\S]*?\n---/);
  });

  test("frontmatter parses without error", () => {
    expect(() => loadPersonaFrontmatter()).not.toThrow();
  });

  test("displayName in frontmatter is 'Pier'", () => {
    const fm = loadPersonaFrontmatter();
    expect(fm.displayName).toBe("Pier");
  });

  test("temperature (if set) is in [0.0, 1.0]", () => {
    const fm = loadPersonaFrontmatter();
    if (fm.temperature !== undefined) {
      expect(typeof fm.temperature).toBe("number");
      expect(fm.temperature as number).toBeGreaterThanOrEqual(0.0);
      expect(fm.temperature as number).toBeLessThanOrEqual(1.0);
    }
  });

  test("tags (if set) is an array of strings", () => {
    const fm = loadPersonaFrontmatter();
    if (fm.tags !== undefined) {
      expect(Array.isArray(fm.tags)).toBe(true);
      (fm.tags as unknown[]).forEach((t) => expect(typeof t).toBe("string"));
    }
  });

  test("prose body exists and references Pier's core purpose (ADR-0015)", () => {
    const raw = readFileSync(PERSONA, "utf-8");
    // Strip frontmatter, check body is non-trivial and mentions key concepts
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
    expect(body.length).toBeGreaterThan(100);
    // Must describe the two-tier model (ADR-0015 requirement)
    expect(body.toLowerCase()).toMatch(/tier/);
    // Must reference the admission gate
    expect(body.toLowerCase()).toMatch(/admit/);
    // Must say it issues nothing
    expect(body.toLowerCase()).toMatch(/issue/);
  });

  test("persona does NOT contain a real bot token (security invariant)", () => {
    const raw = readFileSync(PERSONA, "utf-8");
    // Tokens typically start with the Discord bot token prefix
    expect(raw).not.toMatch(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{27,}/);
  });
});

// ---------------------------------------------------------------------------
// Arc-manifest tests
// ---------------------------------------------------------------------------

describe("Pier arc-manifest (arc-manifest-pier.yaml)", () => {
  const MANIFEST = join(REPO_ROOT, "arc-manifest-pier.yaml");

  test("file exists", () => {
    expect(existsSync(MANIFEST)).toBe(true);
  });

  test("parses as valid YAML", () => {
    const raw = readFileSync(MANIFEST, "utf-8");
    expect(() => parseYaml(raw)).not.toThrow();
  });

  test("name is 'pier'", () => {
    const raw = readFileSync(MANIFEST, "utf-8");
    const m = parseYaml(raw) as Record<string, unknown>;
    expect(m.name).toBe("pier");
  });

  test("type is 'agent'", () => {
    const raw = readFileSync(MANIFEST, "utf-8");
    const m = parseYaml(raw) as Record<string, unknown>;
    expect(m.type).toBe("agent");
  });

  test("targets includes 'cortex'", () => {
    const raw = readFileSync(MANIFEST, "utf-8");
    const m = parseYaml(raw) as Record<string, unknown>;
    expect(Array.isArray(m.targets)).toBe(true);
    expect(m.targets as string[]).toContain("cortex");
  });

  test("runtime.substrate is 'claude-code' (in-process, no standalone daemon needed)", () => {
    const raw = readFileSync(MANIFEST, "utf-8");
    const m = parseYaml(raw) as Record<string, unknown>;
    const rt = (m.runtime as Record<string, unknown>);
    expect(rt.substrate).toBe("claude-code");
    expect(rt.mode).toBe("in-process");
  });

  test("provides.files declares persona.md and agent.yaml destinations", () => {
    const raw = readFileSync(MANIFEST, "utf-8");
    const m = parseYaml(raw) as Record<string, unknown>;
    const files = (m.provides as Record<string, unknown>).files as Record<string, string>;
    expect(files["persona.md"]).toContain("personas/pier.md");
    expect(files["agent.yaml"]).toContain("agents.d/pier.yaml");
  });

  test("lifecycle.postinstall lists signal-cortex-reload.sh (first step)", () => {
    const raw = readFileSync(MANIFEST, "utf-8");
    const m = parseYaml(raw) as Record<string, unknown>;
    const lc = m.lifecycle as Record<string, unknown>;
    const post = lc.postinstall as string[];
    expect(post[0]).toContain("signal-cortex-reload.sh");
  });

  test("lifecycle does NOT list issue-nats-creds.sh (Pier is in-process, no bus identity)", () => {
    const raw = readFileSync(MANIFEST, "utf-8");
    const m = parseYaml(raw) as Record<string, unknown>;
    const lc = m.lifecycle as Record<string, unknown>;
    const allSteps = [
      ...((lc.preinstall as string[] | undefined) ?? []),
      ...((lc.postinstall as string[] | undefined) ?? []),
    ];
    expect(allSteps.join("\n")).not.toContain("issue-nats-creds");
  });
});

// ---------------------------------------------------------------------------
// AIRGAP lock-down (ADR-0015 + ADR-0017, cortex#1142 / #1175)
//
// The load-bearing security invariant: Pier is a PUBLIC, zero-authority
// concierge that SURFACES admission requests but is *structurally incapable*
// of running them. The privileged acts (`cortex network admit`,
// `cortex network secret add-member`, the Discord role grant) require Bash /
// Skill tools Pier does not have. These tests fail-closed: any future edit that
// hands Pier a privileged tool, an executor role, or "drives the admit gate"
// language breaks the build before it can ship.
// ---------------------------------------------------------------------------

describe("Pier AIRGAP — structurally cannot admit or hold a secret", () => {
  const MANIFEST = join(REPO_ROOT, "arc-manifest-pier.yaml");

  // The public entry channel and the private back-office channel — shipped as
  // resolve-at-install `__ENV__` placeholders (compass#84 / L2), never literal
  // snowflakes. Pier greets in the PUBLIC channel. The airgap invariant is that
  // the manifest binds the PUBLIC entry, distinct from the PRIVATE back-office;
  // asserting on the placeholders preserves that check without committing ids.
  const PUBLIC_ENTRY_CHANNEL = "__PIER_AGENT_CHANNEL_ID__";
  const PRIVATE_BACKOFFICE_CHANNEL = "__PIER_LOG_CHANNEL_ID__";

  // Any of these in a tool allowlist would break the airgap: Bash/Skill let Pier
  // shell out to the privileged CLI; Write/Edit let it tamper with config.
  const PRIVILEGED_TOOL = /^(Bash|Skill|Write|Edit|NotebookEdit|mcp__)/;

  function personaBody(): string {
    const raw = readFileSync(PERSONA, "utf-8");
    return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
  }
  function loadManifest(): Record<string, unknown> {
    return parseYaml(readFileSync(MANIFEST, "utf-8")) as Record<string, unknown>;
  }

  test("persona allowedTools is exactly [Read] — Read-only, no privileged tool", () => {
    const fm = loadPersonaFrontmatter();
    expect(fm.allowedTools).toEqual(["Read"]);
    (fm.allowedTools as string[]).forEach((t) =>
      expect(t).not.toMatch(PRIVILEGED_TOOL),
    );
  });

  test("fragment openOnboardingAllowedTools is exactly [Read] (stranger session is Read-only too)", () => {
    const f = loadFragment();
    // Mirrors the persona allowlist — the anon onboarding session must not get
    // broader tools than a mapped Pier session (cortex#1167).
    expect(f.openOnboardingAllowedTools).toEqual(["Read"]);
    (f.openOnboardingAllowedTools as string[]).forEach((t) =>
      expect(t).not.toMatch(PRIVILEGED_TOOL),
    );
  });

  test("no Pier tool allowlist contains Bash/Skill/Write/Edit/mcp__* (cannot shell out to the CLI)", () => {
    const fm = loadPersonaFrontmatter();
    const f = loadFragment();
    const allTools = [
      ...((fm.allowedTools as string[] | undefined) ?? []),
      ...((f.openOnboardingAllowedTools as string[] | undefined) ?? []),
    ];
    allTools.forEach((t) => expect(t).not.toMatch(PRIVILEGED_TOOL));
  });

  test("persona declares behavior.issues_nothing = true", () => {
    const fm = loadPersonaFrontmatter();
    const behavior = fm.behavior as Record<string, unknown> | undefined;
    expect(behavior?.issues_nothing).toBe(true);
  });

  test("fragment carries no privileged-executor role (roles[] retired; airgap is the boundary)", () => {
    const f = loadFragment();
    expect(f.roles).toBeUndefined();
  });

  test("manifest carries no retired/executor `roles` field on identity", () => {
    const m = loadManifest();
    const identity = m.identity as Record<string, unknown> | undefined;
    expect(identity?.roles).toBeUndefined();
  });

  test("manifest binds the PUBLIC entry channel (not the private back-office) and matches the fragment", () => {
    const m = loadManifest();
    const f = loadFragment();
    const mDiscord = (m.presence as Record<string, unknown>).discord as Record<string, unknown>;
    const fDiscord = (f.presence as Record<string, unknown>).discord as Record<string, unknown>;
    // Pier must greet in the channel newcomers can reach BEFORE any role.
    expect(mDiscord.agentChannelId).toBe(PUBLIC_ENTRY_CHANNEL);
    expect(mDiscord.agentChannelId).not.toBe(PRIVATE_BACKOFFICE_CHANNEL);
    // The manifest's public identifiers must not drift from the rendered fragment.
    expect(mDiscord.agentChannelId).toBe(fDiscord.agentChannelId);
    expect(mDiscord.guildId).toBe(fDiscord.guildId);
  });

  test("manifest description frames Pier as surfacing — never as an admit executor", () => {
    const m = loadManifest();
    const desc = (m.description as string).toLowerCase();
    expect(desc).toContain("surface");
    expect(desc).toContain("issues nothing");
    // Must NOT claim Pier drives/runs the admit gate itself.
    expect(desc).not.toMatch(/drives?\s+[^.]*\bnetwork admit\b/);
  });

  test("persona surfaces admission — explicitly forbids Pier running the gate itself", () => {
    const body = personaBody().toLowerCase();
    // Surface-not-execute invariants (cortex#1164 / #1161).
    expect(body).toContain("you surface; a human admits");
    expect(body).toContain("you surface; a human grants");
    // The explicit prohibition on self-invoking the signed admin command.
    expect(body).toMatch(/do\s+\*\*not\*\*\s+invoke\s+`cortex network admit`/);
    // Never approve its own request.
    expect(body).toContain("never approve your own");
  });

  test("persona never instructs Pier to RUN admit/secret — every privileged command is surfaced, for a human to run", () => {
    const body = personaBody();
    // The privileged commands appear ONLY inside "for a principal to review and
    // run" framing — never as an instruction to Pier. Assert the framing exists
    // wherever the signed admin command does.
    expect(body).toMatch(/their admin seed signs; you never hold it/);
    // The secret command (post-merge sealed flow) is surfaced for the admin.
    expect(body).toMatch(/cortex network secret add-member/);
    expect(body).toMatch(/the admin runs it/i);
  });
});
