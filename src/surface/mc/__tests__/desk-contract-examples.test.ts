import { describe, expect, it } from "bun:test";
import { McSchema } from "../../../common/types/config";
import { checkSourceOutput } from "../../../cli/cortex/commands/desk";
import { parseSourceOutput } from "../desk/sources/command";
import { commandTransport } from "../desk/transports";

const example = (name: string): Promise<string> => Bun.file(new URL(`../../../../docs/desk/examples/${name}`, import.meta.url)).text();

describe("documented Desk contracts", () => {
  it("accepts both documented source examples", async () => {
    const calendar = await example("source-calendar.json");
    const mail = await example("source-mail.json");
    expect(parseSourceOutput(calendar).events).toHaveLength(2);
    expect(parseSourceOutput(mail).mail).toHaveLength(1);
    expect(checkSourceOutput(calendar).exitCode).toBe(0);
    expect(checkSourceOutput(mail).exitCode).toBe(0);
  });

  it("names the fields that violate the contract", async () => {
    const result = checkSourceOutput(await example("source-broken.json"));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("events[0].start");
    expect(result.stderr).toContain("items[0].unread");
    expect(parseSourceOutput('{"items":false}').problems).toEqual(["items: must be an array"]);
    expect(checkSourceOutput("null").exitCode).toBe(1);
    expect(checkSourceOutput("not json").exitCode).toBe(1);
  });

  it("requires a command when the command transport is selected", () => {
    expect(McSchema.safeParse({ desk: { interruptions: { transport: "command" } } }).success).toBe(false);
    expect(McSchema.safeParse({ desk: { interruptions: { transport: "command", command: ["notify"] } } }).success).toBe(true);
  });

  it("sends JSON to a real transport command without a shell", async () => {
    const transport = commandTransport([process.execPath, "-e", 'const p = await new Response(Bun.stdin.stream()).json(); process.exit(p.key === "m1" && p.title === "Meeting" && !p.action ? 0 : 2)'], 2000);
    expect(await transport.send({ key: "m1", title: "Meeting", why: "Starts soon", action: { label: "Open", url: "javascript:alert(1)" } })).toEqual({ status: "sent" });
  });

  it("reports command failures and timeouts", async () => {
    const push = { key: "m1", title: "Meeting", why: "Starts soon" };
    const failed = commandTransport([process.execPath, "-e", 'console.error("Unavailable"); process.exit(3)'], 2000);
    expect(await failed.send(push)).toEqual({ status: "failed", error: "Unavailable" });
    const slow = commandTransport([process.execPath, "-e", "await Bun.sleep(5000)"], 50);
    expect(await slow.send(push)).toMatchObject({ status: "failed" });
  });
});
