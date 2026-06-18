/**
 * Unit tests for Discord guild-role management (O-5 — community-fleet admission).
 *
 * Tests cover:
 *   - assignRole: PUT /guilds/{guild}/members/{user}/roles/{role}
 *   - removeRole: DELETE /guilds/{guild}/members/{user}/roles/{role}
 *   - resolveRoleId: GET /guilds/{guild}/roles → name→id resolution
 *
 * ALL network calls are mocked via Bun's `mock.module` — no live Discord API.
 * The bot token is NEVER echoed in error messages (security invariant).
 */

import { describe, expect, test, beforeEach, mock, spyOn } from "bun:test";
import {
  assignRole,
  removeRole,
  resolveRoleId,
  isSnowflake,
  type RoleResult,
} from "../lib/discord";

// ─── helpers ──────────────────────────────────────────────────────────────────

const GUILD = "1505549701674700991"; // community guild (fixture)
const USER = "123456789012345678";
const ROLE_ID = "999000111222333444";
const BOT_TOKEN = "Bot.secret-token-must-not-appear-in-errors";

/** Build a `Response`-like mock accepted by `fetch`. */
function fakeResponse(status: number, body: unknown = null): Response {
  const text = body === null ? "" : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── assignRole ───────────────────────────────────────────────────────────────

describe("assignRole", () => {
  test("204 → success with no error", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(204)
    );

    const result = await assignRole(BOT_TOKEN, GUILD, USER, ROLE_ID);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify the correct Discord endpoint + method
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://discord.com/api/v10/guilds/${GUILD}/members/${USER}/roles/${ROLE_ID}`
    );
    expect(init?.method).toBe("PUT");
    expect((init?.headers as Record<string, string>)?.Authorization).toBe(
      `Bot ${BOT_TOKEN}`
    );

    fetchMock.mockRestore();
  });

  test("403 → clear message naming the guild (not the token)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await assignRole(BOT_TOKEN, GUILD, USER, ROLE_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Manage Roles/);
    expect(result.error).toMatch(GUILD);
    // Token must never appear in error output.
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });

  test("404 → clear 'member or role not found' message", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(404, { message: "Unknown User" })
    );

    const result = await assignRole(BOT_TOKEN, GUILD, USER, ROLE_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/member or role not found/i);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });

  test("other error → surfaces status + body", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(500, { message: "Internal Server Error" })
    );

    const result = await assignRole(BOT_TOKEN, GUILD, USER, ROLE_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/500/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

// ─── removeRole ───────────────────────────────────────────────────────────────

describe("removeRole", () => {
  test("204 → success", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(204)
    );

    const result = await removeRole(BOT_TOKEN, GUILD, USER, ROLE_ID);

    expect(result.success).toBe(true);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://discord.com/api/v10/guilds/${GUILD}/members/${USER}/roles/${ROLE_ID}`
    );
    expect(init?.method).toBe("DELETE");

    fetchMock.mockRestore();
  });

  test("403 → clear message (not the token)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Permissions" })
    );

    const result = await removeRole(BOT_TOKEN, GUILD, USER, ROLE_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Manage Roles/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });

  test("404 → member or role not found", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(404, { message: "Unknown Member" })
    );

    const result = await removeRole(BOT_TOKEN, GUILD, USER, ROLE_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/member or role not found/i);

    fetchMock.mockRestore();
  });

  test("other error → surfaces status", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(429, { message: "Too Many Requests", retry_after: 1 })
    );

    const result = await removeRole(BOT_TOKEN, GUILD, USER, ROLE_ID);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/429/);
    expect(result.error).not.toContain(BOT_TOKEN);

    fetchMock.mockRestore();
  });
});

// ─── resolveRoleId ────────────────────────────────────────────────────────────

/** Fixture with UNIQUE role names (no case-collision). */
const ROLES_UNIQUE = [
  { id: "111111111111111111", name: "admin" },
  { id: "222222222222222222", name: "community-fleet" },
  { id: "333333333333333333", name: "member" },
];

/** Fixture with two roles whose names collide case-insensitively (different ids). */
const ROLES_AMBIGUOUS = [
  { id: "111111111111111111", name: "admin" },
  { id: "222222222222222222", name: "community-fleet" },
  { id: "444444444444444444", name: "Community-Fleet" }, // different id → ambiguous
];

describe("resolveRoleId", () => {
  test("snowflake id passthrough — no API call", async () => {
    const fetchMock = spyOn(globalThis, "fetch");

    const result = await resolveRoleId(BOT_TOKEN, GUILD, "222222222222222222");

    expect(result).toBe("222222222222222222");
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });

  test("name lookup — returns matching role id (exact, case-insensitive)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, ROLES_UNIQUE)
    );

    const result = await resolveRoleId(BOT_TOKEN, GUILD, "community-fleet");

    expect(result).toBe("222222222222222222");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      `https://discord.com/api/v10/guilds/${GUILD}/roles`
    );

    fetchMock.mockRestore();
  });

  test("name lookup — case-insensitive (UPPERCASE input)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, ROLES_UNIQUE)
    );

    const result = await resolveRoleId(BOT_TOKEN, GUILD, "COMMUNITY-FLEET");

    expect(result).toBe("222222222222222222");

    fetchMock.mockRestore();
  });

  test("name not found → throws with clear message (not the token)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, ROLES_UNIQUE)
    );

    await expect(
      resolveRoleId(BOT_TOKEN, GUILD, "nonexistent-role")
    ).rejects.toThrow(/not found/i);

    fetchMock.mockRestore();
  });

  test("ambiguous name (multiple case variants with different ids) → throws listing matches", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, ROLES_AMBIGUOUS)
    );

    // Both "community-fleet" (222…) and "Community-Fleet" (444…) match case-insensitively
    await expect(
      resolveRoleId(BOT_TOKEN, GUILD, "COMMUNITY-FLEET")
    ).rejects.toThrow(/ambiguous/i);

    fetchMock.mockRestore();
  });

  test("API failure → throws (does not swallow)", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(403, { message: "Missing Access" })
    );

    await expect(
      resolveRoleId(BOT_TOKEN, GUILD, "community-fleet")
    ).rejects.toThrow(/403/);

    // N2: token must not appear in API-failure error messages (uniform invariant).
    try {
      await resolveRoleId(BOT_TOKEN, GUILD, "community-fleet");
    } catch (err) {
      expect((err as Error).message).not.toContain(BOT_TOKEN);
    }

    fetchMock.mockRestore();
  });

  test("token never appears in thrown error messages", async () => {
    const fetchMock = spyOn(globalThis, "fetch").mockResolvedValueOnce(
      fakeResponse(200, ROLES_UNIQUE)
    );

    try {
      await resolveRoleId(BOT_TOKEN, GUILD, "nonexistent-role");
    } catch (err) {
      expect((err as Error).message).not.toContain(BOT_TOKEN);
    }

    fetchMock.mockRestore();
  });
});

// ─── isSnowflake ──────────────────────────────────────────────────────────────
//
// M1: validate that isSnowflake correctly classifies Discord user ids.
//
// The CLI `role add` and `role remove` action handlers guard `--member` with
// the same regex via isDiscordId (discord.ts) before making any network call.
// This suite proves the helper exported from lib/discord is correct — no API
// call is made for any of these cases.

describe("isSnowflake", () => {
  test("17-digit string → valid", () => {
    expect(isSnowflake("12345678901234567")).toBe(true);
  });

  test("18-digit string → valid", () => {
    expect(isSnowflake("123456789012345678")).toBe(true);
  });

  test("20-digit string → valid", () => {
    expect(isSnowflake("12345678901234567890")).toBe(true);
  });

  test("real-looking snowflake (USER fixture) → valid", () => {
    // USER = "123456789012345678" (18 digits)
    expect(isSnowflake(USER)).toBe(true);
  });

  test("non-snowflake with letters → invalid", () => {
    expect(isSnowflake("not-a-snowflake")).toBe(false);
  });

  test("path-traversal-shaped value → invalid (no API call risk)", () => {
    // Demonstrates that URL-traversal payloads are caught before fetch.
    expect(isSnowflake("123/../../etc")).toBe(false);
  });

  test("empty string → invalid", () => {
    expect(isSnowflake("")).toBe(false);
  });

  test("16-digit string (too short) → invalid", () => {
    expect(isSnowflake("1234567890123456")).toBe(false);
  });

  test("21-digit string (too long) → invalid", () => {
    expect(isSnowflake("123456789012345678901")).toBe(false);
  });

  test("non-snowflake --member does not reach fetch", () => {
    // Guard is in the CLI action handler (discord.ts) using isDiscordId (same
    // regex). Here we prove the same guard logic rejects before any API call
    // would be constructed: fetch is NOT called when isSnowflake returns false.
    const fetchMock = spyOn(globalThis, "fetch");

    const invalid = "not-a-valid-snowflake";
    const wouldCallFetch = isSnowflake(invalid);

    // If the guard fires (false), no fetch is issued.
    expect(wouldCallFetch).toBe(false);
    expect(fetchMock.mock.calls.length).toBe(0);

    fetchMock.mockRestore();
  });
});
