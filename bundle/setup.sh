#!/usr/bin/env bash
# One-time (idempotent) runtime setup INSIDE a Zinley's Computer sandbox.
#
# Installs the only non-bundled dependency of zbrowserd — patchright (the
# stealth Playwright fork the desktop app uses) plus its Chromium build — into
# the user's persistent workspace so it survives stop/archive/restore.
#
# Called two ways:
#   • by scripts/build-sandbox-snapshot.ts when baking the snapshot (fast path
#     for every new sandbox), and
#   • lazily by the backend (SandboxBrowserService.ensureRuntime) on sandboxes
#     created before the snapshot existed.
#
# Env: ZB_WORKSPACE (default ~/workspace), ZB_PATCHRIGHT_VERSION (pinned below).
set -euo pipefail

WORKSPACE="${ZB_WORKSPACE:-$HOME/workspace}"
RT="$WORKSPACE/.zinley/rt"
PATCHRIGHT_VERSION="${ZB_PATCHRIGHT_VERSION:-1.57.0}"
# Keep the browser download inside the workspace too (default is ~/.cache,
# which does NOT persist across archive → restore).
export PLAYWRIGHT_BROWSERS_PATH="$WORKSPACE/.zinley/pw-browsers"

mkdir -p "$RT" "$PLAYWRIGHT_BROWSERS_PATH" "$WORKSPACE/.zinley/browser-profile" "$WORKSPACE/.zinley/downloads"
cd "$RT"

if [ ! -f package.json ]; then
  printf '{"name":"zinley-browser-runtime","private":true,"version":"1.0.0"}\n' > package.json
fi

have_patchright() {
  node -e "const p=require('$RT/node_modules/patchright/package.json'); process.exit(p.version==='$PATCHRIGHT_VERSION'?0:1)" 2>/dev/null
}

if ! have_patchright; then
  echo "[zb-setup] installing patchright@$PATCHRIGHT_VERSION"
  npm install --no-audit --no-fund --loglevel=error "patchright@$PATCHRIGHT_VERSION"
fi

# Chromium build for this patchright version. `install` is idempotent.
if ! node -e "const {chromium}=require('$RT/node_modules/patchright'); const fs=require('fs'); process.exit(fs.existsSync(chromium.executablePath())?0:1)" 2>/dev/null; then
  echo "[zb-setup] downloading chromium for patchright"
  "$RT/node_modules/.bin/patchright" install chromium
fi

# System libraries Chromium needs. The default Daytona image ships the X11 set
# (it has xfce/xvfb); the rest is only installable with sudo. Best effort: if
# sudo is unavailable, Chromium may still run when the image already has them.
if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  if ! ldconfig -p 2>/dev/null | grep -q libnss3; then
    echo "[zb-setup] installing chromium system deps (sudo)"
    sudo -n env PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" "$RT/node_modules/.bin/patchright" install-deps chromium >/dev/null 2>&1 || \
    (sudo -n apt-get update -qq && sudo -n apt-get install -y -qq --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 \
      libxdamage1 libxrandr2 libgbm1 libasound2 libpango-1.0-0 libcairo2 libxshmfence1 fonts-liberation \
      >/dev/null 2>&1) || echo "[zb-setup] WARN: system deps install failed (continuing)"
  fi
fi

node -e "const {chromium}=require('$RT/node_modules/patchright'); console.log('[zb-setup] chromium at', chromium.executablePath())"
echo "[zb-setup] ok"
