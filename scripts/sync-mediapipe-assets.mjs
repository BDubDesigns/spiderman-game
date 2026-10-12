#!/usr/bin/env node
/**
 * Copy the MediaPipe vision WASM bundle into `public/wasm/`.
 *
 * Why a copy step instead of committing the files (PLAN.md §9):
 *
 * - The WASM bundle ships *inside* the pinned `@mediapipe/tasks-vision` package,
 *   so copying from there guarantees the WASM matches the JS exactly. A committed
 *   duplicate could silently drift from the pinned version, which is the failure
 *   §9's "version pinning is mandatory" is trying to prevent.
 * - Together the files are ~26 MB. Committing them would bloat every clone.
 * - Serving still happens from this app's own origin, which is what §9 actually
 *   requires: self-hosted, no CDN at runtime.
 *
 * Why `public/` and not a bundler import: MediaPipe assembles the WASM filenames
 * at runtime from a template literal, so Vite's static analysis can never see
 * them. They are not bundled, hashed, or copied automatically, and there is no
 * warning — a built app without this step 404s on the first inference. Verified
 * against the pinned version (see docs/M1_WORKER_DECISION.md).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJsonPath = join(
  repoRoot,
  'node_modules',
  '@mediapipe',
  'tasks-vision',
  'package.json',
);

/**
 * The files the runtime can request from `FilesetResolver.forVisionTasks(basePath)`
 * called without `useModule`. The loader builds its path as
 * `vision_wasm${useModule ? '_module' : ''}${simd ? '' : '_nosimd'}_internal.{js,wasm}`,
 * so the SIMD and non-SIMD pairs cover every browser we support. The `_module_`
 * pair is only requested when `useModule` is true, which this project never does.
 */
const WASM_FILES = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

function fail(message) {
  console.error(`[assets] ${message}`);
  process.exit(1);
}

if (!existsSync(packageJsonPath)) {
  fail(
    '@mediapipe/tasks-vision is not installed. Run `npm install` before building or starting the dev server.',
  );
}

const version = JSON.parse(readFileSync(packageJsonPath, 'utf8')).version;
const sourceDir = join(dirname(packageJsonPath), 'wasm');
const targetDir = join(repoRoot, 'public', 'wasm');

if (!existsSync(sourceDir)) {
  fail(
    `the installed @mediapipe/tasks-vision has no wasm/ directory at ${sourceDir}. ` +
      'The package layout changed; check the pinned version before continuing.',
  );
}

mkdirSync(targetDir, { recursive: true });

let copied = 0;
for (const name of WASM_FILES) {
  const from = join(sourceDir, name);
  const to = join(targetDir, name);
  if (!existsSync(from)) {
    fail(
      `expected ${name} in the installed package but it is missing. ` +
        'The pinned version no longer ships the assets this project expects.',
    );
  }
  // Skip identical files so `npm run dev` stays fast on a warm tree.
  if (existsSync(to) && statSync(to).size === statSync(from).size) {
    continue;
  }
  copyFileSync(from, to);
  copied += 1;
}

console.log(
  `[assets] MediaPipe vision WASM v${version}: ${WASM_FILES.length} files present in public/wasm/` +
    (copied > 0 ? ` (${copied} copied)` : ' (already up to date)'),
);

/**
 * The `.task` model is NOT part of the npm package, so it is committed to this
 * repository instead (7.46 MB, fetched once, never churned). If it is missing,
 * warn rather than fail: the app itself degrades to the simulator, and a build
 * should not be blocked by an asset that only the camera path needs.
 */
const modelPath = join(repoRoot, 'public', 'models', 'hand_landmarker.task');
if (!existsSync(modelPath)) {
  console.warn(
    '[assets] WARNING: public/models/hand_landmarker.task is missing, so the camera source cannot start.',
  );
  console.warn('[assets]   Restore it with: npm run assets:model');
  console.warn('[assets]   Until then the app offers the mouse/touch simulator.');
}
