import { expect, test } from "bun:test";
import { serveFrameProbe } from "../desk-adapter-frame/server";
import { FRAME_ATTACKS } from "../../src/surface/mc/desk/__tests__/fixtures/adapter-frame-ui";
import { DESK_ADAPTER_FRAMES_PATH, FrameOpenReplySchema, shellFrameCsp } from "../../src/surface/mc/desk/adapter-frame-contract";
import { identityOf, newInstance } from "../../src/surface/mc/desk/adapter-frame-protocol";

test("actual shell fixture and verified hostile assets build and serve on authenticated routes", async () => {
  for (const mode of ["local", "hosted"] as const) {
    const fixture = await serveFrameProbe("good", mode, "http://127.0.0.1:9");
    try {
      const shell = await fetch(fixture.server.url);
      expect(shell.headers.get("content-security-policy")).toBe(shellFrameCsp(fixture.server.url.origin));
      const cookie = shell.headers.get("set-cookie")!.split(";")[0]!;
      const headers = { cookie, "content-type": "application/json", origin: fixture.server.url.origin };
      const path = new URL(DESK_ADAPTER_FRAMES_PATH, fixture.server.url);
      if (mode === "hosted") expect((await fetch(path, { method: "POST", body: "{}" })).status).toBe(401);
      const instance = newInstance();
      const opened = await fetch(path, { method: "POST", headers, body: JSON.stringify({ mountId: fixture.rig.registered.mountId, instance }) });
      expect(opened.status).toBe(200);
      const view = FrameOpenReplySchema.parse(await opened.json());
      const entry = view.entry.files.find(file => file.path === view.entry.entry)!;
      const asset = await fetch(new URL(entry.url, fixture.server.url), { headers });
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
      expect(await asset.text()).toContain("FRAME_PROBE:");
      const identity = identityOf(view.entry, instance);
      const instanceUrl = new URL(`${DESK_ADAPTER_FRAMES_PATH}/${instance}`, fixture.server.url);
      const reply = await fetch(instanceUrl, { method: "POST", headers, body: JSON.stringify({ ...identity, seq: 1, type: "ui:ready", body: { mount: view.mount } }) });
      expect(reply.status).toBe(200);
      expect(await reply.text()).toContain("SYNTHETIC-PRIVATE-CANARY");
      const oversized = await fetch(instanceUrl, { method: "POST", headers, body: "a".repeat(65537) });
      expect(oversized.status).toBe(413);
      expect((await fetch(instanceUrl, { headers })).status).toBe(409);
      expect(fixture.rig.authority.calls.dispatch + fixture.rig.authority.calls.cancel).toBe(0);
      expect((await fetch(path, { method: "POST", headers: { ...headers, origin: "https://evil.test" }, body: "{}" })).status).toBe(403);
    } finally { await fixture.close(); }
  }
});

test("all hostile script variants remain valid inline hash-pinned entries", async () => {
  for (const attack of FRAME_ATTACKS) {
    const fixture = await serveFrameProbe(attack, "local", "http://127.0.0.1:9");
    try {
      const entry = fixture.rig.opened.entry;
      const response = await fixture.rig.assets.local(entry.files.find(file => file.path === entry.entry)!.url);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-security-policy")).toContain("script-src 'sha256-");
      expect(fixture.rig.authority.calls.dispatch).toBe(0);
    } finally { await fixture.close(); }
  }
});
