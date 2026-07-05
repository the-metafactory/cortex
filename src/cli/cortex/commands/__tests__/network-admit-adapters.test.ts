/**
 * S5 (#1519, epic #1514; Sage review on PR #1586) — LIVE adapter tests for
 * `buildLiveAdmitDiscordPort` (network-admit-adapters.ts).
 *
 * The CLI-level tests (network-admit.test.ts) inject a FAKE `AdmitDiscordPort`
 * for the Discord-assign scenarios, so they never exercise the real adapter's
 * token/guild resolution, `resolveRoleId`, or `assignRole` call — they verify
 * the fake, not the moved code. This file drives the LIVE port directly:
 * `process.env.HOME` is pinned to a tmpdir holding a real `cli.yaml` (or none,
 * for the no-token case) so `loadConfig`/`resolveServerContext`
 * (discord-roles.ts) read real config, and `globalThis.fetch` is mocked to
 * stand in for the Discord REST API — asserting the EXACT status + warning
 * text production builds, not a copy the test supplied.
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { buildLiveAdmitPorts } from "../network-admit-adapters";
import { generateStackIdentity } from "../../../../bus/stack-provisioning";
import type { AdmitDiscordPort } from "../network-admit-ports";
import { setMockFetch, urlOf } from "./fetch-mock-helpers";

describe("buildLiveAdmitDiscordPort — live adapter (Sage review, PR #1586)", () => {
  let home: string;
  let prevHome: string | undefined;
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    prevHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "admit-discord-home-"));
    process.env.HOME = home;
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(home, { recursive: true, force: true });
    globalThis.fetch = realFetch;
  });

  /** Write `~/.config/cortex/cli.yaml` (the file discord-roles.ts's loadConfig reads). */
  function writeDiscordConfig(config: Record<string, string>): void {
    const dir = join(home, ".config", "cortex");
    mkdirSync(dir, { recursive: true });
    const yaml = Object.entries(config)
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
      .join("\n");
    writeFileSync(join(dir, "cli.yaml"), `${yaml}\n`, "utf-8");
  }

  /** The live discord port, built with throwaway registry/material fields —
   *  this test only exercises `.discord`. The seed lives UNDER `home` (already
   *  torn down by `afterEach`) so no separate tmpdir needs its own cleanup. */
  function discordPort(): AdmitDiscordPort {
    const seedPath = join(home, "admin.nk");
    const material = generateStackIdentity({ seedPath });
    return buildLiveAdmitPorts({ registryUrl: "http://unused.test", material }).discord;
  }

  test("no config at all → skipped_no_token, exact production warning", async () => {
    // No cli.yaml written — loadConfig() returns {} (discord-roles.ts).
    const port = discordPort();
    const outcome = await port.assignRole({ member: "user-1", role: "community-fleet" });
    expect(outcome.status).toBe("skipped_no_token");
    expect(outcome.warning).toBe(
      "Discord role not assigned: no bot token configured (run: discord config set botToken <token>)",
    );
  });

  test("bot token but no guild id (and no --discord-guild) → skipped_no_guild", async () => {
    writeDiscordConfig({ botToken: "bot-tok-abc" });
    const port = discordPort();
    const outcome = await port.assignRole({ member: "user-1", role: "community-fleet" });
    expect(outcome.status).toBe("skipped_no_guild");
    expect(outcome.warning).toBe(
      "Discord role not assigned: no guild id configured — pass --discord-guild <id> or run: discord config set guildId <id>",
    );
  });

  test("resolveRoleId + assignRole succeed → assigned, empty warning", async () => {
    writeDiscordConfig({ botToken: "bot-tok-abc", guildId: "guild-cfg" });
    let sawResolveGet = false;
    let sawAssignPut = false;
    setMockFetch(async (input, init) => {
      const url = urlOf(input);
      if (init?.method === "PUT") {
        sawAssignPut = true;
        expect(url).toContain("/guilds/guild-cfg/members/user-1/roles/role-xyz");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bot bot-tok-abc");
        return new Response(null, { status: 204 });
      }
      sawResolveGet = true;
      expect(url).toContain("/guilds/guild-cfg/roles");
      return new Response(JSON.stringify([{ id: "role-xyz", name: "community-fleet" }]), { status: 200 });
    });

    const port = discordPort();
    const outcome = await port.assignRole({ member: "user-1", role: "community-fleet" });

    expect(sawResolveGet).toBe(true);
    expect(sawAssignPut).toBe(true);
    expect(outcome.status).toBe("assigned");
    expect(outcome.warning).toBe("");
  });

  test("--discord-guild overrides the configured guild id", async () => {
    writeDiscordConfig({ botToken: "bot-tok-abc", guildId: "guild-cfg" });
    let assignUrl = "";
    setMockFetch(async (input, init) => {
      if (init?.method === "PUT") {
        assignUrl = urlOf(input);
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify([{ id: "role-xyz", name: "community-fleet" }]), { status: 200 });
    });

    const port = discordPort();
    await port.assignRole({ member: "user-1", role: "community-fleet", guild: "guild-flag" });

    expect(assignUrl).toContain("/guilds/guild-flag/");
  });

  test("assignRole 403 (bot lacks Manage Roles) → failed, mapRoleError's exact text", async () => {
    writeDiscordConfig({ botToken: "bot-tok-abc", guildId: "guild-cfg" });
    setMockFetch(async (_input, init) => {
      if (init?.method === "PUT") return new Response("forbidden-body", { status: 403 });
      return new Response(JSON.stringify([{ id: "role-xyz", name: "community-fleet" }]), { status: 200 });
    });

    const port = discordPort();
    const outcome = await port.assignRole({ member: "user-1", role: "community-fleet" });

    expect(outcome.status).toBe("failed");
    // Exact text: mapRoleError's 403 message (discord-roles.ts) wrapped by
    // buildLiveAdmitDiscordPort's "Discord role assignment failed: ... —
    // admission committed, assign role manually" template.
    expect(outcome.warning).toBe(
      "Discord role assignment failed: Bot lacks Manage Roles permission (or its highest role is below the " +
        "target role) in guild guild-cfg. Ensure the bot has Manage Roles and its role is above community-fleet. " +
        "— admission committed, assign role manually",
    );
  });

  test("resolveRoleId throws (role name not found) → failed, assign-manually warning", async () => {
    writeDiscordConfig({ botToken: "bot-tok-abc", guildId: "guild-cfg" });
    setMockFetch(async () => new Response(JSON.stringify([]), { status: 200 })); // no roles match

    const port = discordPort();
    const outcome = await port.assignRole({ member: "user-1", role: "nonexistent-role" });

    expect(outcome.status).toBe("failed");
    // Exact text: resolveRoleId's not-found Error (discord-roles.ts) wrapped by
    // buildLiveAdmitDiscordPort's "Discord role not assigned: ... — assign
    // manually" template.
    expect(outcome.warning).toBe(
      'Discord role not assigned: Role "nonexistent-role" not found in guild guild-cfg. ' +
        "Pass the role's snowflake id directly, or check: discord roles --server <profile> — assign manually",
    );
  });
});
