# Android on-device development

This project can be developed, tested and built entirely on an Android phone,
with no desktop and no backend. This document records the setup that was
actually used, the commands that actually worked, the commands that failed, and
the measured cause of each failure.

It is a measurement record, in the spirit of `docs/COST_LOG.md`: **nothing here
is inferred.** Every command below was executed on the device and its exit code
observed. Where a behaviour was narrowed down, the isolating experiment is shown.

## Verified environment

Measured with `node -p`, `npm -v`, `git --version` and `uname -srm`.

| Component | Value |
|---|---|
| Device OS | Android, kernel `6.6.127-android15` |
| Architecture | `aarch64` (arm64), 8 cores |
| Node.js | `v26.4.0` (`process.platform === "android"`, ABI 147) |
| npm | `11.20.0` |
| Git | `2.56.0` |
| Shell | bash `5.3.20(1)-release` (POSIX `sh` is `dash`) |
| Toolchain root | installed under a private app directory, exported as `$PREFIX` |
| Vite / Vitest | `7.3.7` / `5.0.4` |

Node `26` satisfies `package.json#engines` (`^22.12.0 || ^24.0.0 || >=26.0.0`),
so no engine override was needed.

## What happens to the documented scripts

`README.md`'s Quick start assumes a desktop Linux/macOS host. On this device the
picture is:

| Documented command | Result | Why |
|---|---|---|
| `npm install` | **fails, exit 1** on a fresh tree | same esbuild `postinstall` as `npm ci` |
| `npm ci` | **fails, exit 1** | esbuild `postinstall` — see below |
| `npm run typecheck` | **works, exit 0** | pure TypeScript |
| `npm run lint` | **works, exit 0** | pure JavaScript |
| `npm test` | **fails, exit 1** | Vitest default `forks` pool — see below |
| `npm run build` | **fails, exit 126** | nested `npm` call — see below |
| `npm run dev` | works | Vite dev server, see below |

All four of the project's real gates — types, lint, tests, bundle — genuinely run
on the phone. Two of them need a different invocation, for reasons that are
environmental rather than project defects.

One nuance on `npm install`: it *appears* to succeed once `node_modules/` is
already populated, because npm does not re-run lifecycle scripts for packages it
does not reinstall. That success is a no-op, not a working install — from a clean
checkout it fails exactly like `npm ci`. It was measured both ways: exit 0 with an
existing tree, exit 1 after `rm -rf node_modules`.

## Root cause 1: `process.execPath` is the dynamic linker

The single most important fact about running Node here is:

```console
$ node -p "process.execPath"
/apex/com.android.runtime/bin/linker64

$ node -p "process.argv0"
…/bin/node
```

The Node binary is a PIE executable launched *through Android's dynamic linker*,
so Node reports **`linker64`** as its own executable path. Anything that spawns a
child Node process by re-executing `process.execPath` therefore launches
`linker64` and passes it Node arguments, which it rejects:

```console
$ node -e 'const cp=require("child_process");
  const r=cp.spawnSync(process.execPath,["--version"],{encoding:"utf8"});
  console.log("status",r.status,"stderr",r.stderr.trim())'
status 1 stderr error: expected absolute path: "--version"
```

This is *not* a general "Android cannot fork" problem. Kernel shebang execution
is unaffected — spawning a script with a `#!/bin/sh` shebang, or spawning the
esbuild JS shim (which carries `#!/usr/bin/env node`) directly, both succeed:

```console
status 0 out "hello-from-sh-script"   # #!/bin/sh probe script
status 0 out "0.28.2"                 # node_modules/esbuild/bin/esbuild --version
```

Only code that goes through `process.execPath` breaks. Two common tools do.

### Why the `forks` pool fails and `threads` works

Vitest's default pool spawns each worker file as a **child process** using
`child_process.fork`, which is built on `process.execPath`. It also injects its
own Node flags into those children:

```js
// node_modules/vitest/dist/chunks/index.B8VfM7Mf.js
execArgv: [
  ...process.argv.slice(1).filter(/* --cpu-prof, --heap-prof, --diagnostic-* */),
  "--experimental-import-meta-resolve",
  ...(globalThis.Deno || process.versions.pnp ? [] : ["--require", suppressWarningsPath])
],
```

Because the child is really `linker64`, that flag is handed to the linker instead
of to Node, and every worker dies during startup:

```console
$ node node_modules/vitest/vitest.mjs run
error: expected absolute path: "--experimental-import-meta-resolve"   (×7)
```
```text
Unhandled Error: [vitest-pool]: Worker forks emitted error.
Caused by: Error: Worker exited unexpectedly with exit code 1 during starting state
```

The `threads` pool runs each worker in a **worker thread inside the already-running
Node process**. No child process is created, `process.execPath` is never consulted,
and the injected `execArgv` is irrelevant. The same seven files then pass:

```console
$ node node_modules/vitest/vitest.mjs run --pool=threads
 ✓ src/render/stage.test.ts      (21 tests)
 ✓ src/pipeline.test.ts           (6 tests)
 ✓ src/render/drawHands.test.ts   (9 tests)
 ✓ src/sim/mouseSource.test.ts   (25 tests)
 ✓ src/game/loop.test.ts         (13 tests)
 ✓ src/sim/replaySource.test.ts  (26 tests)
 ✓ src/debug/hud.test.ts          (5 tests)
 Test Files  7 passed (7)
      Tests  105 passed (105)
```

`105 / 105` matches the figure quoted in `README.md` exactly, which also confirms
the two pools are running the same suite and not silently skipping files.

### Why `npm ci` fails, and how to install

esbuild's `postinstall` validates its native binary by re-executing
`process.execPath` with the binary path as an argument — the same trap. The
validation target here is esbuild's JS shim (it begins `#!/usr/bin/env node`, i.e.
the bytes `23 21 2f 75`), so `linker64` is asked to load a shell script as a
native executable:

```console
$ npm ci
npm error code 1
npm error path <repo>/node_modules/esbuild
npm error command sh -c node install.js
npm error Error: Command failed: /apex/com.android.runtime/bin/linker64 \
    <repo>/node_modules/esbuild/bin/esbuild --version
npm error error: "<repo>/node_modules/esbuild/bin/esbuild" has bad ELF magic: 23212f75
```

`23212f75` is simply the ASCII of `#!/u`, and this was confirmed to fail
deterministically on every run. Skipping lifecycle scripts installs the whole
tree successfully and leaves a fully working toolchain:

```bash
npm ci --ignore-scripts   # 124 packages, 0 vulnerabilities
```

This is safe *for this project specifically*: it has **zero runtime
dependencies**, and esbuild is the only package in the tree that declares a
`postinstall` (checked across every installed `package.json`). The
Android-native binaries are still installed and work correctly — the default
resolution already picks `@esbuild/android-arm64` and
`@rollup/rollup-android-arm64`, both of which load without complaint:

```console
$ node -e "console.log(require('esbuild').version)"
0.28.2
```

## Root cause 2: the `npm` shim, and nested `npm` calls

`npm run build` is `npm run typecheck && vite build` — a *nested* npm call. npm
scripts are executed by `sh` (`dash` here), which resolves `npm` from `PATH` to a
symlink whose target begins:

```
#!/data/local/tmp/<harness>/linux/bin/applets/env node
```

That shebang points into a **different execution tier** (a privileged-tier
install path) that this app-uid tier is not permitted to execute. Top-level
`npm run …` works only because the harness launches npm through `node` directly;
the moment a script shells out to `npm` by name, the exec fails:

```console
$ npm run build
> web-slinger@0.1.0 build
> npm run typecheck && vite build
…/bin/sh: 1: npm: Permission denied
$ echo $?
126
```

This also explains an earlier red herring: `timeout 240 npm run typecheck` fails
identically, because `timeout` is *also* a non-shell program trying to `exec` the
same unusable shim. `timeout` is unusable with `npm` on this device.

### Why invoking Vite through `node` works

`vite`'s CLI is plain JavaScript (`node_modules/vite/bin/vite.js`). Running it as
`node ./node_modules/vite/bin/vite.js build` bypasses `PATH` lookup, the symlink
and its bad shebang entirely, and goes straight to a Node process that is already
running. Nothing about Vite, esbuild or Rollup is degraded — the transform,
bundle and minify steps are native and fast:

```console
$ node ./node_modules/vite/bin/vite.js build
vite v7.3.7 building client environment for production...
✓ 13 modules transformed.
dist/index.html                  1.43 kB │ gzip: 0.73 kB
dist/assets/index-BBFdLM9m.css   0.84 kB │ gzip: 0.47 kB
dist/assets/index-CT5Ha5Ee.js   25.66 kB │ gzip: 9.56 kB
✓ built in 770ms
```

`npm run dev` needs no workaround at all, because it is a single (non-nested) npm
call. Vite reports ready in ~390 ms, serves `HTTP 200`, and transforms TypeScript
on request — verified by fetching `/src/main.ts` and receiving the esbuild-compiled
output. The dev server is therefore fully usable on the phone.

## Temporary workarounds vs recommended fixes

The distinction matters: the first column is how to get work done *on this
device today*, the second is what the repository could adopt so that its
documented commands work on Android without special knowledge.

| Problem | Temporary AndroidHarness workaround | Recommended durable fix |
|---|---|---|
| `npm ci` / `npm install` abort in esbuild's postinstall | `npm ci --ignore-scripts` | None needed in-repo; track upstream esbuild/Node. Optionally add an `engines`-style note to `README.md`. |
| Vitest `forks` pool kills workers | pass `--pool=threads` on the CLI | Set `pool: 'threads'` for this environment — via a `vitest.config.ts`, or `--pool=threads` in a `test:android` script. Not a plain `test` change, because CI on `ubuntu-latest` should keep exercising the default pool. |
| Nested `npm` inside `npm run build` | run `node ./node_modules/vite/bin/vite.js build`, or prepend a `PATH` shim that execs `node …/npm-cli.js` | Remove the redundant nested call: CI already runs `npm run typecheck` as its own step, so `build` could be just `vite build`. This is a maintainer decision, not an agent one. |
| `timeout npm …` returns 126 | use the harness's own command timeouts | Not a repository concern. |

### Deliberately not recommended

- **Root or Shizuku is not required.** Every command in *Reproducing this* below
  was achieved as an ordinary app-uid process with no elevated permissions, no
  `sudo`, no root and no ADB shell. The failures are Node/Android interaction
  details, not permission problems, and privileged access would not fix any of
  them — `linker64` would still be `process.execPath`.
- **Don't add runtime dependencies** to smooth any of this over. `PLAN.md` §16.2
  and the zero-runtime-dependency property of the shipped bundle are deliberate.
- **Don't pin Vitest backwards.** The `5.0.4` pin exists for a security advisory
  reason documented in `README.md`; the pool problem is unrelated to that version
  and equally affects older ones.

## Remaining limitations

Not worked around, and worth knowing before planning work here:

- **No `child_process.fork` at all.** Any tool that forks Node — Vitest's `forks`
  pool, some reporters, some watchers — is unusable. Tests must run threaded.
- **`/bin/bash` does not exist** on Android. Scripts with a `#!/bin/bash` shebang
  fail with "bad interpreter". Use `#!/bin/sh` (toybox/dash) or invoke a script
  with the toolchain's bash explicitly.
- **HTTPS-only Git.** There is no `ssh` binary, so `git@github.com:…` remotes
  cannot work; the HTTPS remote is required.
- **Shared storage is restricted.** Without "All files access" the process can
  only reach its own directories, so the repository lives in app-private storage
  rather than `/sdcard`. This is sufficient for the whole workflow, but it means
  Android Studio / another editor cannot open the checkout at the same path.
- **Memory.** The device reported ~15.5 GB of RAM with ~4 GB available (~1.3 GB
  free) during measurement. A full install plus a Vite bundle fit comfortably;
  nothing needed tuning.
- **The `npm` shim path is a harness-configured value**, not something this
  repository can influence.

## Reproducing this

On-device equivalents of the four documented gates:

```bash
npm ci --ignore-scripts                          # install (see root cause 1)
npm run typecheck                                # exit 0, as documented
npm run lint                                     # exit 0, as documented
node ./node_modules/vitest/vitest.mjs run --pool=threads   # 105/105
node ./node_modules/vite/bin/vite.js build                 # 13 modules
```

`npm run dev` works verbatim, with no substitution.

## Verification log

Measured on 2026-10-12/13 against `main` @ `e2eb32b`, Node `v26.4.0`, Vitest
`5.0.4`, Vite `7.3.7`.

| Check | Command | Exit | Observed |
|---|---|---|---|
| Install | `npm install` (fresh) | **1** | identical esbuild failure |
| Install | `npm install` (existing tree) | 0 | no-op; scripts not re-run |
| Install | `npm ci` | **1** | esbuild postinstall, `bad ELF magic: 23212f75` |
| Install | `npm ci --ignore-scripts` | 0 | 124 packages, 0 vulnerabilities |
| Types | `npm run typecheck` | 0 | clean |
| Lint | `npm run lint` | 0 | clean, `--max-warnings=0` |
| Tests | `npm test` | **1** | 7 × `expected absolute path` |
| Tests | `… vitest.mjs run --pool=threads` | 0 | **105/105 in 7 files** |
| Build | `npm run build` | **126** | `sh: 1: npm: Permission denied` |
| Build | `node ./node_modules/vite/bin/vite.js build` | 0 | 13 modules → `dist/` |
| Dev | `npm run dev` | — | ready 389 ms, HTTP 200 |

This document is the only artefact of that session; no source, script,
dependency, CI or `PLAN.md` change accompanies it.
