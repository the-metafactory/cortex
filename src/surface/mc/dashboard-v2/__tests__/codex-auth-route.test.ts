import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

describe("the browser's Codex sign-in client", () => {
  it("calls the route the API serves", () => {
    const source = readFileSync(new URL("../lib/codex-auth.ts", import.meta.url), "utf8");
    expect(source).toContain(`const BASE = "/api/conversations/codex-auth";`);
  });
});
