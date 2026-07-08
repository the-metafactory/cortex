/**
 * Unit tests for the cortex-owned Discord role helpers used by
 * `cortex network admit` (ADR-0015, O-5). These helpers were carried in the
 * extracted Discord CLI lib until epic #1171 S2 moved the CLI tooling into the
 * `metafactory-discord` bundle (ADR-0017); the runtime slice the daemon imports
 * stayed in cortex at src/cli/cortex/lib/discord-roles.ts and is covered here.
 *
 * Tests cover:
 *   - assignRole: PUT /guilds/{guild}/members/{user}/roles/{role}
 *   - resolveRoleId: GET /guilds/{guild}/roles → name→id resolution
 *   - resolveServerContext: flag/profile precedence (pure, no I/O)
 *
 * ALL network calls are mocked via Bun's fetch spy — no live Discord API.
 * The bot token is NEVER echoed in error messages (security invariant).
 */

import { describe, expect, test, spyOn } from "bun:test";
import {
  assignRole,
  removeRole,
  resolveRoleId,
  resolveServerContext,
  ServerContextError,
  type DiscordCliConfig,
} from "../discord-roles";

const GUILD = "444444444444444444";
const USER = "111111111111111111";
const ROLE_ID = "222222222222222222";
const BOT_TOKEN = "Bot.secret-token-must-not-appear-in-errors";

function fakeResponse(status: number, body: unknown = null): Response {
  const text = body === null ? "" : JSON.stringify(body);
  return new Response(text, { status, headers: { "Content-Type": "application/json" } });
}

describe("assignRole", () => {
  test("204 → success, hits the correct PUT endpoint", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(204));
    const result = await assignRole(BOT_TOKEN, GUILD, USER, ROLE_ID);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://discord.com/api/v10/guilds/${GUILD}/members/${USER}/roles/${ROLE_ID}`,
    );
    expect(init?.method).toBe("PUT");
    fetchMock.mockRestore();
  });

  test("403 → Manage Roles message naming the guild, never the token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" }),
    );
    const result = await assignRole(BOT_TOKEN, GUILD, USER, ROLE_ID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Manage Roles/);
    expect(result.error).toMatch(GUILD);
    expect(result.error).not.toContain(BOT_TOKEN);
    fetchMock.mockRestore();
  });

  test("404 → member or role not found", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(404));
    const result = await assignRole(BOT_TOKEN, GUILD, USER, ROLE_ID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
    expect(result.error).not.toContain(BOT_TOKEN);
    fetchMock.mockRestore();
  });
});

describe("removeRole (C-1350 S3 — de-admission)", () => {
  test("204 → success, hits the correct DELETE endpoint (inverse of assign)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(204));
    const result = await removeRole(BOT_TOKEN, GUILD, USER, ROLE_ID);
    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://discord.com/api/v10/guilds/${GUILD}/members/${USER}/roles/${ROLE_ID}`,
    );
    expect(init?.method).toBe("DELETE");
    fetchMock.mockRestore();
  });

  test("403 → non-fatal RoleResult (never throws), names guild, hides token", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" }),
    );
    // Non-fatal contract: it RESOLVES a failure result, it does NOT reject.
    const result = await removeRole(BOT_TOKEN, GUILD, USER, ROLE_ID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Manage Roles/);
    expect(result.error).toMatch(GUILD);
    expect(result.error).not.toContain(BOT_TOKEN);
    fetchMock.mockRestore();
  });

  test("404 → member or role not found, non-fatal", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(fakeResponse(404));
    const result = await removeRole(BOT_TOKEN, GUILD, USER, ROLE_ID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not found/);
    expect(result.error).not.toContain(BOT_TOKEN);
    fetchMock.mockRestore();
  });

  test("other status → surfaces status + body, non-fatal", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(500, { message: "boom" }),
    );
    const result = await removeRole(BOT_TOKEN, GUILD, USER, ROLE_ID);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/500/);
    fetchMock.mockRestore();
  });
});

describe("resolveRoleId", () => {
  test("snowflake passthrough — no network call", async () => {
    const fetchMock = spyOn(globalThis, "fetch");
    const id = await resolveRoleId(BOT_TOKEN, GUILD, ROLE_ID);
    expect(id).toBe(ROLE_ID);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  test("name → id via guild roles list", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, [
        { id: ROLE_ID, name: "community-fleet" },
        { id: "111", name: "other" },
      ]),
    );
    const id = await resolveRoleId(BOT_TOKEN, GUILD, "community-fleet");
    expect(id).toBe(ROLE_ID);
    fetchMock.mockRestore();
  });

  test("not found → throws naming the guild", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, [{ id: "111", name: "other" }]),
    );
    await expect(resolveRoleId(BOT_TOKEN, GUILD, "community-fleet")).rejects.toThrow(
      /not found/,
    );
    fetchMock.mockRestore();
  });

  test("ambiguous name → throws", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, [
        { id: "aaa", name: "fleet" },
        { id: "bbb", name: "Fleet" },
      ]),
    );
    await expect(resolveRoleId(BOT_TOKEN, GUILD, "fleet")).rejects.toThrow(/ambiguous/);
    fetchMock.mockRestore();
  });
});

describe("resolveServerContext", () => {
  const base: DiscordCliConfig = {
    botToken: "top-token",
    guildId: "top-guild",
    defaultChannel: "general",
  };

  test("no flags → byte-identical to top-level config", () => {
    const ctx = resolveServerContext(base, {});
    expect(ctx.guildId).toBe("top-guild");
    expect(ctx.botToken).toBe("top-token");
    expect(ctx.serverName).toBeUndefined();
  });

  test("--guild overrides guildId", () => {
    const ctx = resolveServerContext(base, { guild: "flag-guild" });
    expect(ctx.guildId).toBe("flag-guild");
    expect(ctx.botToken).toBe("top-token");
  });

  test("--server profile layers guildId + optional token", () => {
    const cfg: DiscordCliConfig = {
      ...base,
      servers: { community: { guildId: "comm-guild", botToken: "comm-token" } },
    };
    const ctx = resolveServerContext(cfg, { server: "community" });
    expect(ctx.guildId).toBe("comm-guild");
    expect(ctx.botToken).toBe("comm-token");
    expect(ctx.serverName).toBe("community");
  });

  test("unknown profile → ServerContextError", () => {
    expect(() => resolveServerContext(base, { server: "nope" })).toThrow(ServerContextError);
  });

  test("--guild conflicting with --server profile → throws", () => {
    const cfg: DiscordCliConfig = {
      ...base,
      servers: { community: { guildId: "comm-guild" } },
    };
    expect(() => resolveServerContext(cfg, { server: "community", guild: "different" })).toThrow(
      /Conflicting guild/,
    );
  });
});
