import { describe, expect, it } from "bun:test";
import { readSettingsGroup, settingsSearch, SETTINGS_GROUPS } from "../hooks/use-settings-location";

describe("Settings navigation", () => {
  it("reads every group and defaults unknown groups without opening settings on the Desk", () => {
    expect(readSettingsGroup("?desk=studio")).toBeNull();
    expect(readSettingsGroup("?settings=unknown")).toBe("calendars");
    for (const group of SETTINGS_GROUPS) expect(readSettingsGroup(settingsSearch("", group.id))).toBe(group.id);
  });
  it("preserves other router selections when opening and leaving settings", () => {
    expect(settingsSearch("?desk=studio&thread=idea", "vips")).toBe("?desk=studio&thread=idea&settings=vips");
    expect(settingsSearch("?desk=studio&settings=vips", null)).toBe("?desk=studio");
    expect(settingsSearch("?settings=vips", null)).toBe("");
  });
});
