/**
 * M0 pipeline integration test: source -> transform -> drawn dots.
 *
 * The unit tests each cover one module. This one covers the seam between them,
 * which is where the M0 acceptance criterion actually lives: synthetic landmarks
 * arriving every frame and being drawn at the right place.
 *
 * It substitutes a recording surface for the canvas, so it verifies the same
 * calls `main.ts` makes without needing a browser. The pointer round-trip
 * assertion is the important one — it is an end-to-end check that
 * canvas -> normalized -> hand -> canvas is the identity, i.e. that mirroring is
 * applied exactly once (PLAN.md §8 Rule B, §15 risk #1).
 */

import { describe, expect, it } from 'vitest';

import fixture from '../fixtures/replay-sweep.json';
import { LOOP, SOURCE } from './config';
import { createFixedStepLoop, type Scheduler } from './game/loop';
import { drawHands, type LandmarkDrawSurface } from './render/drawHands';
import { syncCanvasBackingStore, toNormalized } from './render/stage';
import { MouseSource } from './sim/mouseSource';
import { parseReplayClip, ReplaySource } from './sim/replaySource';
import { Landmark, type RawFrame } from './tracking/landmarkTypes';

class RecordingSurface implements LandmarkDrawSurface {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  readonly arcs: Array<{ x: number; y: number }> = [];
  beginPath(): void {}
  arc(x: number, y: number): void {
    this.arcs.push({ x, y });
  }
  fill(): void {}
  clear(): void {
    this.arcs.length = 0;
  }
}

const PALM_INDEX = [
  Landmark.WRIST,
  Landmark.INDEX_MCP,
  Landmark.MIDDLE_MCP,
  Landmark.RING_MCP,
  Landmark.PINKY_MCP,
] as const;

/** A scheduler whose clock only advances when the test pumps it. */
class ManualScheduler implements Scheduler {
  timeMs = 0;
  private nextHandle = 1;
  private readonly pending = new Map<number, (timeMs: number) => void>();

  request(callback: (timeMs: number) => void): number {
    const handle = this.nextHandle;
    this.nextHandle += 1;
    this.pending.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.pending.delete(handle);
  }

  now(): number {
    return this.timeMs;
  }

  /** Advance the clock and deliver the pending frame callback once. */
  step(ms: number): void {
    this.timeMs += ms;
    const due = [...this.pending.values()];
    this.pending.clear();
    for (const callback of due) {
      callback(this.timeMs);
    }
  }
}

describe('M0 pipeline', () => {
  it('sizes the canvas backing store to the source, per Rule A', () => {
    const canvas = { width: 300, height: 150 };
    expect(syncCanvasBackingStore(canvas, SOURCE.width, SOURCE.height)).toBe(true);
    expect(canvas).toEqual({ width: 640, height: 480 });
  });

  it('draws dots at the pointer, proving mirroring is applied exactly once', () => {
    const canvas = { width: SOURCE.width, height: SOURCE.height };
    syncCanvasBackingStore(canvas, SOURCE.width, SOURCE.height);

    const mouse = new MouseSource({
      sourceWidthPx: canvas.width,
      sourceHeightPx: canvas.height,
      wobbleDeg: 0,
    });
    const surface = new RecordingSurface();
    mouse.start(0);

    // Deliberately off-centre: a centred point could not tell a mirror from a
    // no-op, which is exactly how a double-mirror bug hides.
    const pointerPx = { x: 137, y: 92 };
    const normalized = toNormalized(pointerPx, canvas.width, canvas.height);
    mouse.setPointer(normalized);

    const frame = mouse.frameAt(0)!;
    const dots = drawHands(surface, frame.hands, canvas.width, canvas.height);
    expect(dots).toBe(21);

    // The palm centroid of the drawn dots must sit on the pointer.
    let cx = 0;
    let cy = 0;
    for (const index of PALM_INDEX) {
      cx += surface.arcs[index]!.x;
      cy += surface.arcs[index]!.y;
    }
    cx /= PALM_INDEX.length;
    cy /= PALM_INDEX.length;
    expect(cx).toBeCloseTo(pointerPx.x, 6);
    expect(cy).toBeCloseTo(pointerPx.y, 6);
  });

  it('animates: drawn dots follow the pointer across the mirrored stage', () => {
    const canvas = { width: SOURCE.width, height: SOURCE.height };
    syncCanvasBackingStore(canvas, SOURCE.width, SOURCE.height);

    const mouse = new MouseSource({
      sourceWidthPx: canvas.width,
      sourceHeightPx: canvas.height,
      wobbleDeg: 0,
    });
    const surface = new RecordingSurface();
    mouse.start(0);

    const pointerXs: number[] = [];
    const normalizedXs: number[] = [];
    const wristXs: number[] = [];

    for (const fraction of [0.2, 0.4, 0.6, 0.8]) {
      const pointerPx = { x: fraction * canvas.width, y: 0.5 * canvas.height };
      const normalized = toNormalized(pointerPx, canvas.width, canvas.height);

      pointerXs.push(pointerPx.x);
      normalizedXs.push(normalized.x);
      mouse.setPointer(normalized);

      const frame = mouse.frameAt(fraction * 1000)!;
      surface.clear();
      drawHands(surface, frame.hands, canvas.width, canvas.height);
      wristXs.push(surface.arcs[Landmark.WRIST]!.x);
    }

    // On screen the hand follows the pointer to the right...
    for (let i = 1; i < wristXs.length; i += 1) {
      expect(wristXs[i]!).toBeGreaterThan(wristXs[i - 1]!);
    }
    // ...while the value handed to the simulator moves the other way, because
    // normalized video space is mirrored with respect to the stage.
    for (let i = 1; i < normalizedXs.length; i += 1) {
      expect(normalizedXs[i]!).toBeLessThan(normalizedXs[i - 1]!);
    }
    // The wrist keeps a rigid offset from the pointer, so the hand is translated
    // rather than distorted as it moves.
    const offsets = wristXs.map((x, i) => x - pointerXs[i]!);
    expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(0.001);
  });

  it('renders every frame of the replay clip, with no camera provenance', () => {
    const canvas = { width: SOURCE.width, height: SOURCE.height };
    syncCanvasBackingStore(canvas, SOURCE.width, SOURCE.height);

    const clip = parseReplayClip(fixture);
    const replay = new ReplaySource(clip, { loop: false });
    const surface = new RecordingSurface();
    replay.start(0);

    let frames = 0;
    let dots = 0;
    for (const frame of clip.frames) {
      const raw = replay.frameAt(frame.timestampMs);
      expect(raw).not.toBeNull();
      expect(raw!.provenance).toBe('simulated');
      expect(raw!.sourceId).toBe('replay');
      surface.clear();
      dots += drawHands(surface, raw!.hands, canvas.width, canvas.height);
      frames += 1;
    }

    expect(frames).toBe(clip.frames.length);
    expect(dots).toBe(clip.frames.length * 21);
  });

  it('reports the source the loop actually pulls from, with the right provenance', () => {
    const canvas = { width: SOURCE.width, height: SOURCE.height };
    syncCanvasBackingStore(canvas, SOURCE.width, SOURCE.height);
    const mouse = new MouseSource({
      sourceWidthPx: canvas.width,
      sourceHeightPx: canvas.height,
    });

    const seen: Array<RawFrame | null> = [];
    mouse.start(0);
    for (let i = 0; i < 3; i += 1) {
      seen.push(mouse.frameAt(i * 16));
    }
    expect(seen.every((f) => f !== null)).toBe(true);
    expect(seen[0]!.provenance).toBe('simulated');
    expect(seen[0]!.sourceId).toBe('mouse');
  });

  it('drives the real fixed-step loop end to end, with update decoupled from render', () => {
    const canvas = { width: SOURCE.width, height: SOURCE.height };
    syncCanvasBackingStore(canvas, SOURCE.width, SOURCE.height);
    const mouse = new MouseSource({
      sourceWidthPx: canvas.width,
      sourceHeightPx: canvas.height,
    });
    mouse.start(0);
    mouse.setPointer(toNormalized({ x: 320, y: 240 }, canvas.width, canvas.height));

    // Drive the loop with a hand-pumped clock: no real time, no browser.
    const scheduler = new ManualScheduler();

    const surface = new RecordingSurface();
    let framesDrawn = 0;
    let totalDots = 0;

    const loop = createFixedStepLoop({
      fixedDtMs: LOOP.fixedDtMs,
      maxFrameMs: LOOP.maxFrameMs,
      maxUpdatesPerFrame: LOOP.maxUpdatesPerFrame,
      fpsWindowFrames: LOOP.fpsWindowFrames,
      scheduler,
      update: () => {},
      render: (_alpha, nowMs) => {
        const frame = mouse.frameAt(nowMs);
        expect(frame).not.toBeNull();
        surface.clear();
        totalDots += drawHands(surface, frame!.hands, canvas.width, canvas.height);
        framesDrawn += 1;
      },
    });

    loop.start();
    for (let i = 0; i < 20; i += 1) {
      scheduler.step(1000 / 60);
    }
    loop.stop();

    // One rendered frame per display frame, and one dot per landmark each time.
    expect(framesDrawn).toBe(20);
    expect(totalDots).toBe(20 * 21);
    // The fixed-step update ran independently of rendering.
    expect(loop.stats.updateSteps).toBeGreaterThanOrEqual(19);
    expect(loop.stats.fps).toBeCloseTo(60, 0);
  });
});
