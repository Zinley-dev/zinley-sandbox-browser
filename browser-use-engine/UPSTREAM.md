# Vendored browser-use engine

Source: `orion-electron/electron/browser-use/` (TypeScript port of browser-use, driven by
patchright). Copied verbatim minus `__tests__/`, `*.test.ts`, `*.spec.ts`, `README.md`.

upstream commit: ec970e41
synced: 2026-09-14

Re-sync (from the snowx-api-v2 repo root, with orion-electron checked out beside it):

    rsync -a --delete --exclude='__tests__' --exclude='*.test.ts' --exclude='*.spec.ts' --exclude='README.md' \
      ../orion-electron/electron/browser-use/ sandbox-runtime/browser-use-engine/
    # keep this file, then update the commit line above and rebuild:
    node sandbox-runtime/zbrowser/build.mjs

Do not edit engine files here — sandbox-specific behavior (the `request_user_help` action,
disabled file actions, launch flags) lives in `sandbox-runtime/zbrowser/src/daemon.ts`.
