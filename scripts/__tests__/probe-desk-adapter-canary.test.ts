import { expect, test } from "bun:test";
import { main } from "../probe-desk-adapter-canary";

test("the leaking fixture makes the CLI exit nonzero and name the render target", async () => {
  const errors: string[] = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { errors.push(args.map(String).join(" ")); };
  let code = 0;
  try { code = await main(["--leak", "log"]); }
  finally { console.error = originalError; console.log = originalLog; }
  expect(code).toBe(1);
  expect(errors.some(line => line.includes("log") && line.includes("scan named"))).toBe(true);
  expect(errors.join("\n")).not.toContain("desk-canary-");
});
