// Builds the in-sandbox browser runtime into <runtime root>/bundle/:
//   zbrowserd.cjs  — the daemon (engine + deps bundled; only `patchright` external)
//   zb.cjs         — the loopback CLI the backend invokes via executeCommand
//   setup.sh       — copied verbatim
//   manifest.json  — { version, hash, builtAt, engineUpstream }
//
// The runtime root is `sandbox-runtime/` inside snowx-api-v2 and the repo root
// in the public mirror (zinley-sandbox-browser) — identical layout, so this
// script works unchanged in both. The bundle is COMMITTED (prod runs from a git
// archive with no node_modules; sandboxes clone the mirror or receive the files
// by upload). Rebuild + commit after any change under sandbox-runtime/ or
// src/services/sandbox-browser/protocol.ts:
//   node sandbox-runtime/zbrowser/build.mjs
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
// zbrowser/ sits directly under the runtime root in both layouts.
const runtimeRoot = resolve(here, '..');
const inSnowx = existsSync(join(runtimeRoot, '..', 'src', 'services', 'sandbox-browser', 'protocol.ts'));
const repoRoot = inSnowx ? resolve(runtimeRoot, '..') : runtimeRoot;
const outDir = join(runtimeRoot, 'bundle');
const require = createRequire(import.meta.url);

function loadEsbuild() {
  try {
    return require('esbuild');
  } catch {
    // Not a direct dependency (vitest brings it into the pnpm store). Find it there.
    const store = join(repoRoot, 'node_modules', '.pnpm');
    const hit = existsSync(store) ? readdirSync(store).find(d => /^esbuild@/.test(d)) : undefined;
    if (!hit) throw new Error('esbuild not found — run `pnpm install` (vitest pulls it in) or `pnpm add -D esbuild`');
    return require(join(store, hit, 'node_modules', 'esbuild'));
  }
}

const esbuild = loadEsbuild();
const upstreamFile = join(runtimeRoot, 'browser-use-engine', 'UPSTREAM.md');
const engineUpstream = existsSync(upstreamFile) ? (readFileSync(upstreamFile, 'utf8').match(/commit:\s*([0-9a-f]{7,40})/i)?.[1] ?? 'unknown') : 'unknown';
const version = `${new Date().toISOString().slice(0, 10)}-${engineUpstream.slice(0, 7)}`;

mkdirSync(outDir, { recursive: true });

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  logLevel: 'warning',
  legalComments: 'none',
  // patchright ships its own driver + browser downloads; it is installed in
  // the sandbox by setup.sh. The rest are imported by engine modules the daemon
  // never loads (other LLM providers, cloud sync, observability, Google
  // integrations) and are absent from the standalone mirror.
  external: [
    'patchright',
    'groq-sdk',
    'ollama',
    '@google/generative-ai',
    'sharp',
    'lmnr',
    'posthog-node',
    'google-auth-library',
    'googleapis',
  ],
  define: { __ZB_VERSION__: JSON.stringify(version) },
  // The engine resolves `import … from './x.js'` to TS sources (bundler style).
  resolveExtensions: ['.ts', '.js', '.mjs', '.cjs', '.json'],
  // Vendored engine + its deps live in the desktop repo's node_modules at build time.
  nodePaths: [
    process.env.ZB_ENGINE_NODE_MODULES,
    // The engine's own deps (otpauth, gpt-tokenizer, adm-zip, …) are not deps of
    // this repo — resolve them from the desktop checkout the engine came from.
    join(repoRoot, '..', 'orion-electron', 'node_modules'),
    // Standalone mirror: `npm install` at the runtime root provides them.
    join(runtimeRoot, 'node_modules'),
    join(repoRoot, 'node_modules'),
  ].filter(p => p && existsSync(p)),
};

await esbuild.build({ ...common, entryPoints: [join(here, 'src', 'daemon.ts')], outfile: join(outDir, 'zbrowserd.cjs'), minify: false });
await esbuild.build({ ...common, entryPoints: [join(here, 'src', 'cli.ts')], outfile: join(outDir, 'zb.cjs'), minify: true });
copyFileSync(join(here, 'setup.sh'), join(outDir, 'setup.sh'));

const hash = createHash('sha256');
for (const f of ['zbrowserd.cjs', 'zb.cjs', 'setup.sh']) hash.update(readFileSync(join(outDir, f)));
const manifest = { version, hash: hash.digest('hex').slice(0, 16), builtAt: new Date().toISOString(), engineUpstream };
writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`built sandbox browser runtime → ${outDir} (${manifest.version}, hash ${manifest.hash})`);
