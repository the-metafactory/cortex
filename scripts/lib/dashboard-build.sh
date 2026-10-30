#!/bin/bash
# Builds the Mission Control dashboard bundle (dist/dashboard-v2) for an
# installed Cortex. dist/ is gitignored, so without this step an install or
# upgrade keeps serving whatever bundle was last built by hand, and merged
# dashboard changes (the Desk, cortex#2770) never reach the browser.
#
# Non-fatal by design: a failed build leaves the previous bundle in place and
# prints the manual command, so the daemon restart that follows still runs.

build_mc_dashboard() {
  local cortex_dir="$1"
  local bun_bin="${CORTEX_BUN:-bun}"
  if ! command -v "${bun_bin}" >/dev/null 2>&1; then
    echo "  ⚠ bun not found; Mission Control dashboard not rebuilt"
    return 0
  fi
  echo "  Building the Mission Control dashboard..."
  if (cd "${cortex_dir}" && "${bun_bin}" run build:dashboard >/dev/null 2>&1); then
    echo "  ✓ Mission Control dashboard built"
  else
    echo "  ⚠ Mission Control dashboard build failed; the previous bundle stays. Rebuild by hand: (cd ${cortex_dir} && bun run build:dashboard)"
  fi
  return 0
}
