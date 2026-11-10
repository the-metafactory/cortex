export type Family = "control" | "dom" | "egress" | "worker" | "navigation" | "window" | "message";
export const ATTACKS: [string, Family][] = [
  ["benign-result", "control"], ["benign-editor", "control"], ["legit-assets", "control"],
  ["parent-dom-read", "dom"], ["parent-dom-write", "dom"], ["top-dom-read", "dom"], ["parent-location-read", "dom"],
  ["storage-local", "dom"], ["storage-session", "dom"], ["storage-cookie", "dom"], ["storage-indexeddb", "dom"], ["storage-cache", "dom"],
  ["fetch-remote", "egress"], ["fetch-host-api", "egress"], ["xhr-remote", "egress"], ["websocket-remote", "egress"], ["eventsource-remote", "egress"], ["beacon-remote", "egress"],
  ["image-remote", "egress"], ["image-host-api", "egress"], ["image-gateway-redirect", "egress"], ["style-remote", "egress"], ["style-attr-beacon", "egress"], ["css-import", "egress"], ["font-remote", "egress"],
  ["prefetch", "egress"], ["preconnect", "egress"], ["media-remote", "egress"], ["object-remote", "egress"], ["nested-frame", "egress"], ["script-remote", "egress"], ["import-remote", "egress"], ["anchor-ping", "egress"], ["webrtc-stun", "egress"],
  ["worker-same", "worker"], ["worker-blob", "worker"], ["worker-data", "worker"], ["shared-worker", "worker"], ["service-worker", "worker"],
  ["nav-before-load", "navigation"], ["nav-remote", "navigation"], ["nav-data", "navigation"], ["nav-blob", "navigation"], ["nav-javascript", "navigation"], ["nav-redirect", "navigation"], ["nav-gateway-redirect", "navigation"],
  ["nav-same-generation", "navigation"], ["nav-host-page", "navigation"], ["meta-refresh", "navigation"], ["anchor-click", "navigation"],
  ["top-nav", "window"], ["top-nav-link", "window"], ["popup", "window"], ["popup-link", "window"], ["form-post", "window"], ["form-top", "window"], ["download-asset", "window"], ["download-blob", "window"],
  ["msg-ambient-parent", "message"], ["msg-ambient-top", "message"], ["msg-second-port", "message"], ["msg-unknown-type", "message"], ["msg-extra-field", "message"], ["msg-extra-envelope", "message"],
  ["msg-wrong-instance", "message"], ["msg-wrong-release", "message"], ["msg-wrong-generation", "message"], ["msg-wrong-connection", "message"], ["msg-wrong-version", "message"],
  ["msg-replay", "message"], ["msg-oversized", "message"], ["msg-malformed", "message"], ["msg-non-plain", "message"], ["msg-proto-key", "message"], ["msg-before-ready", "message"],
  ["msg-editor-only", "message"], ["msg-cross-connection", "message"], ["msg-after-close", "message"],
];
