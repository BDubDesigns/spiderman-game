/**
 * Unit tests for the explicit WASM factory loading.
 *
 * The regression under test is a reproduced, user-visible failure: Vite's dev server
 * serves the worker as a module, MediaPipe's `importScripts` throws, its dynamic
 * `import()` fallback asks Vite for a `public/` file as a module, and Vite refuses:
 *
 * > This file is in /public and will be copied as-is during build … and therefore
 * > should not be imported from source code.
 *
 * So the important case is *module worker*: `importScripts` exists but throws, and the
 * factory must still end up global.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  ensureWasmFactory,
  prepareWorkerFileset,
  type ScriptScope,
} from './wasmFactory';

interface Harness {
  scope: ScriptScope;
  fetchMock: ReturnType<typeof vi.fn>;
  evalMock: ReturnType<typeof vi.fn>;
}

/** A classic worker: `importScripts` loads the file and defines the global. */
function classicScope(): Harness {
  const fetchMock = vi.fn();
  const evalMock = vi.fn();
  const scope: ScriptScope = {
    importScripts: (url: string) => {
      expect(url).toBe('/wasm/vision_wasm_internal.js');
      scope.ModuleFactory = () => {};
    },
    fetch: fetchMock,
    eval: evalMock,
  };
  return { scope, fetchMock, evalMock };
}

/**
 * A module worker, as Vite's dev server produces: `importScripts` is defined but
 * throws, and the text has to be evaluated instead.
 */
function moduleWorkerScope(body = 'var ModuleFactory = function () {};'): Harness {
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) }),
  );
  const evalMock = vi.fn();
  const scope: ScriptScope = {
    importScripts: () => {
      throw new TypeError('importScripts is not supported in module workers');
    },
    fetch: fetchMock,
    eval: (code: string) => {
      evalMock(code);
      if (body.includes('ModuleFactory')) scope.ModuleFactory = () => {};
      return undefined;
    },
  };
  return { scope, fetchMock, evalMock };
}

const LOADER = '/wasm/vision_wasm_internal.js';

describe('ensureWasmFactory', () => {
  it('loads via importScripts in a classic worker, without fetching', async () => {
    const { scope, fetchMock, evalMock } = classicScope();

    await expect(ensureWasmFactory(LOADER, scope)).resolves.toBe('importScripts');
    expect(fetchMock).not.toHaveBeenCalled();
    // No evaluation when the native mechanism works.
    expect(evalMock).not.toHaveBeenCalled();
  });

  it('falls back to fetching and evaluating in a module worker', async () => {
    // This is the exact case that produced the user-visible Vite error.
    const { scope, fetchMock, evalMock } = moduleWorkerScope();

    await expect(ensureWasmFactory(LOADER, scope)).resolves.toBe('eval');
    expect(fetchMock).toHaveBeenCalledWith(LOADER);
    expect(evalMock).toHaveBeenCalledOnce();
    expect(typeof scope.ModuleFactory).toBe('function');
  });

  it('evaluates when there is no importScripts at all', async () => {
    const { scope } = moduleWorkerScope();
    scope.importScripts = undefined;

    await expect(ensureWasmFactory(LOADER, scope)).resolves.toBe('eval');
  });

  it('is idempotent, so a second landmarker does not refetch', async () => {
    const { scope, fetchMock } = moduleWorkerScope();
    await ensureWasmFactory(LOADER, scope);
    fetchMock.mockClear();

    await expect(ensureWasmFactory(LOADER, scope)).resolves.toBe('already-loaded');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a failed fetch with the status, rather than a vague failure', async () => {
    const scope: ScriptScope = {
      fetch: () => Promise.resolve({ ok: false, status: 404, text: () => Promise.resolve('') }),
      eval: () => undefined,
    };

    await expect(ensureWasmFactory(LOADER, scope)).rejects.toThrow(/HTTP 404/);
  });

  it('fails loudly when the script loads but defines nothing', async () => {
    // A silently-missing global would otherwise surface much later as
    // "ModuleFactory not set." from inside the library.
    const scope: ScriptScope = {
      fetch: () =>
        Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('var nope = 1;') }),
      eval: () => undefined,
    };

    await expect(ensureWasmFactory(LOADER, scope)).rejects.toThrow(/did not define a global ModuleFactory/);
  });

  it('tolerates any error from importScripts, but keeps it for the failure message', async () => {
    // A module worker throws TypeError here, but rejecting a browser that throws
    // something else would reintroduce the very bug this fixes. So any error falls
    // through to evaluation — and is reported if evaluation cannot save us either.
    const scope: ScriptScope = {
      importScripts: () => {
        throw new Error('network down');
      },
      fetch: () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('') }),
      eval: () => undefined,
    };

    await expect(ensureWasmFactory(LOADER, scope)).rejects.toThrow(
      /did not define a global ModuleFactory \(importScripts failed first: network down\)/,
    );
  });

  it('prefers the evaluated factory when importScripts threw but left nothing behind', async () => {
    // Chrome is expected to throw a TypeError in a module worker, but the decision
    // must be based on whether the global exists, not on the error type.
    const { scope } = moduleWorkerScope();
    await expect(ensureWasmFactory(LOADER, scope)).resolves.toBe('eval');
  });
});

describe('prepareWorkerFileset', () => {
  it('pre-loads the factory and clears the path so MediaPipe skips its own loader', async () => {
    const { scope } = classicScope();
    const fileset = { wasmLoaderPath: LOADER };

    await expect(prepareWorkerFileset(fileset, scope)).resolves.toBe('importScripts');
    // MediaPipe reads `if (e && await jh(e), !self.ModuleFactory) throw …`, so this is
    // what stops it from making the request Vite refuses.
    expect(fileset.wasmLoaderPath).toBeUndefined();
  });

  it('does nothing when the fileset carries no loader path', async () => {
    const { scope, fetchMock } = classicScope();

    await expect(prepareWorkerFileset({}, scope)).resolves.toBe('no-loader-path');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves the path cleared even when the factory was already loaded', async () => {
    const { scope } = classicScope();
    scope.ModuleFactory = () => {};
    const fileset = { wasmLoaderPath: LOADER };

    await expect(prepareWorkerFileset(fileset, scope)).resolves.toBe('already-loaded');
    expect(fileset.wasmLoaderPath).toBeUndefined();
  });
});
