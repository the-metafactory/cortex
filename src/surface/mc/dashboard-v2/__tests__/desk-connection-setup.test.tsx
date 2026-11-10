import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionSetupBody } from "../components/desk-connection-setup";
import { disableConnection, enableConnection, requestSetup, saveConnection, type ConnectionView, type PackageForm, type SetupFetch } from "../lib/desk-connection-setup";

const ref = { adapterId: "example-package", connectionId: "example-connection", objectType: "area", canonicalId: "area-example" };
const form: PackageForm = {
  packageId: "example-package", label: "Example", authKind: "token", slots: [{ slot: "primary", kind: "token" }],
  scopeFields: [{ name: "account", label: "Account" }],
  capabilities: [{ capabilityId: "example.read", label: "Read objects", access: "read" }, { capabilityId: "example.create", label: "Create objects", access: "write" }],
  destinations: [{ ref, label: "Example area" }], references: ["EXAMPLE_API_KEY"],
};
const connection = (state: ConnectionView["state"], extra: Partial<ConnectionView> = {}): ConnectionView => ({ connectionId: "c1", packageId: "example-package", state, revision: 3, scope: { account: "a" }, readCapabilityIds: [], writeCapabilityIds: [], readDestinations: [], writeDestinations: [], slots: [], publishedRevision: null, ...extra });
const render = (connections: ConnectionView[], packages: PackageForm[] = [form]) => renderToStaticMarkup(<ConnectionSetupBody snapshot={{ ok: true, packages, connections }} note={null} busy={false} apply={async () => {}} />);

describe("connection setup form", () => {
  it("renders a host-owned typed form with separate read and write choices and password-only credential entry", () => {
    const html = render([]);
    expect(html).toContain('aria-label="Read access"');
    expect(html).toContain('aria-label="Write access"');
    expect(html).toContain("Read from: Example area");
    expect(html).toContain("Write to: Example area");
    expect(html).toContain('type="password"');
    expect(html).toContain("EXAMPLE_API_KEY");
    expect(html).not.toContain("checked");
  });

  it("shows each connection state with the one action that applies", () => {
    expect(render([connection("disabled")])).toContain("Enable");
    expect(render([connection("enabled")])).toContain("Disable");
    expect(render([connection("incomplete", { reason: "store_unavailable", slots: [{ slot: "primary", presence: "missing" }] })])).toContain("Retry setup");
    const gone = render([connection("unavailable", { reason: "package_missing" })], []);
    expect(gone).toContain("The package is not installed. Your saved setup is kept.");
    expect(gone).not.toContain(">Enable<");
  });

  it("states an unavailable sign-in mechanism and disables saving", () => {
    const html = render([], [{ ...form, unavailableReason: "oauth_broker_unavailable" }]);
    expect(html).toContain("Sign-in through a provider is not available on this stack.");
    expect(html).toContain("disabled");
  });
});

describe("connection setup requests", () => {
  it("sends credentials only in the body of a same-origin POST and never in the URL", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher: SetupFetch = async (url, init) => { seen.push({ url, init }); return Response.json({ ok: true, connection: connection("disabled") }); };
    await saveConnection({ packageId: "example-package", scope: { account: "a" }, readCapabilityIds: [], writeCapabilityIds: [], readDestinations: [], writeDestinations: [], inputs: { primary: { token: "synthetic-value" } } }, fetcher);
    await enableConnection("c1", 3, fetcher);
    await disableConnection("c1", 4, fetcher);
    expect(seen.every(item => !item.url.includes("synthetic-value") && item.init.credentials === "same-origin" && item.init.cache === "no-store")).toBe(true);
    expect(seen.map(item => item.url)).toEqual(["/api/desk/connections", "/api/desk/connections/c1/enable", "/api/desk/connections/c1/disable"]);
  });

  it("surfaces a refusal and an unreachable gateway as an error, never a weaker path", async () => {
    const refused: SetupFetch = async () => Response.json({ ok: false, error: "Only this stack's principal can set up its connections." }, { status: 403 });
    expect(await requestSetup(refused)).toEqual({ ok: false, error: "Only this stack's principal can set up its connections." });
    const down: SetupFetch = async () => { throw new Error("gateway unreachable"); };
    const result = await requestSetup(down);
    expect(result.ok).toBe(false);
  });
});
