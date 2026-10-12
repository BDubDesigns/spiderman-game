#!/usr/bin/env node
/**
 * Fetch the hand landmark model into `public/models/`.
 *
 * The model is not published on npm, so it cannot come from the pinned package
 * the way the WASM bundle does. It is committed to this repository so a fresh
 * clone runs without a network fetch; this script exists to restore it if it is
 * ever deleted, and to re-verify its integrity.
 *
 * The checksum below is not decorative. It is Google's own published ETag for
 * this object (`15318430ea3851670fe9914116a9cfad`), and it independently matches
 * the SHA-verified bytes of the file committed here. If the upstream file ever
 * changes, this script fails loudly instead of silently running different model
 * weights than the ones this code was written against.
 *
 * Usage: npm run assets:model
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

/** Google's published ETag for this object, i.e. its MD5. */
const EXPECTED_MD5 = '15318430ea3851670fe9914116a9cfad';

/** Pinned model revision, per the `/float16/1/` path segment. */
const EXPECTED_BYTES = 7_819_105;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targetPath = join(repoRoot, 'public', 'models', 'hand_landmarker.task');

function md5(buffer) {
  return createHash('md5').update(buffer).digest('hex');
}

async function main() {
  console.log(`[model] fetching ${MODEL_URL}`);

  let response;
  try {
    response = await fetch(MODEL_URL);
  } catch (error) {
    console.error(`[model] network request failed: ${error.message}`);
    console.error('[model] The camera source needs this file. Without it the app');
    console.error('[model] falls back to the mouse/touch simulator.');
    process.exit(1);
  }

  if (!response.ok) {
    console.error(`[model] unexpected HTTP ${response.status} ${response.statusText}`);
    process.exit(1);
  }

  const buffer = Buffer.from(await response.arrayBuffer());

  if (buffer.byteLength !== EXPECTED_BYTES) {
    console.error(
      `[model] size mismatch: expected ${EXPECTED_BYTES} bytes, received ${buffer.byteLength}.`,
    );
    process.exit(1);
  }

  const digest = md5(buffer);
  if (digest !== EXPECTED_MD5) {
    console.error('[model] checksum mismatch — refusing to write a file that does not');
    console.error('[model] match the revision this code targets.');
    console.error(`[model]   expected md5 ${EXPECTED_MD5}`);
    console.error(`[model]   received md5 ${digest}`);
    process.exit(1);
  }

  mkdirSync(dirname(targetPath), { recursive: true });
  writeFileSync(targetPath, buffer);
  console.log(`[model] wrote ${targetPath}`);
  console.log(`[model] ${buffer.byteLength} bytes, md5 ${digest} (verified)`);
}

/** Re-verify the committed file without touching the network. */
function verifyOnly() {
  const buffer = readFileSync(targetPath);
  const digest = md5(buffer);
  const ok = digest === EXPECTED_MD5 && buffer.byteLength === EXPECTED_BYTES;
  console.log(
    `[model] ${targetPath}: ${buffer.byteLength} bytes, md5 ${digest} — ${ok ? 'verified' : 'MISMATCH'}`,
  );
  if (!ok) process.exit(1);
}

if (process.argv.includes('--verify-only')) {
  verifyOnly();
} else {
  await main();
}
