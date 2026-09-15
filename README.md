# zinley-sandbox-browser

The browser runtime that runs **inside a Zinley's Computer sandbox** (a [Daytona](https://daytona.io)
sandbox). It is the same browser-use engine the Zinley desktop app ships, packaged as a small
daemon that drives a **headful Chromium on the sandbox's virtual desktop**, so the agent can browse
on its own computer and a human can **watch and take over** the very same browser (login, 2FA,
captcha) through the sandbox's noVNC live view.

This repository is a distribution mirror: the backend clones a pinned tag of it into every sandbox
on first init and runs `install.sh`. The source of truth lives in the `sandbox-runtime/` folder of
the Zinley backend and is published here by `scripts/publish-sandbox-runtime.sh`.

## Layout

```
install.sh              first-init entrypoint (idempotent) — checks git/node, runs bundle/setup.sh
bundle/                 built artifacts the sandbox actually runs (committed)
  zbrowserd.cjs           the daemon: engine + deps bundled, patchright external
  zb.cjs                  loopback CLI the backend calls via `executeCommand`
  setup.sh                installs patchright + Chromium into the workspace
  manifest.json           { version, hash, builtAt, engineUpstream }
zbrowser/               daemon + CLI sources, build script, setup.sh
browser-use-engine/     vendored TypeScript port of browser-use (see UPSTREAM.md)
```

## How a sandbox uses it

```
git clone --depth 1 --branch <tag> https://github.com/Zinley-dev/zinley-sandbox-browser.git \
    ~/workspace/.zinley/zbrowser-src
ZB_WORKSPACE=~/workspace bash ~/workspace/.zinley/zbrowser-src/install.sh
```

`install.sh` installs `patchright` and its Chromium build under `~/workspace/.zinley/` (the only
path that survives a sandbox stop/archive/restore) and prints `[zb-install] ok <bundle dir>`.
The backend then launches `bundle/zbrowserd.cjs` on the sandbox's `DISPLAY` and talks to it with
`node bundle/zb.cjs <endpoint> '<json>'`, which prints one `ZB_JSON:` line.

The daemon listens on `127.0.0.1:7331` only. It never opens a port to the outside; the live view
is the sandbox's own noVNC, exposed through a signed, expiring Daytona preview URL.

## Runtime environment

| Variable | Meaning |
|---|---|
| `ZB_WORKSPACE` | workspace dir; profile, downloads, screenshots and deps live under `.zinley/` there |
| `DISPLAY` | X display of the sandbox desktop (set by the backend) |
| `ZB_PORT` | daemon port (default 7331) |
| `SNOWX_API_URL` | Zinley API base the engine's LLM client calls (Firebase token is passed per task) |
| `ZB_WINDOW_W` / `ZB_WINDOW_H` | browser window size |
| `ANONYMIZED_TELEMETRY` | set to `false` (the backend always does) |

No API keys are read from the sandbox. The LLM calls go through the Zinley API with a short-lived
token supplied per task.

## Building

```
npm install
npm run build        # → bundle/
```

Rebuild and commit `bundle/` after any change under `zbrowser/` or `browser-use-engine/`.

## License

MIT. `browser-use-engine/` is a TypeScript port of [browser-use](https://github.com/browser-use/browser-use)
(MIT, © Browser Use). See `LICENSE`.
