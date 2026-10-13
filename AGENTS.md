# Agent working instructions — Web Slinger

This repository is **Web Slinger** (the GitHub repository is named `spiderman-game`). Do not rename the product. Read `PLAN.md` for product requirements and scope; it wins over `README.md`. Read `docs/TEST_MATRIX.md` before claiming a milestone is done. Keep changes within the assigned issue/PR; do not merge without explicit maintainer instruction.

## Identify the execution environment

Before choosing commands, determine whether you are executing inside AndroidHarness on an Android phone or on a conventional desktop/CI host. The Android-specific workarounds below are **not** global project defaults. The full measured failure analysis and reproduction log are in [`docs/android-development.md`](docs/android-development.md).

On AndroidHarness, the verified toolchain is an **unprivileged app-uid** shell with Android-native Node, Git, and Vite. **No Shizuku, root, ADB shell, or expanded storage permission is required** for the documented workflow. Prefer the existing app-private repository checkout and HTTPS Git remote.

## AndroidHarness commands (verified on 2026-10-12/13)

Run from the repository root. Recheck after dependency/toolchain changes.

| Task | Command |
|---|---|
| Clean install | `npm ci --ignore-scripts` |
| Typecheck | `npm run typecheck` |
| Lint | `npm run lint` |
| Unit tests | `node ./node_modules/vitest/vitest.mjs run --pool=threads` |
| Production bundle | `node ./node_modules/vite/bin/vite.js build` |
| Local dev server | `npm run dev -- --host 127.0.0.1 --strictPort` |

**Run both typecheck and the direct Vite build** as separate gates: the direct build does not perform the typecheck that the normal `npm run build` script includes.

Do not assume that `npm ci` / a fresh `npm install`, `npm test`, or `npm run build` works verbatim in AndroidHarness:

- `process.execPath` resolves to Android's `linker64` in this environment. Tools that try to relaunch Node through that path fail. Vitest's default `forks` worker pool fails; `--pool=threads` passes. This does **not** mean all spawning or native binaries are broken.
- esbuild's `postinstall` fails via `process.execPath`. For the **currently verified lockfile only**, `npm ci --ignore-scripts` leaves the required Android-native esbuild/Rollup binaries functional. **Reassess this workaround if dependencies change**; never assume ignoring installation scripts is universally safe.
- The nested `npm` call in `npm run build` hits an inaccessible shim in another execution tier. Calling Vite's JS entrypoint through `node` avoids that. Avoid `timeout npm …` here for the same shim reason.
- Do not assume `/bin/bash` or SSH exists; use the available shell or explicit bash path, and HTTPS Git. `gh` commands that internally exec `git` may fail on Android; if necessary, use the existing authenticated GitHub API integration without printing tokens or adding credentials.

On a **desktop or in GitHub Actions**, use the ordinary `README.md` commands; CI should continue exercising its existing Node matrix and normal test pool.

## Local server and testing on the phone

The Vite dev server has **already been verified** to start and return HTTP 200 while serving transformed TypeScript on Android. This is a local **development asset server**, not a game backend (the product has no backend).

1. Start Vite in a persistent/background harness session with the command above. Keep the server process alive while testing; record the actual port and bind address. Do not expose `--host 0.0.0.0` or external network access without a specific reason and permission.
2. Probe it from the Android shell: `node --input-type=module -e 'const r = await fetch("http://127.0.0.1:5173/?source=mouse"); console.log(r.status); if (!r.ok) process.exit(1)'`. An HTTP 200 proves serving, **not** browser gameplay.
3. Open `http://127.0.0.1:5173/?source=mouse` in **AndroidHarness's in-app Agent Browser** (Chromium WebView), keep it **foregrounded**, and inspect actual canvas behavior. On this device the agent has verified screenshots, DOM/JS evaluation, console capture, synthetic PointerEvents and keyboard controls, as well as pixel-based changes from moving/folding/releasing the simulated hand, toggling `H`, toggling `M`, and correct right-side mirroring. Report test-specific evidence rather than treating a screenshot as proof of every interaction.
4. **Foreground caveat:** when the Agent Browser page becomes hidden (`document.hidden === true`), `requestAnimationFrame` stops and timers/navigation may stall; a screenshot can show a blank canvas while `getImageData` still reads an old frame. This is a backgrounded-WebView observation, **not automatically a game bug**. Run time-sensitive browser actions together while foregrounded. Pixel thresholds can include HUD antialiasing; check exactly what an assertion proves.
5. **Still needs manual/independent verification:** standalone Chrome on the phone (AndroidHarness could not launch it; `am start` hit exit 126), real-finger touch input, and animated motion for `?source=replay`. The replay URL loaded, but animation was not observed. Browser-generated PointerEvents do not validate hardware touch. Camera access/permission in WebView or Chrome is also not yet verified. For standalone Chrome, ask the user to open `http://127.0.0.1:5173/?source=mouse` while the server is running; do not assume browser equivalence. Tests marked `[H]` in `docs/TEST_MATRIX.md` require genuine observed device evidence.
6. Stop the dev server when finished. Never leave a network-facing process running unintentionally.

## Working discipline

- Start from the correct base and a clean tree; inspect the assigned issue, relevant code, and tests before editing.
- Prefer tiny, reviewable slices; do not mix unrelated repairs into the current PR. Preserve the scope fences and dependency/version-pin policy in `PLAN.md`.
- After code changes, run lint, typecheck, tests, and build using the commands appropriate to the environment; report each command's real exit code and any unverified human/device checks.
- Do not edit `PLAN.md`, alter CI to accommodate a local workaround, or add dependencies unless the work explicitly requires and justifies it.
- Commit and push only the intended files, open a PR for review, and **do not merge** unless explicitly requested.
