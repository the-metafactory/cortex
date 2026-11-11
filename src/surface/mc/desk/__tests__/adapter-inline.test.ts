import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256Bytes } from "../../../../common/registry/arc-package-inventory";
import { ASSET_CONNECTION, ASSET_OTHER, ASSET_OWNER, INLINE_ENTRY, enabledConnection, entryUrl, inlineUiFixture, openAssetRig, type AssetRig, type AssetUiFixture } from "./fixtures/adapter-asset-fixtures";

const rigs: AssetRig[] = [];
afterEach(async () => { for (const rig of rigs.splice(0)) await rig.close(); });
const open = async (ui = inlineUiFixture()): Promise<{ rig: AssetRig; url: string }> => {
  const rig = await openAssetRig({ ui });
  rigs.push(rig);
  return { rig, url: await entryUrl(rig) };
};
const digest = (text: string): string => `'sha256-${createHash("sha256").update(text).digest("base64")}'`;
const expectedCsp = (scripts: string[], styles: string[]): string => `default-src 'none'; script-src ${scripts.map(digest).join(" ") || "'none'"}; style-src ${styles.map(digest).join(" ") || "'none'"}; img-src data:; font-src data:; media-src 'none'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts`;
const uri = (ui: AssetUiFixture, path: string): string => {
  const file = ui.files[path];
  if (!file) throw new Error("Missing fixture asset");
  return `data:${file.mediaType};base64,${Buffer.from(file.body).toString("base64")}`;
};

describe("inline adapter entry route", () => {
  test("inlines classic scripts, styles, images and entry-relative CSS URLs identically locally and hosted", async () => {
    const ui = inlineUiFixture(INLINE_ENTRY.replace('</body>', '<script type="text/javascript" src="second.js"></script><a href="#styled">Jump</a></body>'));
    ui.files["ui/second.js"] = { body: 'document.title = "second";', mediaType: "text/javascript" };
    const { rig, url } = await open(ui);
    const script = String(ui.files["ui/app.js"]?.body);
    const second = String(ui.files["ui/second.js"]?.body);
    const css = `#styled { color: rgb(12, 34, 56); background-image: url("${uri(ui, "ui/picture.svg")}"); }`;
    const expected = String(ui.files[ui.entry]?.body)
      .replace('<link rel="stylesheet" href="styles/main.css">', `<style>${css}</style>`)
      .replace('src="picture.svg"', `src="${uri(ui, "ui/picture.svg")}"`)
      .replace('<script src="app.js"></script>', `<script>${script}</script>`)
      .replace('<script type="text/javascript" src="second.js"></script>', `<script type="text/javascript">${second}</script>`);
    for (const mode of ["local", "hosted"] as const) {
      const response = await rig[mode](url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(expected);
      expect(response.headers.get("content-security-policy")).toBe(expectedCsp([script, second], [css]));
      expect(response.headers.get("etag")).toBe(`"${sha256Bytes(expected)}"`);
      expect(response.headers.get("content-length")).toBe(String(Buffer.byteLength(expected)));
      expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      expect((await rig[mode](url, { headers: { "if-none-match": `"${sha256Bytes(expected)}"` } })).status).toBe(304);
      const head = await rig[mode](url, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("etag")).toBe(`"${sha256Bytes(expected)}"`);
      expect(await head.text()).toBe("");
    }
  });

  test("an entry without scripts or styles pins none", async () => {
    const { rig, url } = await open(inlineUiFixture('<p>Static</p>'));
    const response = await rig.local(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toBe(expectedCsp([], []));
  });

  test("preserves stylesheet media while hashing only its exact text", async () => {
    const ui = inlineUiFixture('<link rel="stylesheet" href="styles/main.css" type="text/css" media="screen and (min-width: 1px)">');
    ui.files["ui/styles/main.css"] = { body: 'p { color: green; }', mediaType: "text/css" };
    const { rig, url } = await open(ui);
    for (const mode of ["local", "hosted"] as const) {
      const response = await rig[mode](url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<style media="screen and (min-width: 1px)">p { color: green; }</style>');
      expect(response.headers.get("content-security-policy")).toBe(expectedCsp([], ['p { color: green; }']));
    }
  });

  test("escapes stylesheet media without introducing HTML attributes or elements", async () => {
    const { rig, url } = await open(inlineUiFixture('<link rel="stylesheet" href="styles/main.css" media="&quot;&gt;&lt;img src=missing&gt;&amp;">'));
    const response = await rig.local(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toStartWith('<style media="&quot;&gt;&lt;img src=missing&gt;&amp;">');
  });

  test("hashes normalized UTF-8 text and deduplicates identical script hashes", async () => {
    const ui = inlineUiFixture('<script src="app.js"></script><script src="./app.js"></script>');
    ui.files["ui/app.js"] = { body: 'document.title = "\u00e9";\r\n', mediaType: "text/javascript" };
    const { rig, url } = await open(ui);
    const response = await rig.local(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<script>document.title = "\u00e9";\n</script><script>document.title = "\u00e9";\n</script>');
    expect(response.headers.get("content-security-policy")).toBe(expectedCsp(['document.title = "\u00e9";\n'], []));
  });

  test("resolves parent segments and URL-encoded filenames only to listed paths", async () => {
    const ui = inlineUiFixture('<img src="../shared/my%20image.svg">');
    ui.files["shared/my image.svg"] = { body: String(ui.files["ui/picture.svg"]?.body), mediaType: "image/svg+xml" };
    const { rig, url } = await open(ui);
    const response = await rig.local(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(`<img src="${uri(ui, "shared/my image.svg")}">`);
  });

  test("CSS quoted and unquoted URLs use manifest media types, while comments and strings stay literal", async () => {
    const ui = inlineUiFixture();
    ui.files["ui/styles/main.css"] = { body: '/* url(remote) @import */ .a { content: "url(literal)"; background: URL( picture.svg ); mask: url(\'./picture.svg\'); } @font-face { font-family: test; src: url(font.woff2); }', mediaType: "text/css" };
    ui.files["ui/font.woff2"] = { body: new Uint8Array([0, 1, 255]), mediaType: "font/woff2" };
    const { rig, url } = await open(ui);
    const response = await rig.local(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('/* url(remote) @import */');
    expect(html).toContain('content: "url(literal)"');
    expect(html).toContain(`background: url("${uri(ui, "ui/picture.svg")}")`);
    expect(html).toContain(`src: url("data:font/woff2;base64,AAH/")`);
  });

  test("inlines CSS-escaped URL names and paths without changing other strings", async () => {
    const ui = inlineUiFixture();
    ui.files["ui/styles/main.css"] = { body: '.a { content: "escaped \\"quote\\""; background: u\\72l("pic\\74ure.svg"); }', mediaType: "text/css" };
    const { rig, url } = await open(ui);
    const response = await rig.local(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`<style>.a { content: "escaped \\"quote\\""; background: url("${uri(ui, "ui/picture.svg")}"); }</style>`);
  });

  const rejectedEntries = [
    '<script src="missing.js"></script>', '<script src="/app.js"></script>',
    '<script src="//example.test/app.js"></script>', '<script src="https://example.test/app.js"></script>',
    '<script src="data:text/javascript,void(0)"></script>', '<script type="module" src="app.js"></script>',
    '<script type="module"></script>', '<script type="mod&#117;le"></script>', '<script>void(0)</script>', '<script src="app.js"> </script>',
    '<script defer src="app.js"></script>', '<script async src="app.js"></script>', '<script nomodule src="app.js"></script>',
    '<script DeFeR="false" src="app.js"></script>', '<script ASYNC="false" src="app.js"></script>', '<script NOMODULE="false" src="app.js"></script>',
    '<link rel="alternate stylesheet" href="styles/main.css">', '<link rel="STYLESHEET Alternate" href="styles/main.css">',
    '<link rel="stylesheet" href="styles/main.css" disabled>', '<link rel="stylesheet" href="styles/main.css" title="Preferred">',
    '<link rel="stylesheet" href="styles/main.css" type="text/plain">',
    '<style>p { color: red }</style>', '<div style="color:red"></div>', '<img src="picture.svg" onload="void(0)">',
    '<div ONCLICK="void(0)"></div>', '<a href="app.js">Link</a>', '<iframe src="app.html"></iframe>',
    '<img srcset="picture.svg 1x">', '<video poster="picture.svg"></video>', '<object data="picture.svg"></object>',
    '<img srcset="#local 1x, https://example.test/picture.svg 2x">',
    '<form action="app.html"></form>', '<link rel="preload" href="app.js">', '<link rel="stylesheet" href="missing.css">',
    '<img src="data:image/png;base64,AA==">', '<img src="https://example.test/image.png">', '<img src="/picture.svg">',
    '<script type="application/json" src="app.js"></script>', '<img src="%2Fpicture.svg">',
    '<img src="../../outside.svg">', '<svg><use xlink:href="picture.svg"></use></svg>',
    '<iframe srcdoc="hello"></iframe>', '<meta http-equiv="refresh" content="0;url=https://example.test">',
    '<meta http-equiv="ref&#114;esh" content="0;url=https://example.test">',
  ];
  for (const html of rejectedEntries) test(`rejects ${html}`, async () => {
    const { rig, url } = await open(inlineUiFixture(html));
    for (const mode of ["local", "hosted"] as const) {
      const response = await rig[mode](url);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "ui_not_inlinable" });
    }
  });

  for (const css of [
    '@import "other.css";', '@IMPORT url("picture.svg");',
    '.a { background: url(https://example.test/a); }', '.a { background: url(/picture.svg); }',
    '.a { background: url(//example.test/a); }', '.a { background: url(data:image/png;base64,AA==); }',
    '.a { background: url(missing.png); }', '@\\69mport "other.css";', '</style><script>void(0)</script>',
  ]) {
    test(`rejects stylesheet ${css}`, async () => {
      const ui = inlineUiFixture();
      ui.files["ui/styles/main.css"] = { body: css, mediaType: "text/css" };
      const { rig, url } = await open(ui);
      const response = await rig.local(url);
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ code: "ui_not_inlinable" });
    });
  }

  for (const path of ["ui/app.html", "ui/app.js", "ui/styles/main.css", "ui/picture.svg"]) test(`tampered ${path} cannot contribute to a document`, async () => {
    const { rig, url } = await open();
    writeFileSync(join(rig.packageDir, path), "tampered");
    for (const mode of ["local", "hosted"] as const) {
      const response = await rig[mode](url);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "asset_unavailable" });
    }
  });

  test("entry authorization, release and generation checks precede inlining", async () => {
    const { rig, url } = await open(inlineUiFixture('<script>bad</script>'));
    expect((await rig.hosted(url, { principal: null })).status).toBe(401);
    rig.connections.set(ASSET_OTHER, [enabledConnection("foreign")]);
    expect((await rig.hosted(url, { principal: ASSET_OTHER })).status).toBe(403);
    expect((await rig.local(url.replace(ASSET_CONNECTION, "foreign"))).status).toBe(403);
    rig.connections.set(ASSET_OWNER, [{ ...enabledConnection(), state: "disabled" }]);
    expect((await rig.local(url)).status).toBe(403);
    rig.connections.set(ASSET_OWNER, [enabledConnection()]);
    rig.writePackage({ packageVersion: "1.0.1" });
    expect((await rig.loader.activate(rig.packageId)).ok).toBe(true);
    const stale = await rig.local(url);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "generation_mismatch", recovery: "refresh" });
  });
});
