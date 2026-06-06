/**
 * S3 (Network Join Control Plane, #737) — nats-server infrastructure config
 * rendering. The DD-6 runtime/arc-owned leaf rendering + plist loader.
 *
 * Pure config producers consumed by S4's `cortex network join/leave`; this
 * module never touches a live `~/.config/nats/*.conf` or any daemon. Distinct
 * from `src/bus/nats/` (the runtime's NATS client connection).
 */

export {
  leafIncludeFileName,
  mergeLeafRemotes,
  renderLeafIncludeFile,
  renderLeafRemote,
} from "./leaf-remote-renderer";
export type {
  LeafRemote,
  StackLeafBinding,
} from "./leaf-remote-renderer";

export {
  ensureConfigArg,
  plistConfigArgPresent,
  renderProgramArguments,
} from "./nats-plist-loader";
