import { defineConfig } from 'vite';

/**
 * The only reason this project needs a Vite config.
 *
 * MediaPipe's WASM loader is an Emscripten **classic** script that publishes the
 * factory as a global (`self.ModuleFactory`). In a *module* worker the bundle's
 * `importScripts` attempt throws, its dynamic-`import()` fallback leaves the global
 * unset, and initialisation dies with `Error: ModuleFactory not set.` — reproduced,
 * and the root cause of the long-standing upstream reports.
 *
 * A classic worker loads that script exactly as written and the problem disappears,
 * which is why the worker is emitted as `iife` rather than as an ES module. The
 * alternative was `eval`-ing a fetched script into global scope; this is better.
 */
export default defineConfig({
  worker: {
    format: 'iife',
  },
});
