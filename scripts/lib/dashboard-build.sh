#!/bin/bash
# Builds the Mission Control dashboard bundle (dist/dashboard-v2) for an
# installed Cortex. dist/ is gitignored, so without this step an install or
# upgrade keeps serving whatever bundle was last built by hand, and merged
# dashboard changes (the Desk, cortex#2770) never reach the browser.
#
# Non-fatal by design: on failure it prints the build's last lines and the
# manual command, and the daemon reload that follows still runs.

build_mc_dashboard() {
  local cortex_dir="$1"
  local bun_bin="${CORTEX_BUN:-$(command -v bun || echo "${HOME}/.bun/bin/bun")}"
  if ! command -v "${bun_bin}" >/dev/null 2>&1; then
    echo "  ⚠ bun not found (looked on PATH and in ~/.bun/bin); the Mission Control dashboard was NOT rebuilt and may be stale."
    echo "    Rebuild by hand: (cd ${cortex_dir} && bun run build:dashboard)"
    return 0
  fi
  echo "  Building the Mission Control dashboard..."
  local output
  if output="$(cd "${cortex_dir}" && "${bun_bin}" run build:dashboard 2>&1)"; then
    echo "  ✓ Mission Control dashboard built"
  else
    echo "  ⚠ Mission Control dashboard build failed; the dashboard may be stale or incomplete. Last lines:"
    printf '%s\n' "${output}" | tail -n 20 | sed 's/^/      /'
    echo "    Rebuild by hand: (cd ${cortex_dir} && bun run build:dashboard)"
  fi
  return 0
}
