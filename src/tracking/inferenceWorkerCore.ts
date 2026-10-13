/**
 * The worker's message protocol and its handler, kept separate from the worker entry
 * point so the logic is unit-testable without spawning anything.
 *
 * `inferenceWorker.ts` is a twelve-line file that wires this to `self`. Everything
 * that can be wrong — protocol validation, the GPU → CPU fallback, bitmap lifetime,
 * error reporting — lives here and is tested with plain objects.
 *
 * ---- Why a *classic* worker ----
 *
 * Decided in `vite.config.ts`: MediaPipe's WASM loader publishes `self.ModuleFactory`
 * from a classic script, and in a module worker that never happens, so initialisation
 * dies with `Error: ModuleFactory not set.`
 *
 * ---- Bitmap lifetime ----
 *
 * The main thread transfers an `ImageBitmap`; the worker then **owns** it and must
 * `close()` it or the memory leaks one image per frame. That is done in a `finally`
 * so it holds on every path, including an uninitialised handler and a throw from the
 * model.
 */

import {
  initLandmarkerWithFallback,
  mapDetectedHands,
  type DetectImageSource,
  type HandLandmarkerConfig,
  type HandLandmarkerLike,
  type LandmarkerDelegate,
  type LandmarkerFactory,
} from './handTracker';
import type { RawHandFrame } from './landmarkTypes';

/** The parts of `ImageBitmap` this module uses. */
export interface TransferredBitmap {
  close(): void;
  readonly width: number;
  readonly height: number;
}

/**
 * Narrow a structured-clone payload to something `detectForVideo` will accept.
 *
 * A worker receives an untyped value, so this is a real boundary and the check is
 * real: a transferred `ImageBitmap` has `close`, `width` and `height`. The final cast
 * is unavoidable — `ImageBitmap` is a DOM interface that cannot be structurally
 * satisfied by a plain object — but it happens only after the guard has established
 * the shape, which is the point.
 */
export function asImageSource(value: unknown): DetectImageSource | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<TransferredBitmap>;
  if (typeof candidate.close !== 'function') return null;
  if (typeof candidate.width !== 'number' || typeof candidate.height !== 'number') {
    return null;
  }
  return candidate as unknown as DetectImageSource;
}

export type InferenceRequest =
  | {
      type: 'init';
      config: HandLandmarkerConfig;
      preferredDelegate: LandmarkerDelegate;
      swapHandedness: boolean;
    }
  | { type: 'detect'; id: number; bitmap: TransferredBitmap; timestampMs: number }
  | { type: 'close' };

export type InferenceResponse =
  | {
      type: 'ready';
      delegate: LandmarkerDelegate;
      fellBack: boolean;
      message: string | null;
    }
  | { type: 'init-error'; message: string }
  | { type: 'result'; id: number; hands: RawHandFrame[]; costMs: number }
  | { type: 'detect-error'; id: number; message: string };

export interface InferenceHandlerOptions {
  factory: LandmarkerFactory;
  post: (response: InferenceResponse) => void;
  /** Injectable clock, so a test can assert the reported cost. */
  now?: () => number;
}

export interface InferenceHandler {
  /** Handle one message. Never throws: failures are posted back. */
  handle(request: unknown): Promise<void>;
  /** Release the model. Safe to call more than once. */
  close(): void;
  readonly ready: boolean;
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'unknown error';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Create the handler.
 *
 * The factory is injected so the tests can drive a fake landmarker; the real one is
 * passed by `inferenceWorker.ts`.
 */
export function createInferenceHandler(
  options: InferenceHandlerOptions,
): InferenceHandler {
  const now = options.now ?? (() => globalThis.performance.now());

  let landmarker: HandLandmarkerLike | null = null;
  let swapHandedness = false;

  async function handleInit(request: Record<string, unknown>): Promise<void> {
    const config = request['config'] as HandLandmarkerConfig | undefined;
    const preferred = request['preferredDelegate'] as LandmarkerDelegate | undefined;

    if (config === undefined || (preferred !== 'GPU' && preferred !== 'CPU')) {
      options.post({ type: 'init-error', message: 'init request is missing config or delegate' });
      return;
    }

    try {
      const result = await initLandmarkerWithFallback(options.factory, config, preferred);
      landmarker = result.landmarker;
      swapHandedness = request['swapHandedness'] === true;
      options.post({
        type: 'ready',
        delegate: result.delegate,
        fellBack: result.fellBack,
        message: result.message,
      });
    } catch (error) {
      // GPU init failure rejects rather than degrading, so this is a real failure
      // report. The main thread turns it into the simulator fallback.
      options.post({ type: 'init-error', message: describe(error) });
    }
  }

  function handleDetect(request: Record<string, unknown>): void {
    const id = typeof request['id'] === 'number' ? request['id'] : -1;
    const timestampMs =
      typeof request['timestampMs'] === 'number' ? request['timestampMs'] : 0;
    const raw = request['bitmap'];
    const bitmap = raw as TransferredBitmap | undefined;
    const image = asImageSource(raw);

    try {
      const active = landmarker;
      if (active === null) {
        options.post({ type: 'detect-error', id, message: 'detector is not initialized' });
        return;
      }
      if (image === null) {
        options.post({ type: 'detect-error', id, message: 'no usable image bitmap supplied' });
        return;
      }

      const started = now();
      const result = active.detectForVideo(image, timestampMs);
      const hands = mapDetectedHands(result, swapHandedness);
      // `costMs` is this worker's own processing time, so it is comparable with the
      // main-thread baseline. The round trip is measured on the other side.
      options.post({ type: 'result', id, hands, costMs: now() - started });
    } catch (error) {
      options.post({ type: 'detect-error', id, message: describe(error) });
    } finally {
      // The worker owns the transferred bitmap and must release it, on every path.
      if (bitmap !== undefined && typeof bitmap.close === 'function') {
        try {
          bitmap.close();
        } catch {
          // Closing an already-closed bitmap must not break the message loop.
        }
      }
    }
  }

  return {
    async handle(request: unknown): Promise<void> {
      if (!isObject(request)) {
        options.post({ type: 'detect-error', id: -1, message: 'malformed request' });
        return;
      }

      switch (request['type']) {
        case 'init':
          await handleInit(request);
          return;
        case 'detect':
          handleDetect(request);
          return;
        case 'close':
          landmarker?.close();
          landmarker = null;
          return;
        default:
          options.post({
            type: 'detect-error',
            id: -1,
            message: `unknown request type: ${String(request['type'])}`,
          });
      }
    },

    close(): void {
      landmarker?.close();
      landmarker = null;
    },

    get ready(): boolean {
      return landmarker !== null;
    },
  };
}
