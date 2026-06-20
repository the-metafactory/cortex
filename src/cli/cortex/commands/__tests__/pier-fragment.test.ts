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
import { join, dirname } from "path";
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

  test("presence.discord.guildId is the community guild snowflake", () => {
    const f = loadFragment();
    const presence = f.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    // The Metafactory community guild (metafactory-community Discord server)
    expect(discord.guildId).toBe("1505549701674700991");
  });

  test("presence.discord.agentChannelId is #onboard-your-fleet (PUBLIC entry channel)", () => {
    const f = loadFragment();
    const presence = f.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    // Pier must greet newcomers in a channel they can reach BEFORE holding the
    // community-fleet role — the public entry, not the gated working surface.
    expect(discord.agentChannelId).toBe("1517154685595942972");
  });

  test("presence.discord.logChannelId is #assistant-fleet-onboarding (PRIVATE back-office)", () => {
    const f = loadFragment();
    const presence = f.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    // Admission audit trail lands in the private back-office (principal + Pier only),
    // distinct from the public entry channel.
    expect(discord.logChannelId).toBe("1514679294553751613");
  });

  test("presence.discord.token references env var placeholder (not a real token)", () => {
    const f = loadFragment();
    const presence = f.presence as Record<string, unknown>;
    const discord = presence.discord as Record<string, unknown>;
    // Must be an env-var placeholder, never a hardcoded token
    const token = discord.token as string;
    expect(token).toMatch(/\$\{.*TOKEN.*\}/);
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
