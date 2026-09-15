#!/usr/bin/env bash
# First-init entrypoint INSIDE a Zinley's Computer sandbox.
#
# The backend (or the snapshot bake) clones this repo to
#   $ZB_WORKSPACE/.zinley/zbrowser-src
# and runs this script once. It is idempotent: re-running on a provisioned
# sandbox is a fast no-op. Everything it installs lives under the workspace so
# it survives stop / archive / restore.
#
#   ZB_WORKSPACE   workspace dir (default ~/workspace)
#
# Prints exactly one `[zb-install] ok <bundle dir>` line on success.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE="${ZB_WORKSPACE:-$HOME/workspace}"
export ZB_WORKSPACE="$WORKSPACE"

fail() {
  echo "[zb-install] FAIL: $*" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is not installed on this image"
command -v node >/dev/null 2>&1 || fail "node is not installed on this image"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || fail "node >= 20 required (found $(node -v))"
command -v npm >/dev/null 2>&1 || fail "npm is not installed on this image"

[ -f "$HERE/bundle/zbrowserd.cjs" ] && [ -f "$HERE/bundle/zb.cjs" ] && [ -f "$HERE/bundle/setup.sh" ] \
  || fail "bundle/ is missing — this checkout is incomplete (expected zbrowserd.cjs, zb.cjs, setup.sh)"

mkdir -p "$WORKSPACE/.zinley"
# patchright + Chromium into the workspace (idempotent; 1–4 min the first time).
bash "$HERE/bundle/setup.sh"

echo "[zb-install] ok $HERE/bundle"
