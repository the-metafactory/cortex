/**
 * cortex#1792 (S6) — imports cleanly but its default export is missing the
 * required `RendererPlugin` members (`configSchema`, `createRenderer`).
 * Proves the loader's runtime shape-validation stage refuses a malformed
 * default export even though the manifest and the import both succeeded.
 */
const notActuallyAPlugin = {
  kind: "renderer",
  id: "bad-shape",
  rendererKind: "bad-shape",
  // Deliberately missing `configSchema` and `createRenderer`.
};

export default notActuallyAPlugin;
