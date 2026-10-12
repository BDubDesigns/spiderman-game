/**
 * Web Slinger — M0 dev harness bootstrap.
 *
 * Scope (PLAN.md §13 M0, §21):
 *   - size a canvas to a placeholder source (Rule A),
 *   - run a fixed-timestep loop whose update is decoupled from rendering,
 *   - pull frames from either the interactive mouse/touch hand simulator or the
 *     JSON replay harness, switchable at runtime,
 *   - draw a dot at every landmark through `toCanvas()`.
 *
 * **No camera. No MediaPipe. No game systems.** Targets, webs and scoring are
 * M3/M4 (PLAN.md §13) and must not appear here.
 *
 * Mirroring (PLAN.md §8 Rule B) is done in exactly one place: `toCanvas()`.
 * At M0 nothing uses a canvas transform at all, because there is no video image
 * yet. M1 adds the mirrored video pass via `setTransform(-1, 0, 0, 1, cw, 0)`,
 * and that transform must be cleared before the HUD is drawn.
 */

import './styles.css';

import replayFixture from '../fixtures/replay-sweep.json';
import { DEBUG, LOOP, RENDER, SOURCE, SOURCE_SELECTION } from './config';
import { drawHud } from './debug/hud';
import { createFixedStepLoop, type FixedStepLoop } from './game/loop';
import { drawHands } from './render/drawHands';
import {
  syncCanvasBackingStore,
  toCanvas,
  toNormalized,
  type Vec2,
} from './render/stage';
import { MouseSource } from './sim/mouseSource';
import { parseReplayClip, ReplaySource } from './sim/replaySource';
import type { HandFrameSource } from './tracking/landmarkTypes';

const MOUSE_SOURCE_ID = 'mouse';
const REPLAY_SOURCE_ID = 'replay';

function requireStageCanvas(): HTMLCanvasElement {
  const canvas = document.getElementById('stage');
  if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('M0 harness: #stage canvas is missing from index.html');
  }
  return canvas;
}

function main(): void {
  const canvas = requireStageCanvas();
  const context = canvas.getContext('2d');
  if (context === null) {
    throw new Error('M0 harness: 2D canvas context is unavailable');
  }
  // Re-bound with a non-nullable type: hoisted function declarations below do not
  // inherit control-flow narrowing, and the context must never be re-fetched.
  const ctx: CanvasRenderingContext2D = context;

  // Rule A: the backing store equals the source's intrinsic dimensions. There is
  // no camera at M0, so the placeholder source stands in for the video.
  syncCanvasBackingStore(canvas, SOURCE.width, SOURCE.height);

  const mouse = new MouseSource({
    sourceWidthPx: canvas.width,
    sourceHeightPx: canvas.height,
  });
  const replay = new ReplaySource(parseReplayClip(replayFixture));

  let activeSource: HandFrameSource = mouse;
  // Explicitly widened: `DEBUG` is `as const`, so this would otherwise be the
  // literal type `true` and could not be toggled.
  let showMarkers: boolean = DEBUG.showSourceMarkers;

  const sourceById = (id: string): HandFrameSource =>
    id === REPLAY_SOURCE_ID ? replay : mouse;

  function selectSource(id: string): void {
    const next = sourceById(id);
    if (next === activeSource) return;
    activeSource.stop();
    activeSource = next;
    activeSource.start(globalThis.performance.now());
  }

  // ---------------------------------------------------------------- input ---

  /** Canvas-space position of a pointer event, or `null` if unlayoutable. */
  function pointerToCanvasPx(event: PointerEvent): Vec2 | null {
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    // The canvas is CSS-scaled (Rule A fits it with CSS only), so the DOM
    // position must be scaled back into backing-store pixels before use.
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  /**
   * Pointer -> normalized video space, i.e. the inverse of `toCanvas()`
   * (PLAN.md §8 Rule E).
   *
   * Routing through the inverse is deliberate: the simulator speaks normalized
   * video space, and `drawHands` converts back through `toCanvas()`. So a hand
   * that appears under the cursor is live evidence that the transform round-trips
   * rather than just evidence that the simulator runs.
   */
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

  globalThis.addEventListener('keydown', (event) => {
    switch (event.key.toLowerCase()) {
      case '1':
        selectSource(MOUSE_SOURCE_ID);
        break;
      case '2':
        selectSource(REPLAY_SOURCE_ID);
        break;
      // Toggles which hand the simulator reports, so both handedness colours can
      // be eyeballed without a camera.
      case 'h':
        mouse.toggleHandedness();
        break;
      // Markers are the visual assertion that mirroring is applied exactly once.
      case 'm':
        showMarkers = !showMarkers;
        break;
      default:
        return;
    }
    event.preventDefault();
  });

  /**
   * Rule D: never cache canvas dimensions. At M0 the source size is a constant,
   * so this is a no-op; in M1 it re-reads the video's intrinsic size. A `true`
   * return means the 2D context was reset and any mirrored-video transform must
   * be re-established before the next draw.
   */
  function resyncStage(): void {
    syncCanvasBackingStore(canvas, SOURCE.width, SOURCE.height);
  }
  globalThis.addEventListener('orientationchange', resyncStage);
  globalThis.addEventListener('resize', resyncStage);

  // --------------------------------------------------------------- render ---

  /** Stand-in for the mirrored video pass that arrives with the camera in M1. */
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

    // Only the (0,0) corner is labelled, because an asymmetric label is what
    // makes a mirroring error visible at a glance: after `toCanvas()`, video
    // (0,0) must appear on the RIGHT. If it is on the left, something flipped
    // twice — or the flip was moved into CSS (Rule B).
    const origin = toCanvas({ x: 0, y: 0 }, canvas.width, canvas.height);
    ctx.fillStyle = RENDER.hudColor;
    ctx.font = RENDER.markerFont;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('video (0,0) - mirrored', origin.x - 12, 12);
    ctx.textAlign = 'left';
  }

  let loop: FixedStepLoop | null = null;

  function render(alpha: number, nowMs: number): void {
    drawPlaceholderStage();

    const frame = activeSource.frameAt(nowMs);
    const hands = frame?.hands ?? [];
    const dots = hands.length > 0 ? drawHands(ctx, hands, canvas.width, canvas.height) : 0;

    if (!DEBUG.showHud) return;

    const extraLines: string[] = [];
    if (activeSource === mouse) {
      extraLines.push(
        `sim hand ${mouse.handedness}   curl ${mouse.currentCurl.toFixed(2)}`,
      );
    }
    extraLines.push('M0 harness: no camera, no inference, no game systems');

    drawHud(
      ctx,
      {
        sourceId: frame?.sourceId ?? activeSource.id,
        provenance: frame?.provenance ?? activeSource.provenance,
        fps: loop?.stats.fps ?? 0,
        lastFrameMs: loop?.stats.lastFrameMs ?? 0,
        droppedMs: loop?.stats.droppedMs ?? 0,
        updateSteps: loop?.stats.updateSteps ?? 0,
        alpha,
        handCount: hands.length,
        dotsDrawn: dots,
      },
      extraLines,
    );
  }

  // ----------------------------------------------------------------- boot ---

  activeSource.start(globalThis.performance.now());

  const requestedSource = new URLSearchParams(globalThis.location.search).get(
    SOURCE_SELECTION.queryParam,
  );
  if (requestedSource !== null) {
    selectSource(requestedSource);
  }

  loop = createFixedStepLoop({
    fixedDtMs: LOOP.fixedDtMs,
    maxFrameMs: LOOP.maxFrameMs,
    maxUpdatesPerFrame: LOOP.maxUpdatesPerFrame,
    fpsWindowFrames: LOOP.fpsWindowFrames,
    update: () => {
      // Intentionally empty. M0 has no game systems: targets, webs and scoring
      // are M3/M4 (PLAN.md §13). The fixed-step loop already runs so the timebase
      // exists before anything depends on it, and the HUD reports the step count
      // so this path is provably live rather than dead code.
    },
    render,
  });
  loop.start();
}

main();
