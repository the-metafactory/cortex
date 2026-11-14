import { describe, expect, test } from "bun:test";
import { type Destination, mayEnter, release, releaseRefusal, residencyOf } from "../residency";

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

  test("a destination with a missing or malformed policy counts as local, so it may receive local content but never makes it cloud", () => {
    expect(mayEnter("local", { ...localConversation, policy: undefined })).toBe(true);
    expect(mayEnter(undefined, { transport: "web", route: "cloud", policy: "cloud" })).toBe(false);
  });

  test("release brands cleared content and refuses the rest with a reason", () => {
    expect(release({ text: "a" }, "cloud", { transport: "discord", route: "cloud", policy: "cloud" })).toEqual({ released: { text: "a" } as never });
    expect(release({ text: "a" }, "local", { transport: "discord", route: "cloud", policy: "cloud" })).toEqual({ refusal: "not-web" });
  });
});
