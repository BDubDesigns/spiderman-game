/**
 * The main-thread half of the worker configuration (PLAN.md §7.3, option 2).
 *
 * It spawns the worker, hands it an `ImageBitmap` per frame, and correlates results
 * back by id. The `ImageBitmap` path is the one Google's own worker sample uses: the
 * capture is asynchronous and cheap (~0.8 ms measured for 640×480, and it does not
 * block), the transfer is zero-copy in spec, and the worker owns the bitmap
 * afterwards.
 *
 * ---- Failure is explicit, not silent ----
 *
 * MediaPipe's GPU initialisation **rejects** rather than degrading to CPU, and a
 * worker that quietly ran on CPU would look identical from here. So:
 *
 * - init reports which delegate is live and whether it fell back;
 * - every in-flight detection is rejected if the worker dies or goes quiet, so the
 *   caller's failure policy sees a real failure rather than a frozen hand;
 * - `close()` rejects anything still pending instead of leaving promises dangling.
 */

import type {
  HandLandmarkerConfig,
  LandmarkerDelegate,
} from './handTracker';
import type { DetectedHands, DetectionBackend } from './detectionBackend';
import type { InferenceRequest, InferenceResponse } from './inferenceWorkerCore';

/** The parts of `Worker` this module uses, so it can be faked in tests. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void,
  ): void;
  terminate(): void;
}

export interface WorkerDetectionBackendOptions {
  /** Injected so tests do not need a real worker. */
  createWorker(): WorkerLike;
  config: HandLandmarkerConfig;
  preferredDelegate: LandmarkerDelegate;
  swapHandedness: boolean;
  /**
   * Defaults to `globalThis.createImageBitmap`. Injected for tests.
   *
   * Declared as a function property, not a method: it is read off the options object
   * and called detached, and method syntax would imply a `this` that does not exist.
   */
  capture?: (video: HTMLVideoElement) => Promise<ImageBitmap>;
  /** How long to wait for `ready`. Generous: the worker loads WASM and a model. */
  initTimeoutMs: number;
  /** How long to wait for one result before rejecting it. */
  detectTimeoutMs: number;
}

interface PendingDetection {
  resolve(value: DetectedHands): void;
  reject(error: Error): void;
  timer: ReturnType<typeof globalThis.setTimeout>;
}

export class WorkerDetectionBackend implements DetectionBackend {
  readonly kind = 'worker' as const;

  private readonly options: WorkerDetectionBackendOptions;
  private worker: WorkerLike | null = null;
  private listener: ((event: { data: unknown }) => void) | null = null;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<number, PendingDetection>();

  private initResult: {
    delegate: LandmarkerDelegate;
    fellBack: boolean;
    message: string | null;
  } | null = null;
  private initWaiter:
    | { resolve(): void; reject(error: Error): void }
    | null = null;

  constructor(options: WorkerDetectionBackendOptions) {
    this.options = options;
  }

  get delegate(): LandmarkerDelegate | null {
    return this.initResult?.delegate ?? null;
  }

  get delegateFallback(): boolean {
    return this.initResult?.fellBack ?? false;
  }

  get delegateMessage(): string | null {
    return this.initResult?.message ?? null;
  }

  init(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('worker backend closed'));
    if (this.worker !== null) return Promise.resolve();

    const worker = this.options.createWorker();
    this.worker = worker;

    const listener = (event: { data: unknown }): void => {
      this.onMessage(event.data);
    };
    this.listener = listener;
    worker.addEventListener('message', listener);

    return new Promise<void>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        // A worker that never reports ready is a failure, not a hang.
        this.initWaiter = null;
        reject(new Error(`worker did not report ready within ${this.options.initTimeoutMs} ms`));
      }, this.options.initTimeoutMs);

      this.initWaiter = {
        resolve: () => {
          globalThis.clearTimeout(timer);
          resolve();
        },
        reject: (error) => {
          globalThis.clearTimeout(timer);
          reject(error);
        },
      };

      const request: InferenceRequest = {
        type: 'init',
        config: this.options.config,
        preferredDelegate: this.options.preferredDelegate,
        swapHandedness: this.options.swapHandedness,
      };
      worker.postMessage(request);
    });
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      globalThis.clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'object' || data === null) return;
    const response = data as InferenceResponse;

    switch (response.type) {
      case 'ready':
        this.initResult = {
          delegate: response.delegate,
          fellBack: response.fellBack,
          message: response.message,
        };
        this.initWaiter?.resolve();
        this.initWaiter = null;
        return;

      case 'init-error': {
        const waiter = this.initWaiter;
        this.initWaiter = null;
        this.teardown();
        waiter?.reject(new Error(`worker failed to initialize: ${response.message}`));
        return;
      }

      case 'result': {
        const pending = this.pending.get(response.id);
        if (pending === undefined) return;
        globalThis.clearTimeout(pending.timer);
        this.pending.delete(response.id);
        pending.resolve({ hands: response.hands, costMs: response.costMs });
        return;
      }

      case 'detect-error': {
        const pending = this.pending.get(response.id);
        if (pending === undefined) return;
        globalThis.clearTimeout(pending.timer);
        this.pending.delete(response.id);
        pending.reject(new Error(response.message));
        return;
      }

      default:
        return;
    }
  }

  async detect(video: HTMLVideoElement, timestampMs: number): Promise<DetectedHands> {
    const worker = this.worker;
    if (worker === null) throw new Error('worker backend used before init()');

    const capture =
      this.options.capture ?? ((element: HTMLVideoElement) => createImageBitmap(element));
    const bitmap = await capture(video);

    // The capture is asynchronous, so a teardown can land inside this window. Without
    // this check the detection would post to a terminated worker — which throws — and
    // would leave a timer running after the session it belonged to had gone.
    if (this.closed || this.worker === null) {
      try {
        bitmap.close();
      } catch {
        // Already released: not worth failing over.
      }
      throw new Error('worker backend closed');
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<DetectedHands>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        this.pending.delete(id);
        // Release the bitmap we still own: the worker never acknowledged it, or it
        // would already have closed it.
        try {
          bitmap.close();
        } catch {
          // Already released: not worth failing over.
        }
        reject(new Error(`worker detection ${id} timed out after ${this.options.detectTimeoutMs} ms`));
      }, this.options.detectTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const request: InferenceRequest = {
        type: 'detect',
        id,
        bitmap,
        timestampMs,
      };
      // Transferring hands ownership to the worker; closing it here would be a
      // use-after-free on the other side.
      worker.postMessage(request, [bitmap]);
    });
  }

  private teardown(): void {
    const worker = this.worker;
    const listener = this.listener;
    this.worker = null;
    this.listener = null;
    if (worker !== null && listener !== null) {
      worker.removeEventListener('message', listener);
    }
    worker?.terminate();
  }

  close(): void {
    this.closed = true;
    const error = new Error('worker backend closed');
    if (this.worker !== null) {
      try {
        const request: InferenceRequest = { type: 'close' };
        this.worker.postMessage(request);
      } catch {
        // The worker may already be gone; terminating it is what matters.
      }
    }
    this.failAllPending(error);
    this.initWaiter?.reject(error);
    this.initWaiter = null;
    this.teardown();
    this.initResult = null;
  }
}
