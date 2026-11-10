import { rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";

export function specs(reference: (adapterId: string, objectType: string, title?: string) => unknown, text: Record<string, unknown>, reading: any): any[] {
  const prop = (adapterId: string, label: string, overrides: Record<string, unknown> = {}) => ({
    dir: adapterId.split(".")[1], adapterId, label, objectType: "prop", objectLabel: "prop",
    properties: { title: { ...text, title: "Title" } }, required: ["title"], textFields: ["title"], displayTitle: "/title",
    seed: [{ id: "p1", title: `Prop from ${label}` }], ...overrides,
  });
  return [
    {
      dir: "workshop", adapterId: "sample.workshop", label: "Workshop", objectType: "repair", objectLabel: "repair",
      properties: { fault: { ...text, title: "Fault" }, detail: { type: "string", title: "Detail" }, bench: reference("sample.workshop", "bench", "Bench"), severity: { type: "string", enum: ["low", "medium", "high"], title: "Severity" }, neededBy: { type: "string", format: "date", title: "Needed by" }, hours: { type: "number", title: "Hours" }, parts: { type: "array", items: { type: "string" }, title: "Parts" } },
      required: ["fault", "bench"],
      hints: [{ pointer: "/fault", role: "title" }, { pointer: "/detail", role: "summary", widget: "long" }, { pointer: "/bench", role: "destination" }],
      destination: { field: "bench", type: "bench", label: "bench", places: [{ id: "bench-1", name: "Bench 1" }, { id: "bench-2", name: "Bench 2" }] },
      textFields: ["fault", "detail"], displayTitle: "/fault", displaySummary: "/detail", attention: { title: "/fault", why: "/detail", due: "/neededBy" },
      seed: [{ id: "r1", place: "bench-1", fault: "Bench grinder overheats", detail: "Runs hot after ten minutes.", severity: "medium", neededBy: "in-days:2", hours: 1.5, parts: ["bearing"] }],
      extraObservation: { type: "part", label: "part", properties: { name: { ...text, title: "Name" }, inStock: { type: "boolean", title: "In stock" } }, seed: [{ id: "s1", name: "Spare bearing", inStock: true }] },
      action: true, ui: "workshop-view.js",
    },
    {
      dir: "tide-tables", adapterId: "sample.tides", label: "Tide tables", objectType: "tide", objectLabel: "tide",
      properties: { name: { ...text, title: "Name" }, note: { type: "string", title: "Note" }, heightMetres: { type: "number", title: "Height" } }, required: ["name"],
      textFields: ["name", "note"], displayTitle: "/name", displaySummary: "/note", attention: { title: "/name", why: "/note" },
      seed: [{ id: "t1", name: "Spring tide at the harbour", note: "Highest water of the month this evening.", heightMetres: 4.2 }, { id: "t2", name: "Neap tide next week", note: "Unremarkable.", heightMetres: 1.1 }],
    },
    {
      dir: "routing", adapterId: "sample.routing", label: "Routing", objectType: "route", objectLabel: "route",
      properties: { name: { ...text, title: "Name" }, stops: { title: "Stops", oneOf: [{ type: "array", items: { type: "string" } }, { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false }] } }, required: ["name", "stops"],
      hints: [{ pointer: "/name", role: "title" }], textFields: ["name"], displayTitle: "/name", seed: [{ id: "o1", name: "Morning loop", stops: ["depot", "harbour"] }], action: true,
    },
    { ...prop("sample.brokendigest", "Tampered package"), dir: "broken-digest", mutate: (manifest: any) => { manifest.backend.sha256 = "0".repeat(64); } },
    { ...prop("sample.brokenformat", "Future format package"), dir: "broken-format", mutate: (manifest: any) => { manifest.format = "desk-adapter-package/2"; } },
    { ...prop("sample.brokensymlink", "Escaping package"), dir: "broken-symlink" },
    { ...reading, dir: "duplicate-identity", packageId: "sample/duplicate-identity" },
    { ...prop("sample.brokenthrows", "Throwing package"), dir: "broken-throws", backendSuffix: 'throw new Error("Module failure while loading.");' },
    { ...prop("sample.brokenmismatch", "Mismatched package"), dir: "broken-mismatch", lieAboutDeclaration: true },
    { ...prop("sample.crash", "Crashing view"), dir: "crashing-view", ui: "crashing-view.js" },
    { ...prop("sample.hostile", "Hostile view"), dir: "hostile-view", ui: "hostile-view.js" },
  ];
}

export function finish(out: string): void {
  const backend = join(out, "broken-symlink/backend.mjs");
  rmSync(backend);
  symlinkSync("../reading-list/backend.mjs", backend);
}
