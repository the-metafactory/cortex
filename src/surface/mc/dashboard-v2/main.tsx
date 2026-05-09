/**
 * Grove Mission Control v2 — React app entry.
 *
 * MIG-1 scaffold per `docs/design-mc-dashboard-react-migration.md`. Mounts
 * the App into `<div id="root">` declared by the static shell HTML. CSS
 * tokens + global styles are loaded by the shell, not imported here, so
 * an unstyled boot doesn't flash white.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

const container = document.getElementById("root");
if (!container) {
  throw new Error("dashboard-v2 boot: <div id=\"root\"> missing from shell HTML");
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
