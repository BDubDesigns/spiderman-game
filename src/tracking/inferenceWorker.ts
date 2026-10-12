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

import { mediapipeLandmarkerFactory } from './handTracker';
import { createInferenceHandler } from './inferenceWorkerCore';

/** The slice of `DedicatedWorkerGlobalScope` used here. */
interface WorkerScope {
  postMessage(message: unknown): void;
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
}

const scope = globalThis as unknown as WorkerScope;

const handler = createInferenceHandler({
  factory: mediapipeLandmarkerFactory,
  post: (response) => {
    scope.postMessage(response);
  },
});

scope.addEventListener('message', (event) => {
  // `handle` never throws; failures come back as messages.
  void handler.handle(event.data);
});
