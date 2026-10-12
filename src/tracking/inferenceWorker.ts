/**
 * The worker entry point.
 *
 * Deliberately tiny: everything with logic in it lives in `inferenceWorkerCore.ts`
 * so it can be unit-tested without spawning a worker or loading WASM. This file only
 * connects the handler to the worker's message port.
 *
 * Emitted as a **classic** worker (see `vite.config.ts`) because MediaPipe's WASM
 * loader publishes `self.ModuleFactory` from a classic script, which a module worker
 * cannot do — that failure is `Error: ModuleFactory not set.`
 */

import {
  createMediapipeLandmarker,
  type LandmarkerFactory,
} from './handTracker';
import { createInferenceHandler } from './inferenceWorkerCore';
import { prepareWorkerFileset } from './wasmFactory';

/** The slice of `DedicatedWorkerGlobalScope` used here. */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
}

const scope = globalThis as unknown as WorkerScope;

/**
 * Create landmarkers with the WASM factory pre-loaded into this worker's global scope.
 *
 * Necessary because MediaPipe's loader cannot work in a module worker, and Vite's dev
 * server always serves the worker as a module. See `wasmFactory.ts` for the mechanism
 * and the reproduced failure.
 */
const workerFactory: LandmarkerFactory = (delegate, config) =>
  createMediapipeLandmarker({
    delegate,
    config,
    prepareFileset: async (fileset) => {
      await prepareWorkerFileset(fileset);
    },
  });

const handler = createInferenceHandler({
  factory: workerFactory,
  post: (response) => {
    scope.postMessage(response);
  },
});

scope.addEventListener('message', (event) => {
  // `handle` never throws; failures come back as messages.
  void handler.handle(event.data);
});
