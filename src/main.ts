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
  INFERENCE,
  LOOP,
  MEDIAPIPE,
  MEASUREMENT,
  RENDER,
  SOURCE,
  SOURCE_SELECTION,
} from './config';
import { drawHud, type HudSourceStats, type HudStats } from './debug/hud';
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
import { HandIdentityTracker, type TrackedHand } from './tracking/handIdentity';
import { CameraHandSource, HandTracker } from './tracking/handTracker';
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
  tracker: HandTracker;
  source: CameraHandSource;
  identity: HandIdentityTracker;
  scheduler: InferenceScheduler;
  clock: FrameClock;
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
    session.tracker.close();
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
    tracker: HandTracker,
  ): void {
    // Rule A: adopt the camera's real intrinsic size, which also re-fits the CSS.
    syncCanvasBackingStore(canvas, parts.width, parts.height);

    const source = new CameraHandSource(tracker);
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
      tracker,
      source,
      identity,
      scheduler,
      clock: createFrameClock(parts.video, globalThis, (nowMs) => {
        inferIfDue(nowMs);
      }),
    };
    camera = session;

    if (tracker.stats.delegateFallback) {
      measurement.recordFallback(
        tracker.stats.delegateMessage ?? 'delegate fallback',
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
  async function initTrackerOrRelease(
    parts: CameraSessionParts<HTMLVideoElement>,
  ): Promise<HandTracker | null> {
    const tracker = new HandTracker({
      wasmBasePath: MEDIAPIPE.wasmBasePath,
      modelAssetPath: MEDIAPIPE.modelAssetPath,
      numHands: MEDIAPIPE.numHands,
      minHandDetectionConfidence: MEDIAPIPE.minHandDetectionConfidence,
      minHandPresenceConfidence: MEDIAPIPE.minHandPresenceConfidence,
      minTrackingConfidence: MEDIAPIPE.minTrackingConfidence,
      preferredDelegate: MEDIAPIPE.preferredDelegate,
      swapHandedness: MEDIAPIPE.swapHandedness,
    });

    try {
      await tracker.init();
      return tracker;
    } catch (error) {
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

      // Ownership of the stream moves to the session from here on.
      pendingPlayback = null;
      const tracker = await initTrackerOrRelease(pending);
      if (tracker === null) return;
      applyCameraSession(pending, tracker);
      setNotice(
        outcome.diagnostic
          ? `Video started after a retry (${formatDiagnostic(outcome.diagnostic)}).`
          : null,
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
        const tracker = await initTrackerOrRelease(result);
        if (tracker === null) return;
        applyCameraSession(result, tracker);
        setNotice(
          tracker.stats.delegateFallback
            ? `Camera running on the ${tracker.stats.delegate} delegate. ${tracker.stats.delegateMessage ?? ''}`.trim()
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
    } finally {
      startGuard.exit();
      updateCameraButton();
    }
  }

  /**
   * One inference opportunity, driven by the frame clock.
   *
   * This is where §7.1 lives: a frame arrives, the scheduler decides whether the
   * device can afford a detection, and the synchronous call happens only if it can.
   * Rendering is unaffected by either decision.
   */
  function inferIfDue(nowMs: number): void {
    const session = camera;
    if (session === null) return;

    session.scheduler.observeFrame(nowMs);
    if (!session.scheduler.shouldRun(nowMs)) return;

    const startedAt = globalThis.performance.now();
    const outcome = session.source.detectNow(session.video, nowMs);
    const costMs = globalThis.performance.now() - startedAt;
    session.scheduler.recordRun(costMs, nowMs);

    if (!outcome.ok) {
      // Disabled is a permanent condition for this session, so it gets the same
      // treatment as a start failure: say so, then offer the simulator.
      if (outcome.disabled) {
        // Permanent for this session, so release everything in one place and hand
        // over the simulator rather than leaving a dead camera running.
        teardownCamera();
        fallBackToSimulator(
          `Hand tracking stopped after repeated failures (${outcome.message}). Playing with the hand simulator instead.`,
        );
      }
      return;
    }

    // Association runs once per detection, on real observations only.
    latestTracked = session.identity.update(outcome.hands, nowMs).hands;

    // On the main-thread path the result is only observable after the synchronous
    // call returns, so latency and cost coincide. The recorder labels this.
    measurement.recordDetection(costMs, costMs, nowMs);
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
    const json = measurement.toJson(globalThis.performance.now());
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

    let hands: readonly RawHandFrame[];
    if (cameraActive) {
      hands = latestTracked.map((hand) => ({
        landmarks: hand.landmarks,
        handedness: hand.handedness,
      }));
      if (hands.length > 0 && session.source.isStale(nowMs)) {
        measurement.recordStaleFrame();
      }
    } else {
      hands = activeSource.frameAt(nowMs)?.hands ?? [];
    }

    const dots = hands.length > 0 ? drawHands(ctx, hands, canvas.width, canvas.height) : 0;
    if (cameraActive) {
      measurement.recordFrame(loop?.stats.lastFrameMs ?? 0, nowMs);
    }

    if (!DEBUG.showHud) return;

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
