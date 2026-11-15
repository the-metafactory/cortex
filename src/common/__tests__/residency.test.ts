import { describe, expect, test } from "bun:test";
import { type Destination, mayEnter, release, releaseRefusal, releaseToAgent, residencyOf } from "../residency";

const localConversation: Destination = { transport: "web", route: "local", policy: "local" };

describe("residency gate", () => {
  test("only the literal cloud is cloud: missing, unknown and malformed residency stays local (#3300, #3101)", () => {
    expect(residencyOf("cloud")).toBe("cloud");
    for (const value of ["local", undefined, null, "", "Cloud", "remote", ["cloud"], { policy: "cloud" }, 1]) expect(residencyOf(value)).toBe("local");
  });

  test("cloud content may enter any destination", () => {
    expect(releaseRefusal("cloud", { transport: "discord", route: "cloud:lane", policy: "cloud" })).toBeNull();
  });

  test("local content enters only a web conversation on the local model that is itself local-only", () => {
    expect(releaseRefusal("local", localConversation)).toBeNull();
    expect(releaseRefusal("local", { ...localConversation, transport: "discord" })).toBe("not-web");
    expect(releaseRefusal("local", { ...localConversation, route: "cloud" })).toBe("cloud-model");
    expect(releaseRefusal("local", { ...localConversation, route: "cloud:lane" })).toBe("cloud-model");
    expect(releaseRefusal("local", { ...localConversation, policy: "cloud" })).toBe("cloud-conversation");
  });

  test("a destination with a missing or malformed policy is not local, so local content may not enter it", () => {
    for (const policy of [undefined, null, "", "Local", "remote", ["local"]]) expect(releaseRefusal("local", { ...localConversation, policy })).toBe("cloud-conversation");
    expect(mayEnter(undefined, { transport: "web", route: "cloud", policy: "cloud" })).toBe(false);
  });

  test("release brands cleared content and refuses the rest with a reason", () => {
    const discord: Destination = { transport: "discord", route: "cloud", policy: "cloud" };
    expect(release({ text: "a", policy: "cloud" }, discord)).toEqual({ released: { text: "a", policy: "cloud" } as never });
    expect(release({ text: "a", policy: "local" }, discord)).toEqual({ refusal: "not-web" });
    expect(release({ text: "a", policy: undefined }, discord)).toEqual({ refusal: "not-web" });
  });

  test("an agent over the bus takes local content only when its own policy is the literal local (#3595)", () => {
    expect(releaseToAgent({ text: "a", policy: "local" }, "local")).toEqual({ text: "a", policy: "local" } as never);
    expect(releaseToAgent({ text: "a", policy: "cloud" }, "cloud")).toEqual({ text: "a", policy: "cloud" } as never);
    for (const agentPolicy of ["cloud", undefined, null, "", "Local", ["local"]]) expect(releaseToAgent({ text: "a", policy: "local" }, agentPolicy)).toBeNull();
    expect(releaseToAgent({ text: "a", policy: undefined }, "cloud")).toBeNull();
  });
});
