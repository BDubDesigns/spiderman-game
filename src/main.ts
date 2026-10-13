/**
 * Web Slinger — M1 bootstrap.
 *
 * Scope (PLAN.md §13 M1):
 *   - camera capture with a real-hand tracker behind the same `HandFrameSource`
 *     contract the M0 simulator and replay harness satisfy;
 *   - mirrored video and mirrored landmarks, unmirrored HUD (Rule B, Rule F);
 *   - stable hand identity across crossing, occlusion and reacquisition (§10);
 *   - adaptive inference scheduled separately from rendering (§7.1), clocked by
 *     `requestVideoFrameCallback` when available;
 *   - camera denial, missing camera and model-load failure all fall back to the
 *     interactive simulator rather than dead-ending (§13 M1, §15 risk 13).
 *
 * **No game systems.** Targets, webs and scoring are M3/M4.
 *
 * Three concerns, deliberately not merged:
 *
 *   render loop (game loop, rAF)   draws whatever the latest hands are
 *   inference loop (frame clock)   decides *when* to run the detector
 *   association (§10)              runs exactly once per detection
 *
 * Association runs per *detection*, not per rendered frame. Running it per frame
 * would re-observe the same hands many times over and make the grace and staleness
 * windows meaningless.
 */

import './styles.css';

import replayFixture from '../fixtures/replay-sweep.json';
import {
  DEBUG,
  DETECTION_MODE,
  GESTURE,
  GESTURE_METHOD,
  GESTURE_SELECTION,
  INFERENCE,
  LOOP,
  MEDIAPIPE,
  MEASUREMENT,
  RENDER,
  SOURCE,
  SOURCE_SELECTION,
  type DetectionMode,
  type GestureMethod,
} from './config';
import { drawHud, type HudSourceStats, type HudStats } from './debug/hud';
import { observeLongFrames } from './debug/longFrames';
import { HandFrameCapture } from './debug/capture';
import { CapturePanel } from './debug/capturePanel';
import { GestureController, type GestureEvent, type GestureFrame } from './gesture/gestureController';
import type { FingerName } from './gesture/jointCurl';
import { GameState, type FireOutcome } from './game/gameState';
import { drawReticle, drawTargetsAndWebs, targetRadiusPx } from './render/drawWebs';
import { HandRenderPipeline } from './render/handRender';
import { MeasurementRecorder } from './debug/measurement';
import { createFixedStepLoop, type FixedStepLoop } from './game/loop';
import {
  browserCameraEnvironment,
  createStartGuard,
  formatDiagnostic,
  releaseCamera,
  startCamera,
} from './platform/camera';
import type {
  CameraFailure,
  CameraSessionParts,
  MediaStreamLike,
  PendingPlayback,
} from './platform/camera';
import { createFrameClock, type FrameClock } from './platform/raf';
import { drawHands } from './render/drawHands';
import { drawMirroredVideo } from './render/drawVideo';
import { syncCanvasBackingStore, toCanvas, toNormalized, type Vec2 } from './render/stage';
import { MouseSource } from './sim/mouseSource';
import { parseReplayClip, ReplaySource } from './sim/replaySource';
import {
  HandIdentityTracker,
  type HandIdentityId,
  type TrackedHand,
} from './tracking/handIdentity';
import { Landmark, type NormalizedPoint } from './tracking/landmarkTypes';
import {
  MainThreadDetectionBackend,
  type DetectionBackend,
} from './tracking/detectionBackend';
import {
  CameraHandSource,
  HandTracker,
  type HandLandmarkerConfig,
} from './tracking/handTracker';
import { WorkerDetectionBackend } from './tracking/workerBackend';
// `?worker` is Vite's worker constructor import. It is emitted as a *classic*
// worker; vite.config.ts explains why that matters for MediaPipe's WASM loader.
import InferenceWorker from './tracking/inferenceWorker?worker';
import { InferenceScheduler } from './tracking/inferenceScheduler';
import type { HandFrameSource, RawHandFrame } from './tracking/landmarkTypes';

const MOUSE_SOURCE_ID = 'mouse';
const REPLAY_SOURCE_ID = 'replay';
const CAMERA_SOURCE_ID = 'camera';

function requireElement<T extends HTMLElement>(
  id: string,
  guard: (element: HTMLElement) => element is T,
  description: string,
): T {
  const element = document.getElementById(id);
  if (element === null || !guard(element)) {
    throw new Error(`M1 bootstrap: ${description} (#${id}) is missing from index.html`);
  }
  return element;
}

/** Live camera state. `null` until the camera has started successfully. */
interface CameraSession {
  video: HTMLVideoElement;
  stream: MediaStreamLike;
  backend: DetectionBackend;
  source: CameraHandSource;
  identity: HandIdentityTracker;
  scheduler: InferenceScheduler;
  clock: FrameClock;
}

/**
 * The win screen (§12.3: N targets spawn → clear → win screen → replay).
 *
 * Deliberately not an error state and not a modal: the design goal is delight, so
 * the round simply announces itself and says how to go again. There is no fail
 * state anywhere in the game (§12.3).
 */
function drawWinScreen(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  scored: number,
  total: number,
): void {
  const boxW = Math.min(width * 0.8, 420);
  const boxH = 110;
  const x = (width - boxW) / 2;
  const y = height * 0.34;

  ctx.save();
  ctx.fillStyle = 'rgba(11, 11, 18, 0.86)';
  ctx.fillRect(x, y, boxW, boxH);
  ctx.strokeStyle = RENDER.targetRingColor;
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, boxW, boxH);

  ctx.fillStyle = RENDER.hudColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 30px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.fillText('ALL TARGETS WEBBED!', width / 2, y + 38);
  ctx.font = RENDER.hudFont;
  ctx.fillText(`${scored} of ${total} scored — press R to play again`, width / 2, y + 76);
  ctx.restore();
}

/**
 * The hand auto-aim should use, from this frame's gesture state.
 *
 * Only *observed* positions (`tracked`) are eligible: §7.2 keeps interpolated
 * positions out of anything that decides gameplay, and aiming decides a hit.
 */
function aimHandFor(frame: GestureFrame): {
  palmCenter: NormalizedPoint;
  wrist: NormalizedPoint;
  indexTip: NormalizedPoint;
} | null {
  const hand = frame.hands.find((candidate) => !candidate.frozen);
  if (hand === undefined) return null;
  return {
    palmCenter: hand.palmCenter,
    wrist: hand.wrist ?? hand.palmCenter,
    indexTip: hand.indexTip ?? hand.palmCenter,
  };
}

  /**
   * Which pose classifier to run (PLAN.md §11.5).
   *
   * `?gesture=angle` selects the joint-angle method for this session; the default stays
   * the shipped distance method until real-hand data justifies switching.
   */
  function resolveGestureMethod(): GestureMethod {
    const requested = new URLSearchParams(globalThis.location.search).get(
      GESTURE_SELECTION.queryParam,
    );
    return requested === 'angle' || requested === 'distance' ? requested : GESTURE_METHOD;
  }


  function main(): void {
    const canvas = requireElement(
    'stage',
    (element): element is HTMLCanvasElement => element instanceof HTMLCanvasElement,
    'stage canvas',
  );
  const notice = requireElement(
    'notice',
    (element): element is HTMLParagraphElement => element instanceof HTMLParagraphElement,
    'notice banner',
  );
  const stageWrap = requireElement(
    'stage-wrap',
    (element): element is HTMLDivElement => element instanceof HTMLDivElement,
    'stage wrapper',
  );
  const cameraButton = requireElement(
    'camera-button',
    (element): element is HTMLButtonElement => element instanceof HTMLButtonElement,
    'camera button',
  );

  // The camera element is mounted inside the stage, invisible but genuinely laid
  // out. See `CameraEnvironment.mountVideo` for why hiding must not remove it from
  // the render tree.
  const cameraEnvironment = browserCameraEnvironment(stageWrap);

  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('M1 bootstrap: 2D canvas context is unavailable');
  }
  const ctx: CanvasRenderingContext2D = context;

  // Rule A: the backing store equals the source's intrinsic dimensions. Until a
  // camera provides real ones, the M0 placeholder stands in.
  syncCanvasBackingStore(canvas, SOURCE.width, SOURCE.height);

  const mouse = new MouseSource({
    sourceWidthPx: canvas.width,
    sourceHeightPx: canvas.height,
  });
  const replay = new ReplaySource(parseReplayClip(replayFixture));
  const measurement = new MeasurementRecorder({ windowMs: MEASUREMENT.windowMs });

  let camera: CameraSession | null = null;
  /**
   * A camera whose stream is live and whose element is ready, but which refused to
   * play. Held here so a real click can finish the job without a second permission
   * prompt. Never left un-released: that is a camera light left on.
   */
  let pendingPlayback: PendingPlayback<HTMLVideoElement> | null = null;
  let latestTracked: TrackedHand[] = [];
  let activeSource: HandFrameSource = mouse;
  let showMarkers: boolean = DEBUG.showSourceMarkers;
  let loop: FixedStepLoop | null = null;
  /** The browser's own words about the last camera failure, kept for the HUD. */
  let lastDiagnostic: string | null = null;
  /** One camera start at a time; a double press must not open two prompts. */
  const startGuard = createStartGuard();

  /**
   * Gesture pipeline, shared by every source (§11.6).
   *
   * The simulator runs through the same identity and gesture stages as the camera,
   * which is what M0 required of it: "a camera denied" must not also mean "no
   * gesture to test with". Identity is per-source because the two never run at
   * once, but the shape of the data is identical either way.
   */
  const gestures = new GestureController(resolveGestureMethod());
  /**
   * Observed gesture frames, for on-device threshold tuning (PLAN.md §11.5).
   *
   * Kept separate from the gameplay path: it only reads, and only when a hand was
   * genuinely observed.
   */
  const gestureCapture = new HandFrameCapture(GESTURE_SELECTION.captureFrames);

  /**
   * Record one **observation** per distinct detection into the capture buffer (§11.5).
   *
   * Called only from the `observe()` paths, which is what makes the 150-frame buffer mean
   * 150 observations. It previously ran from `render()`, so a real capture filled up with
   * ~12 repeated render callbacks per detection: the attached device capture had 150
   * "frames" that were really **12** observations, each repeated 10-15 times.
   */
  function recordGestureCapture(
    frame: GestureFrame,
    tracked: readonly TrackedHand[],
    atMs: number,
  ): void {
    for (const hand of frame.hands) {
      if (hand.geometry === null) continue;
      const source = tracked.find((candidate) => candidate.identity === hand.identity);
      if (source === undefined) continue;

      const pip: Record<string, number | null> = {};
      const chord: Record<string, number | null> = {};
      const chain: Record<string, number | null> = {};
      const reliable: Record<string, boolean> = {};
      const basis: Record<string, string> = {};
      for (const name of ['index', 'middle', 'ring', 'pinky'] as const) {
        const measure = hand.alternate.measures[name];
        pip[name] = measure.pipAngleDeg;
        chord[name] = measure.chordRatio;
        chain[name] = measure.chainRatio;
        reliable[name] = measure.reliable;
        basis[name] = measure.basis;
      }

      gestureCapture.record({
        tMs: atMs,
        identity: hand.identity,
        handednessLabel: source.handedness.label,
        handednessScore: source.handedness.score,
        // Copied, so a later observation cannot mutate what was captured.
        landmarks: source.landmarks.map((point) => ({ ...point })),
        distance: {
          span: hand.geometry.span,
          middleToPalm: hand.geometry.middleToPalm,
          ringToPalm: hand.geometry.ringToPalm,
          indexExt: hand.geometry.indexExt,
          pinkyExt: hand.geometry.pinkyExt,
        },
        angle: { pip, chord, chain, reliable, basis },
        verdict: {
          distanceGesture:
            hand.method === 'distance' ? hand.pose.isGesture : hand.alternate.pose.isGesture,
          distanceScore: hand.method === 'distance' ? hand.rawScore : hand.alternate.score,
          angleGesture:
            hand.method === 'angle' ? hand.pose.isGesture : hand.alternate.pose.isGesture,
          angleScore: hand.method === 'angle' ? hand.rawScore : hand.alternate.score,
          method: hand.method,
        },
      });
    }
  }
  /** Button-driven, because a phone has no keyboard. */
  const capturePanel = new CapturePanel({
    capture: gestureCapture,
    elements: {
      captureButton: requireElement(
        'capture-button',
        (element): element is HTMLButtonElement => element instanceof HTMLButtonElement,
        'capture button',
      ),
      downloadButton: requireElement(
        'capture-download',
        (element): element is HTMLButtonElement => element instanceof HTMLButtonElement,
        'capture download button',
      ),
      clearButton: requireElement(
        'capture-clear',
        (element): element is HTMLButtonElement => element instanceof HTMLButtonElement,
        'capture clear button',
      ),
      output: requireElement(
        'capture-output',
        (element): element is HTMLTextAreaElement => element instanceof HTMLTextAreaElement,
        'capture output',
      ),
      status: requireElement(
        'capture-status',
        (element): element is HTMLElement => element instanceof HTMLElement,
        'capture status',
      ),
      labels: requireElement(
        'capture-labels',
        (element): element is HTMLElement => element instanceof HTMLElement,
        'capture label picker',
      ),
    },
    now: () => new Date(),
    url: () => globalThis.location.href,
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => {
      URL.revokeObjectURL(url);
    },
  });
  // Refresh on a slow timer so the count reflects live frames without the render loop
  // touching the DOM 60 times a second.
  globalThis.setInterval(() => {
    capturePanel.refresh();
  }, 1000);
  const handRender = new HandRenderPipeline();
  let simulatorIdentity = new HandIdentityTracker({
    sourceWidth: SOURCE.width,
    sourceHeight: SOURCE.height,
  });
  /** Fires observed this session, for the HUD's event count. */
  let gestureFires = 0;
  let lastGestureEvent: GestureEvent | null = null;
  /**
   * Targets, webs and hits (§12).
   *
   * The field follows the canvas aspect, so a target covers the same visual area
   * whether the source is the 640x480 simulator or a 1280x720 camera.
   */
  const game = new GameState({ aspect: SOURCE.width / SOURCE.height, seed: 1 });
  let lastFire: FireOutcome | null = null;
  /** Replay counter, so `R` produces a genuinely different field each time. */
  let replayCount = 1;

  /** A different deterministic seed per replay, so the field visibly changes. */
  function seedForReplay(): number {
    replayCount += 1;
    return replayCount * 7919;
  }

  function setNotice(message: string | null): void {
    notice.textContent = message ?? '';
    notice.hidden = message === null;
  }

  /**
   * Tell the player what happened and hand them a playable alternative.
   *
   * §13 M1 is explicit that a denied camera is not an error screen: the simulator
   * is a supported way to play. Every failure here is recoverable, which is why
   * there is no terminal path.
   */
  function fallBackToSimulator(failure: CameraFailure | string): void {
    const message = typeof failure === 'string' ? failure : failure.message;
    setNotice(message);
    measurement.recordFallback(message, globalThis.performance.now());
    selectSource(MOUSE_SOURCE_ID);
  }

  function selectSource(id: string): void {
    const next =
      id === CAMERA_SOURCE_ID
        ? (camera?.source ?? mouse)
        : id === REPLAY_SOURCE_ID
          ? replay
          : mouse;
    if (next === activeSource) return;
    activeSource.stop();
    activeSource = next;
    activeSource.start(globalThis.performance.now());

    // Per-source state must not leak across a switch. A replay clip continuing a
    // simulator hand's identity (or its armed gesture latch) would attribute one
    // source's motion to another, and the interpolator would derive velocity from
    // two unrelated positions.
    simulatorIdentity = new HandIdentityTracker({
      sourceWidth: SOURCE.width,
      sourceHeight: SOURCE.height,
    });
    gestures.reset();
    handRender.reset();
  }

  // --------------------------------------------------------- camera session ---

  function clearPendingPlayback(): void {
    const pending = pendingPlayback;
    pendingPlayback = null;
    pending?.release();
  }

  /**
   * Release everything the camera holds: the frame clock, the model, the stream,
   * the element. Safe to call when it holds nothing.
   *
   * Every permanent camera failure routes through here, so no path can leave the
   * camera light on or a composited element in the document.
   */
  function teardownCamera(): void {
    clearPendingPlayback();
    const session = camera;
    camera = null;
    latestTracked = [];
    if (session === null) return;
    session.clock.stop();
    session.backend.close();
    releaseCamera(cameraEnvironment, session);
    if (activeSource === session.source) selectSource(MOUSE_SOURCE_ID);
  }

  /** Reflect the current camera state on the button. */
  function updateCameraButton(): void {
    if (pendingPlayback !== null) {
      cameraButton.textContent = 'Resume video';
      cameraButton.disabled = startGuard.busy;
      return;
    }
    if (camera !== null) {
      cameraButton.textContent = 'Camera running';
      cameraButton.disabled = true;
      return;
    }
    cameraButton.textContent = 'Start camera';
    cameraButton.disabled = startGuard.busy;
  }

  /** Build the live session once playback is actually running. */
  function applyCameraSession(
    parts: CameraSessionParts<HTMLVideoElement>,
    backend: DetectionBackend,
  ): void {
    // Rule A: adopt the camera's real intrinsic size, which also re-fits the CSS.
    syncCanvasBackingStore(canvas, parts.width, parts.height);
    // Two sessions on the same machine differed by 2.4x in inference cost, and a
    // different negotiated resolution is the leading explanation. Record it.
    measurement.recordCaptureSize(canvas.width, canvas.height);
    // The A/B is meaningless without this: `detectionCostMs` means blocking time on
    // the main thread and the worker's own processing time in a worker.
    measurement.recordBackend(backend.kind);
    // The delegate is only known after init, and a GPU → CPU fallback is the
    // likeliest cause of a large detection-cost change, so it is recorded with the
    // session rather than only announced once in a transient notice.
    measurement.recordDelegate(backend.delegate, backend.delegateFallback, backend.delegateMessage);

    const source = new CameraHandSource(backend);
    const identity = new HandIdentityTracker({
      sourceWidth: canvas.width,
      sourceHeight: canvas.height,
    });
    const scheduler = new InferenceScheduler({
      minInferenceHz: INFERENCE.minInferenceHz,
      maxInferenceHz: INFERENCE.maxInferenceHz,
      inferenceBudgetFraction: INFERENCE.inferenceBudgetFraction,
      costEmaAlpha: INFERENCE.costEmaAlpha,
      initialCostEstimateMs: INFERENCE.initialCostEstimateMs,
    });

    const session: CameraSession = {
      video: parts.video,
      stream: parts.stream,
      backend,
      source,
      identity,
      scheduler,
      clock: createFrameClock(parts.video, globalThis, (nowMs) => {
        void inferIfDue(nowMs);
      }),
    };
    camera = session;

    if (backend.delegateFallback) {
      measurement.recordFallback(
        backend.delegateMessage ?? 'delegate fallback',
        globalThis.performance.now(),
      );
    }

    source.start(globalThis.performance.now());
    activeSource = source;
    session.clock.start();
  }

  /**
   * Load the model, releasing the camera and falling back if it cannot start.
   *
   * Deliberately ordered after playback: there is no point loading a 7 MB model
   * for a camera that is not going to display anything.
   */
  /** `?inference=worker|main-thread`, falling back to the configured default. */
  function resolveDetectionMode(): DetectionMode {
    const requested = new URLSearchParams(globalThis.location.search).get('inference');
    if (requested === 'worker' || requested === 'main-thread') return requested;
    return DETECTION_MODE;
  }

  /**
   * Where the inference request came from: the URL, or `config.ts`'s default.
   *
   * Reported alongside the effective mode so a forced request can be seen to have
   * been honoured — or not — instead of being inferred from a default.
   */
  function inferenceRequestSource(): string {
    const raw = new URLSearchParams(globalThis.location.search).get('inference');
    return raw === 'worker' || raw === 'main-thread'
      ? `url ?inference=${raw}`
      : `config default`;
  }

  /**
   * Build the detector for the selected mode.
   *
   * The two are interchangeable behind `DetectionBackend`, which is what makes the
   * §7.3 A/B a configuration change rather than a rewrite. The default is the
   * measured main-thread baseline, so an unproven worker cannot regress the app.
   */
  function createBackend(): DetectionBackend {
    const config: HandLandmarkerConfig = {
      wasmBasePath: MEDIAPIPE.wasmBasePath,
      modelAssetPath: MEDIAPIPE.modelAssetPath,
      numHands: MEDIAPIPE.numHands,
      minHandDetectionConfidence: MEDIAPIPE.minHandDetectionConfidence,
      minHandPresenceConfidence: MEDIAPIPE.minHandPresenceConfidence,
      minTrackingConfidence: MEDIAPIPE.minTrackingConfidence,
    };

    if (resolveDetectionMode() === 'worker') {
      return new WorkerDetectionBackend({
        createWorker: () => new InferenceWorker(),
        config,
        preferredDelegate: MEDIAPIPE.preferredDelegate,
        swapHandedness: MEDIAPIPE.swapHandedness,
        initTimeoutMs: INFERENCE.workerInitTimeoutMs,
        detectTimeoutMs: INFERENCE.workerDetectTimeoutMs,
      });
    }

    return new MainThreadDetectionBackend(
      new HandTracker({
        ...config,
        preferredDelegate: MEDIAPIPE.preferredDelegate,
        swapHandedness: MEDIAPIPE.swapHandedness,
      }),
    );
  }

  async function initBackendOrRelease(
    parts: CameraSessionParts<HTMLVideoElement>,
  ): Promise<DetectionBackend | null> {
    const backend = createBackend();

    try {
      await backend.init();
      return backend;
    } catch (error) {
      backend.close();
      releaseCamera(cameraEnvironment, parts);
      fallBackToSimulator(
        `Hand tracking could not start (${error instanceof Error ? error.message : String(error)}). Playing with the hand simulator instead.`,
      );
      return null;
    }
  }

  /**
   * Retry playback for a stream that is live but was refused.
   *
   * **The user-gesture contract:** this function reaches `video.play()` without
   * awaiting anything first, so when it is called from a click handler the play
   * call is still inside that activation. Inserting an `await` above the `resume()`
   * call — even one that looks harmless — would silently break the retry, because
   * the activation would have expired by the time playback is requested.
   */
  async function resumePendingPlayback(): Promise<void> {
    const pending = pendingPlayback;
    if (pending === null) return;
    if (!startGuard.tryEnter()) return;

    try {
      setNotice('Starting the video…');
      const outcome = await pending.resume();

      lastDiagnostic = outcome.ok
        ? outcome.diagnostic
          ? formatDiagnostic(outcome.diagnostic)
          : null
        : outcome.failure.diagnostic
          ? formatDiagnostic(outcome.failure.diagnostic)
          : null;

      if (!outcome.ok) {
        // Keep the stream. Another click may still work, and re-requesting
        // permission would be a worse experience than retrying.
        setNotice(outcome.failure.message);
        return;
      }

      // Ownership of the stream moves to the session from here on. The dimensions
      // come from the retry, because a session that had no picture before it may
      // well have one now.
      pendingPlayback = null;
      const confirmed: CameraSessionParts<HTMLVideoElement> = {
        stream: pending.stream,
        video: pending.video,
        width: outcome.width,
        height: outcome.height,
      };
      const backend = await initBackendOrRelease(confirmed);
      if (backend === null) return;
      applyCameraSession(confirmed, backend);
      setNotice(
        outcome.diagnostic
          ? `Video started after a retry (${formatDiagnostic(outcome.diagnostic)}).`
          : null,
      );
    } catch (error) {
      teardownCamera();
      setNotice(
        `Starting the video failed unexpectedly (${error instanceof Error ? error.message : String(error)}). Playing with the hand simulator instead.`,
      );
    } finally {
      startGuard.exit();
      updateCameraButton();
    }
  }

  /**
   * Start the camera, the tracker and the inference loop.
   *
   * The button doubles as Resume: if a stream is already live and only the gesture
   * is missing, this retries playback instead of asking for the camera again.
   */
  async function startCameraFlow(): Promise<void> {
    if (pendingPlayback !== null) {
      await resumePendingPlayback();
      return;
    }
    if (camera !== null) {
      selectSource(CAMERA_SOURCE_ID);
      return;
    }
    if (!startGuard.tryEnter()) {
      setNotice('The camera is already starting…');
      return;
    }
    updateCameraButton();

    try {
      setNotice('Starting the camera…');
      const result = await startCamera(cameraEnvironment);

      if (result.ok) {
        lastDiagnostic = result.diagnostic ? formatDiagnostic(result.diagnostic) : null;
        const backend = await initBackendOrRelease(result);
        if (backend === null) return;
        applyCameraSession(result, backend);
        setNotice(
          backend.delegateFallback
            ? `Camera running on the ${backend.delegate} delegate. ${backend.delegateMessage ?? ''}`.trim()
            : null,
        );
        return;
      }

      lastDiagnostic = result.failure.diagnostic
        ? formatDiagnostic(result.failure.diagnostic)
        : null;

      // A gesture-recoverable playback failure keeps the stream alive so that the
      // player can fix it with a click, rather than being sent back to the
      // permission prompt.
      if (result.pending) {
        pendingPlayback = result.pending;
        setNotice(result.failure.message);
        return;
      }

      fallBackToSimulator(result.failure);
    } catch (error) {
      // Every *known* failure above releases what it acquired, but an unexpected
      // throw would otherwise leave a live stream and a UI that looks broken. Treat
      // it like any other failure: release, report, offer the simulator.
      teardownCamera();
      fallBackToSimulator(
        `The camera could not be started (${error instanceof Error ? error.message : String(error)}). Playing with the hand simulator instead.`,
      );
    } finally {
      startGuard.exit();
      updateCameraButton();
    }
  }

  /**
   * True while a detection is outstanding.
   *
   * The main-thread path was synchronous, so a second detection could never overlap
   * the first. A worker makes detection a request/response, and starting another
   * while one is in flight would queue work the scheduler never budgeted for and
   * would deliver stale landmarks late.
   */
  let detectionInFlight = false;

  /**
   * One inference opportunity, driven by the frame clock.
   *
   * This is where §7.1 lives: a frame arrives, the scheduler decides whether the
   * device can afford a detection, and the call happens only if it can. Rendering is
   * unaffected by either decision.
   *
   * Two timings are recorded, and the difference between them *is* the worker's cost:
   *
   * - `roundTripMs` — wall time from asking for a detection to holding the result.
   *   This is what the scheduler budgets, because it is the delay the app lives with.
   * - `outcome.costMs` — the backend's own processing time, comparable across modes.
   *
   * For the main thread they are equal. For a worker the round trip is larger by the
   * capture and the two transfers, and the export reports both rather than conflating
   * them.
   */
  async function inferIfDue(nowMs: number): Promise<void> {
    const session = camera;
    if (session === null || detectionInFlight) return;

    session.scheduler.observeFrame(nowMs);
    if (!session.scheduler.shouldRun(nowMs)) return;

    detectionInFlight = true;
    const startedAt = globalThis.performance.now();

    try {
      const outcome = await session.source.detectNow(session.video, nowMs);
      const roundTripMs = globalThis.performance.now() - startedAt;
      session.scheduler.recordRun(roundTripMs, nowMs);

      if (!outcome.ok) {
        // Disabled is a permanent condition for this session, so it gets the same
        // treatment as a start failure: say so, then offer the simulator.
        if (outcome.disabled) {
          // Release everything in one place and hand over the simulator rather than
          // leaving a dead camera running.
          teardownCamera();
          fallBackToSimulator(
            `Hand tracking stopped after repeated failures (${outcome.message}). Playing with the hand simulator instead.`,
          );
        }
        return;
      }

      // A session can be torn down while a detection is in flight; the result is
      // then stale and must not resurrect the hand.
      if (camera !== session) return;

      // Association runs once per detection, on real observations only.
      latestTracked = session.identity.update(outcome.hands, nowMs).hands;
      // The gesture pipeline is driven by **observations**, not render frames (§11.5).
      // This is the only place a camera hand can advance the state machine or fire.
      const observed = gestures.observe(latestTracked, nowMs);
      recordGestureCapture(observed, latestTracked, nowMs);
      gestureFires += observed.events.length;
      for (const event of observed.events) lastGestureEvent = event;
      measurement.recordDetection(outcome.costMs, roundTripMs, nowMs);
    } catch (error) {
      // `detectNow` handles its own failure policy, so reaching here means something
      // outside it broke. Count it rather than losing the session silently.
      session.scheduler.recordRun(globalThis.performance.now() - startedAt, nowMs);
      measurement.recordFallback(
        `detection threw: ${error instanceof Error ? error.message : String(error)}`,
        globalThis.performance.now(),
      );
    } finally {
      detectionInFlight = false;
    }
  }

  // ------------------------------------------------------------------ input ---

  function pointerToCanvasPx(event: PointerEvent): Vec2 | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  /** Pointer -> normalized video space, the inverse of `toCanvas()` (§8 Rule E). */
  function pointerToNormalized(event: PointerEvent): Vec2 | null {
    const pixel = pointerToCanvasPx(event);
    if (pixel === null) return null;
    return toNormalized(pixel, canvas.width, canvas.height);
  }

  canvas.addEventListener('pointermove', (event) => {
    const normalized = pointerToNormalized(event);
    if (normalized !== null) mouse.setPointer(normalized);
  });

  canvas.addEventListener('pointerdown', (event) => {
    const normalized = pointerToNormalized(event);
    if (normalized !== null) mouse.setPointer(normalized, true);
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  const endPointer = (event: PointerEvent): void => {
    const normalized = pointerToNormalized(event);
    if (normalized !== null) mouse.setPointer(normalized);
    mouse.setPressed(false);
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  /** Write the §7.3 measurement report to a file the human can hand back. */
  function exportMeasurements(): void {
    // The scheduler's counters explain the achieved rate: rate cap, budget refusal
    // or floor. Without them "5.5 Hz" cannot be interpreted.
    const stats = camera?.scheduler.stats;
    const scheduler = stats
      ? {
          inferenceHz: stats.inferenceHz,
          predictedCostMs: stats.predictedCostMs,
          frameBudgetMs: stats.frameBudgetMs,
          runs: stats.runs,
          skipsRateCap: stats.skipsRateCap,
          skipsOverBudget: stats.skipsOverBudget,
          forcedRuns: stats.forcedRuns,
        }
      : null;
    const json = measurement.toJson(globalThis.performance.now(), scheduler);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'web-slinger-m1-measurements.json';
    anchor.click();
    URL.revokeObjectURL(url);
    setNotice('Measurement report downloaded. Send it back to decide the worker question.');
  }

  /**
   * The button handler is a genuine user activation, which is what playback may
   * require. `startCameraFlow` reaches `video.play()` before its first `await` on
   * the resume path, so the activation is still valid when playback is requested.
   * Never synthesize an activation instead — see the note on `resumePendingPlayback`.
   */
  cameraButton.addEventListener('click', () => {
    void startCameraFlow();
  });
  updateCameraButton();

  globalThis.addEventListener('keydown', (event) => {
    switch (event.key.toLowerCase()) {
      case '1':
        selectSource(MOUSE_SOURCE_ID);
        break;
      case '2':
        selectSource(REPLAY_SOURCE_ID);
        break;
      // The camera starts on an explicit key rather than automatically, so the
      // permission prompt follows a deliberate action (§3.1).
      case 'c':
        void startCameraFlow();
        break;
      case 'h':
        mouse.toggleHandedness();
        break;
      case 'm':
        showMarkers = !showMarkers;
        break;
      case 'e':
        exportMeasurements();
        break;
      // §12.3 replay: a fresh field and a fresh round.
      case 'r':
        game.respawn(seedForReplay());
        lastFire = null;
        setNotice('Fresh round — alternating hands, any hand may start.');
        break;
      // Explicit release, so the camera indicator is not left on while playing
      // with the simulator.
      case 'x':
        teardownCamera();
        setNotice('Camera stopped.');
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  /**
   * Rule D: never cache canvas dimensions. With a live camera this re-reads the
   * video's intrinsic size; without one it is a no-op against the placeholder.
   */
  function resyncStage(): void {
    const session = camera;
    if (session === null) {
      syncCanvasBackingStore(canvas, SOURCE.width, SOURCE.height);
      return;
    }
    const width = session.video.videoWidth;
    const height = session.video.videoHeight;
    if (!(width > 0) || !(height > 0)) return;
    syncCanvasBackingStore(canvas, width, height);
    // Distance thresholds are expressed against the source diagonal, so they have
    // to follow a rotation. Identity state itself is preserved.
    session.identity.setSourceSize(canvas.width, canvas.height);
  }
  globalThis.addEventListener('orientationchange', resyncStage);
  globalThis.addEventListener('resize', resyncStage);

  // Do not rely on the browser to tear the camera down: an explicit stop also
  // clears the indicator on mobile when the tab is backgrounded.
  globalThis.addEventListener('pagehide', () => {
    longFrames.disconnect();
    teardownCamera();
  });

  // ----------------------------------------------------------------- render ---

  /** Stand-in for the camera frame, used by the simulator and replay sources. */
  function drawPlaceholderStage(): void {
    ctx.fillStyle = RENDER.stageColor;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!showMarkers) return;

    ctx.fillStyle = RENDER.markerColor;
    for (const corner of [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
      { x: 1, y: 1 },
    ]) {
      const point = toCanvas(corner, canvas.width, canvas.height);
      ctx.beginPath();
      ctx.arc(point.x, point.y, RENDER.markerRadiusPx, 0, Math.PI * 2);
      ctx.fill();
    }

    // Only (0,0) is labelled: an asymmetric label is what makes a mirroring error
    // visible at a glance. After `toCanvas()`, video (0,0) must be on the RIGHT.
    const origin = toCanvas({ x: 0, y: 0 }, canvas.width, canvas.height);
    ctx.fillStyle = RENDER.hudColor;
    ctx.font = RENDER.markerFont;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('video (0,0) - mirrored', origin.x - 12, 12);
    ctx.textAlign = 'left';
  }

  function sourceStats(nowMs: number): HudSourceStats | undefined {
    const session = camera;
    if (session === null || activeSource !== session.source) return undefined;

    const stats = session.identity.stats;
    return {
      framesSinceDetection: session.source.framesDrawnSinceDetection,
      msSinceDetection: session.source.msSinceDetection(nowMs),
      isStale: session.source.isStale(nowMs),
      // M1 does not extrapolate between detections, so this is honestly zero
      // rather than a feature that quietly does not exist (§7.2).
      interpolated: false,
      crossings: stats.crossings,
      losses: stats.losses,
      reacquisitions: stats.reacquisitions,
      handednessConflicts: stats.handednessConflicts,
      inCrossing: stats.inCrossing,
      frameClock: session.clock.kind,
      consecutiveDetectFailures: session.source.consecutiveFailures,
      longFrames: measurement.longFrameStats,
      frameClockKind: longFrames.kind,
      // Reading these is the whole point of the M1 observability gap being closed:
      // the source has always known where detection ran and which delegate it got,
      // and none of it reached the HUD.
      backendKind: session.source.backendKind,
      ...(session.source.delegate === null ? {} : { delegate: session.source.delegate }),
      delegateFallback: session.source.delegateFallback,
      delegateMessage: session.source.delegateMessage,
      requestedInference: resolveDetectionMode(),
      inferenceRequestSource: inferenceRequestSource(),
      configuredInference: DETECTION_MODE,
    };
  }

  function render(alpha: number, nowMs: number): void {
    const session = camera;
    const cameraActive = session !== null && activeSource === session.source;

    if (cameraActive && session !== null) {
      drawMirroredVideo(ctx, session.video, canvas.width, canvas.height);
    } else {
      drawPlaceholderStage();
    }

    /**
     * One tracked frame for both source kinds.
     *
     * The simulator goes through the identity tracker too, so the gesture path
     * below is identical whether hands came from the camera or from the mouse. That
     * is what lets the gesture be exercised without a camera (§13 M0's "same public
     * interface a real tracker will produce").
     */
    let tracked: readonly TrackedHand[];
    if (cameraActive) {
      tracked = latestTracked;
      if (tracked.length > 0 && session.source.isStale(nowMs)) {
        measurement.recordStaleFrame();
      }
    } else {
      const simulated = activeSource.frameAt(nowMs)?.hands ?? [];
      tracked = simulated.length > 0 ? simulatorIdentity.update(simulated, nowMs).hands : [];
    }

    /**
     * Gesture state for this render frame.
     *
     * The two source kinds genuinely differ in cadence, and the code now says so:
     *
     * - **Camera**: observations arrive at the detection rate (~4.7 Hz), *not* per render
     *   frame. Render frames only **read** the state. This is the fix for a measured bug:
     *   previously every render frame advanced the state machine over the same reused
     *   `latestTracked`, so ~12 render steps per observation satisfied `HOLD_MS` (150 ms)
     *   from a *single* observation and fired on one glimpse of the pose.
     * - **Simulator / replay**: the synthetic source produces genuinely new landmarks on
     *   each call, so every render frame *is* a fresh observation and `observe()` is right.
     */
    gestures.setAspect(canvas.width / canvas.height);
    let gestureFrame: GestureFrame;
    if (cameraActive) {
      gestureFrame = gestures.renderFrame(nowMs);
    } else {
      gestureFrame = gestures.observe(tracked, nowMs);
      recordGestureCapture(gestureFrame, tracked, nowMs);
    }
    for (const event of gestureFrame.events) {
      gestureFires += 1;
      lastGestureEvent = event;
      // Fire at a target (§12.1). The aim uses the *observed* palm, wrist and index
      // tip from this frame — never the interpolated positions, which exist only to
      // be drawn (§7.2).
      const source = tracked.find((hand) => hand.identity === event.identity);
      if (source !== undefined) {
        const aimHand = {
          palmCenter: source.palmCenter,
          wrist: source.landmarks[Landmark.WRIST] ?? source.palmCenter,
          indexTip: source.landmarks[Landmark.INDEX_TIP] ?? source.palmCenter,
        };
        // §12.4 keys on the hand the player is *using*. That is the reported
        // handedness label, which §10.1 names the primary signal, rather than the
        // tracker slot — the slot is position-driven, so the simulator's `H` toggle
        // reconciles into the same slot and could not express a hand switch.
        const scoringHand: HandIdentityId =
          source.handedness.label === 'Left' ? 'left' : 'right';
        lastFire = game.fire(aimHand, { origin: event.identity, scoringHand }, nowMs);
      }
    }

    // §7.2: only *observed* hands are fed to the render pipeline. A stale hand's
    // positions are the tracker's frozen copy, and treating those as movement is
    // exactly the drift §7.2 forbids.
    for (const hand of tracked) {
      if (hand.isStale) continue;
      const smoothed = gestures.smoothedForRender(hand.identity) ?? hand.landmarks;
      handRender.observe(hand.identity, smoothed, nowMs);
    }
    for (const identity of ['left', 'right'] as const) {
      if (!tracked.some((hand) => hand.identity === identity)) handRender.forget(identity);
    }

    const drawable = handRender.advance(nowMs);
    const hands: readonly RawHandFrame[] = drawable.map((hand) => ({
      landmarks: hand.landmarks,
      // The label travels with the drawn hand so `drawHands` can colour it; it is
      // the identity's last observed handedness, not a new claim about the model.
      handedness:
        tracked.find((trackedHand) => trackedHand.identity === hand.identity)?.handedness ??
        { label: hand.identity === 'left' ? 'Left' : 'Right', score: 0 },
    }));

    const dots = hands.length > 0 ? drawHands(ctx, hands, canvas.width, canvas.height) : 0;

    // ------------------------------------------------- targets and webs (§12) ---
    // Drawn after the hands so a web visibly leaves the palm, and before the HUD
    // so the readout stays legible.
    const aspect = canvas.width / canvas.height;
    drawTargetsAndWebs(
      ctx,
      game.targets.all(),
      game.webStates(nowMs),
      canvas.width,
      canvas.height,
      nowMs,
      aspect,
    );
    // The reticle snaps to the target auto-aim has chosen, so the player can see
    // what they are about to hit (§12.1).
    const aimed = game.aimedTarget(aimHandFor(gestureFrame));
    if (aimed !== null) {
      drawReticle(
        ctx,
        aimed.center,
        targetRadiusPx(aimed, canvas.width, canvas.height),
        canvas.width,
        canvas.height,
      );
    }
    if (cameraActive) {
      // The hand count goes with the frame so an export can distinguish a tracker
      // that is working from one that is reporting nothing.
      measurement.recordFrame(loop?.stats.lastFrameMs ?? 0, nowMs, hands.length);
    }

    if (!DEBUG.showHud) return;

    // §12.3: a won round shows a win screen with replay. Drawn before the HUD so
    // the readout still sits on top of it.
    if (game.round.won) {
      drawWinScreen(ctx, canvas.width, canvas.height, game.round.scored, game.round.total);
    }

    const extraLines: string[] = [];
    if (activeSource === mouse) {
      extraLines.push(
        `sim hand ${mouse.handedness}   curl ${mouse.currentCurl.toFixed(2)}`,
      );
    }
    if (session === null) {
      extraLines.push('camera off - use Start camera, or press C');
    }
    if (lastDiagnostic !== null) {
      // The browser's own words, kept verbatim and visible: a generic failure
      // message is undiagnosable, which is exactly how this bug survived a first
      // round of testing.
      extraLines.push(`camera diagnostic: ${lastDiagnostic}`);
    }

    // ------------------------------------------------- gesture debug (§11) ---
    // Per-hand state and the live thresholds, so M2's tuning can be done by
    // watching a real hand rather than by editing `config.ts` and rebuilding.
    extraLines.push(`classifier: ${gestures.activeMethod} (change with ?gesture=angle)`);
    for (const hand of gestureFrame.hands) {
      const g = hand.geometry;
      const measured = g
        ? `mid ${g.middleToPalm.toFixed(2)} ring ${g.ringToPalm.toFixed(2)} idx ${g.indexExt.toFixed(2)} pky ${g.pinkyExt.toFixed(2)}`
        : 'unmeasurable';
      const flags = [
        hand.frozen ? 'STALE' : null,
        hand.rearmBlocked ? 'rearm-block' : null,
        hand.suppressedByHold ? 'held(suppressed)' : null,
      ].filter((flag): flag is string => flag !== null);
      extraLines.push(
        `${hand.identity.padEnd(5)} ${hand.state.padEnd(8)} score ${hand.score.toFixed(2)} (raw ${hand.rawScore.toFixed(2)})  ${measured}${flags.length > 0 ? '  [' + flags.join(' ') + ']' : ''}`,
      );
      if (hand.cooldownRemainingMs > 0) {
        extraLines.push(`      cooldown ${Math.round(hand.cooldownRemainingMs)} ms remaining`);
      }

      // §11.5: both classifiers on the same observed frame, so they can be compared
      // without a rebuild. The inactive one is reported only; it cannot fire.
      const pipOf = (name: FingerName): string => {
        const measure = hand.alternate.measures[name];
        return measure.pipAngleDeg === null ? '--' : measure.pipAngleDeg.toFixed(0);
      };
      const basisOf = (name: FingerName): string => hand.alternate.measures[name].basis;
      extraLines.push(
        `      alt ${hand.alternate.method.padEnd(8)} ${hand.alternate.pose.isGesture ? 'GESTURE' : '       '} score ${hand.alternate.score.toFixed(2)}  PIP mid ${pipOf('middle')} ring ${pipOf('ring')} idx ${pipOf('index')} pky ${pipOf('pinky')} (${basisOf('middle')}, reliable ${(hand.alternate.reliableFraction * 100).toFixed(0)}%)`,
      );
    }
    if (gestureFires > 0) {
      extraLines.push(
        `gesture fires ${gestureFires}${lastGestureEvent ? `   last: ${lastGestureEvent.identity} at score ${lastGestureEvent.score.toFixed(2)}` : ''}`,
      );
    }
    // §7.2 requires the interpolated count to be stated separately from inference
    // rate, so the two can never be read as the same thing.
    extraLines.push(
      `interpolated frames drawn since last detection ${handRender.interpolatedFrames}   thresholds fold<${GESTURE.foldEnter}/>${GESTURE.foldExit} ext>${GESTURE.extEnter}/<${GESTURE.extExit} minScore ${GESTURE.minGestureScore}`,
    );

    // --------------------------------------------------- targets (§12.3) ---
    extraLines.push(
      `targets ${game.targets.remaining} of ${game.targets.all().length} remaining   webs ${game.liveWebs(nowMs).length}   hits ${game.hits}   misses ${game.misses}${game.round.won ? '   ROUND WON' : ''}`,
    );
    // §12.4: the HUD shows which hand is next.
    const next = game.round.requiredHand;
    extraLines.push(
      `score ${game.round.scored} of ${game.round.total}   next hand: ${next ?? (game.round.won ? '— round won, press R to replay' : 'either')}   wrong-hand fires ${game.round.wrongHandFires}`,
    );
    if (lastFire !== null && lastFire.verdict === 'wrong-hand') {
      extraLines.push('wrong hand — that shot did not count (switch hands, or release and re-pose)');
    }
    if (aimed !== null) {
      extraLines.push(`aim: target ${aimed.id}${lastFire?.hit ? `   last hit: target ${lastFire.hit.id}` : ''}`);
    } else if (lastFire !== null && lastFire.hit === null) {
      extraLines.push('aim: none — last fire missed');
    }

    const inference =
      cameraActive && session !== null
        ? {
            hz: session.scheduler.stats.inferenceHz,
            lastCostMs: session.scheduler.stats.lastCostMs,
            predictedCostMs: session.scheduler.stats.predictedCostMs,
            frameBudgetMs: session.scheduler.stats.frameBudgetMs,
            runs: session.scheduler.stats.runs,
            skipsOverBudget: session.scheduler.stats.skipsOverBudget,
            forcedRuns: session.scheduler.stats.forcedRuns,
          }
        : undefined;

    // ------------------------------------------------- diagnostics (M1/M2) ---
    // Deliberately grouped and labelled, and kept out of the gameplay path: these
    // lines exist to answer "is it running where I asked, with which delegate, and
    // what are the raw gesture measurements?" from a screenshot, because the first
    // real playtest could not answer any of the three.
    extraLines.push(
      `diagnostics: inference requested ${resolveDetectionMode()} (${inferenceRequestSource()})   running ${cameraActive ? (session?.source.backendKind ?? 'unknown') : 'n/a (simulator)'}   delegate ${cameraActive ? (session?.source.delegate ?? 'unknown') + (session?.source.delegateFallback ? ' (CPU FALLBACK)' : '') : 'n/a'}`,
    );
    if (cameraActive && session !== null) {
      extraLines.push(
        `diagnostics: capture ${canvas.width}x${canvas.height}   frame budget ${Math.round(session.scheduler.stats.frameBudgetMs)} ms (${(1000 / Math.max(1, session.scheduler.stats.frameBudgetMs)).toFixed(1)} Hz source)`,
      );
    }

    // Computed once: it used to be called twice per frame, which was harmless for
    // an object literal and would not have been once it did real work.
    const source = sourceStats(nowMs);
    const stats: HudStats = {
      sourceId: activeSource.id,
      provenance: activeSource.provenance,
      fps: loop?.stats.fps ?? 0,
      lastFrameMs: loop?.stats.lastFrameMs ?? 0,
      droppedMs: loop?.stats.droppedMs ?? 0,
      updateSteps: loop?.stats.updateSteps ?? 0,
      alpha,
      handCount: hands.length,
      dotsDrawn: dots,
      // Spread conditionally: `exactOptionalPropertyTypes` forbids passing an
      // explicit `undefined` for an optional field.
      ...(inference ? { inference } : {}),
      ...(source ? { source } : {}),
    };

    drawHud(ctx, stats, extraLines);
  }

  // ------------------------------------------------------------------- boot ---

  // Chrome's own report of frames where rendering was delayed, and which callback
  // caused it. This is the evidence for the worker decision: without it, "inference
  // costs 18% of wall time but no frames are dropped" is an unexplained observation.
  const longFrames = observeLongFrames((sample, atMs) => {
    measurement.recordLongFrame(sample, atMs);
  });

  mouse.start(globalThis.performance.now());

  const requested = new URLSearchParams(globalThis.location.search).get(
    SOURCE_SELECTION.queryParam,
  );
  if (requested === CAMERA_SOURCE_ID) {
    void startCameraFlow();
  } else if (requested === REPLAY_SOURCE_ID) {
    selectSource(REPLAY_SOURCE_ID);
  }

  loop = createFixedStepLoop({
    fixedDtMs: LOOP.fixedDtMs,
    maxFrameMs: LOOP.maxFrameMs,
    maxUpdatesPerFrame: LOOP.maxUpdatesPerFrame,
    fpsWindowFrames: LOOP.fpsWindowFrames,
    update: () => {
      // Intentionally empty: M1 adds tracking, not gameplay. Targets, webs and
      // scoring are M3/M4 (PLAN.md §13).
    },
    render,
  });
  loop.start();
}

main();
