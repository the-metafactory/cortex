import { describe, expect, it } from "bun:test";
import { isBriefingRequest } from "../desk/present";
import { sectionKey } from "../desk/studio/format";

describe("briefing request with the assistant name", () => {
  it("accepts the configured name", () => {
    expect(isBriefingRequest("hey Nova, what needs me?", "Nova")).toBe(true);
  });
  it("keeps ivy as an alias", () => {
    expect(isBriefingRequest("hey ivy, what needs me?", "Nova")).toBe(true);
  });
  it("matches regex characters in the name literally", () => {
    expect(isBriefingRequest("hey A.I., what needs me?", "A.I.")).toBe(true);
    expect(isBriefingRequest("hey AxIx, what needs me?", "A.I.")).toBe(false);
  });
  it("refuses another name", () => {
    expect(isBriefingRequest("hey Bob, what needs me?", "Nova")).toBe(false);
  });
});

describe("notes heading with the assistant name", () => {
  it.each(["Nova's notes", "Nova’s notes", "Assistant's notes", "Ivy's notes", "Ivy’s notes"])("maps %s to notes", (heading) => {
    expect(sectionKey(heading, "Nova")).toBe("notes");
  });
  it("does not read another name as notes", () => {
    expect(sectionKey("Bob's notes", "Nova")).toBeUndefined();
  });
});
