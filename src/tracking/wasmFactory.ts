/**
 * Loading MediaPipe's Emscripten factory into global scope, deliberately.
 *
 * ---- The bug this exists to fix ----
 *
 * MediaPipe's WASM loader (`vision_wasm_internal.js`) declares the factory as
 * `var ModuleFactory = (() => …)()`. That only becomes a **global** when the script is
 * evaluated as a *classic* script. MediaPipe's own loader tries:
 *
 * 1. `importScripts(url)` — works in a classic worker;
 * 2. `catch` → dynamic `import(url)` — which leaves the declaration *module-scoped*,
 *    so `self.ModuleFactory` stays undefined and the next line throws
 *    `Error: ModuleFactory not set.`
 *
 * So a **module worker** cannot load this library by the library's own route. This was
 * not a theory: on Vite's dev server the worker is always served as
 * `type: "module"`, and the failure was reproduced exactly — MediaPipe requested
 * `/wasm/vision_wasm_internal.js` as a module, and Vite refused to serve a `public/`
 * file that way:
 *
 * > Failed to load url /wasm/vision_wasm_internal.js … This file is in /public and
 * > will be copied as-is during build … and therefore should not be imported from
 * > source code. It can only be referenced via HTML tags.
 *
 * The same URL requested as a **classic** script returns 200 (335 KB) and works, which
 * is why the production build appeared fine while dev was broken.
 *
 * ---- The fix ----
 *
 * Stop relying on the library's loader and on the worker type. Ensure the factory is
 * global ourselves — `importScripts` where it genuinely works, otherwise fetch the
 * text and evaluate it **indirectly** (`scope.eval(code)` is an indirect eval, so it
 * runs in global scope and top-level `var` lands on the global object) — and then
 * blank `wasmLoaderPath` so MediaPipe skips its own loader, which the bundle guards
 * with `if (e && await jh(e), !self.ModuleFactory) throw …`, i.e. a falsy path skips
 * straight to using the global we just set.
 *
 * This makes the worker behave identically under `vite dev` and `vite build`, and
 * removes any dependence on the worker being classic. `importScripts` is preferred
 * where it works because it is the native mechanism and avoids evaluation.
 */

/** The parts of Emscripten's output this project touches. */
export interface FilesetLike {
  /**
   * Path to the loader script. Cleared after pre-loading so MediaPipe does not try to
   * load it again by its own (broken in a module worker) route.
   */
  wasmLoaderPath?: string | undefined;
}

/** The global surface needed to load the factory. Injected so it can be tested. */
export interface ScriptScope {
  ModuleFactory?: unknown;
  /** Present in workers. In a *module* worker it exists but throws when called. */
  importScripts?: ((url: string) => void) | undefined;
  fetch(input: string): Promise<{
    ok: boolean;
    status: number;
    text(): Promise<string>;
  }>;
  /** Called as a method, which makes it an *indirect* eval: global scope. */
  eval(code: string): unknown;
}

/** How the factory ended up in scope. */
export type WasmFactoryLoad = 'already-loaded' | 'importScripts' | 'eval';

/** The real worker/global scope. */
export function workerScriptScope(): ScriptScope {
  // No cast needed: the members this needs (`fetch`, `eval`, and the optional
  // `ModuleFactory`/`importScripts`) are all present on a worker's global, and the
  // optional ones do not constrain assignability.
  return globalThis;
}

/** Describe a thrown value without risking `[object Object]`. */
function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unknown error';
}

function hasFactory(scope: ScriptScope): boolean {
  return typeof scope.ModuleFactory === 'function';
}

/**
 * Make MediaPipe's Emscripten factory available as a global.
 *
 * Idempotent: returns `'already-loaded'` without touching the network if a previous
 * call (or an earlier landmarker) already put it there.
 *
 * Throws only when neither route can produce the factory, because every caller is on
 * an initialisation path that cannot continue without it.
 */
export async function ensureWasmFactory(
  loaderPath: string,
  scope: ScriptScope = workerScriptScope(),
): Promise<WasmFactoryLoad> {
  if (hasFactory(scope)) return 'already-loaded';

  // Remembered rather than discarded: a module worker throws here *by design*, but if
  // the fallback also fails then this is the error that explains why.
  let importScriptsError: unknown = null;

  if (typeof scope.importScripts === 'function') {
    try {
      scope.importScripts(loaderPath);
      if (hasFactory(scope)) return 'importScripts';
    } catch (error) {
      // `importScripts` exists but throws in a module worker. Any error is tolerated
      // here — rejecting a browser that throws something other than a TypeError would
      // reintroduce the bug this function exists to fix — and the fallback below is
      // what actually has to work.
      importScriptsError = error;
    }
  }

  const response = await scope.fetch(loaderPath);
  if (!response.ok) {
    throw new Error(`could not fetch the MediaPipe WASM loader at ${loaderPath}: HTTP ${response.status}`);
  }

  const code = await response.text();
  // Indirect eval: runs in global scope, so the loader's top-level `var
  // ModuleFactory` becomes a global property.
  scope.eval(code);

  if (!hasFactory(scope)) {
    const because =
      importScriptsError === null
        ? ''
        : ` (importScripts failed first: ${describeThrown(importScriptsError)})`;
    throw new Error(
      `the MediaPipe WASM loader at ${loaderPath} did not define a global ModuleFactory${because}`,
    );
  }

  return 'eval';
}

/**
 * Prepare a resolved fileset for use inside a worker.
 *
 * Returns which route loaded the factory, or `'no-loader-path'` when the fileset did
 * not carry one (nothing to do, and nothing to blank).
 */
export async function prepareWorkerFileset(
  fileset: FilesetLike,
  scope: ScriptScope = workerScriptScope(),
): Promise<WasmFactoryLoad | 'no-loader-path'> {
  const loaderPath = fileset.wasmLoaderPath;
  if (loaderPath === undefined || loaderPath === '') return 'no-loader-path';

  const loaded = await ensureWasmFactory(loaderPath, scope);

  // MediaPipe checks `if (e && await jh(e), !self.ModuleFactory) throw …`, so an unset
  // path makes it skip its own loader and use the global we just established.
  fileset.wasmLoaderPath = undefined;

  return loaded;
}
