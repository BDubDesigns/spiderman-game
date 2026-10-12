/**
 * Unit tests for the landmark overlay.
 *
 * The point of these tests is that rendering is verified without a browser: a
 * recording stub captures the arcs, and the assertions check that each dot lands
 * at the mirrored canvas position. Combined with the `toCanvas` tests and the
 * source tests, this is what substantiates the M0 acceptance criterion that
 * landmarks are drawn from a synthetic source with no camera involved.
 */

import { describe, expect, it } from 'vitest';

import { RENDER } from '../config';
import { LANDMARK_COUNT, type RawHandFrame } from '../tracking/landmarkTypes';
import { colorForHand, drawHands, type LandmarkDrawSurface } from './drawHands';
import { toCanvas } from './stage';

/** Records everything the renderer does, with no DOM. */
class RecordingSurface implements LandmarkDrawSurface {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  readonly arcs: Array<{ x: number; y: number; radius: number }> = [];
  readonly fills: Array<string | CanvasGradient | CanvasPattern> = [];
  beginPathCalls = 0;

  beginPath(): void {
    this.beginPathCalls += 1;
  }

  arc(x: number, y: number, radius: number): void {
    this.arcs.push({ x, y, radius });
  }

  fill(): void {
    this.fills.push(this.fillStyle);
  }
}

const W = 640;
const H = 480;

function makeHand(
  label: 'Left' | 'Right',
  offsetX = 0.3,
  offsetY = 0.4,
): RawHandFrame {
  return {
    landmarks: Array.from({ length: LANDMARK_COUNT }, (_, i) => ({
      x: offsetX + i * 0.01,
      y: offsetY + i * 0.005,
    })),
    handedness: { label, score: 0.9 },
  };
}

describe('drawHands', () => {
  it('draws exactly one dot per landmark', () => {
    const surface = new RecordingSurface();
    const hand = makeHand('Right');

    const dots = drawHands(surface, [hand], W, H);

    expect(dots).toBe(LANDMARK_COUNT);
    expect(surface.arcs).toHaveLength(LANDMARK_COUNT);
    // Batched into a single path and a single fill for the whole hand.
    expect(surface.beginPathCalls).toBe(1);
    expect(surface.fills).toHaveLength(1);
  });

  it('places every dot through toCanvas, i.e. horizontally mirrored', () => {
    const surface = new RecordingSurface();
    const hand = makeHand('Right');
    drawHands(surface, [hand], W, H);

    hand.landmarks.forEach((landmark, index) => {
      const expected = toCanvas(landmark, W, H);
      expect(surface.arcs[index]!.x).toBeCloseTo(expected.x, 10);
      expect(surface.arcs[index]!.y).toBeCloseTo(expected.y, 10);
    });
    // Sanity: the transform really is mirrored, not applied twice or not at all.
    expect(surface.arcs[0]!.x).toBeCloseTo((1 - hand.landmarks[0]!.x) * W, 10);
    expect(surface.arcs[0]!.x).not.toBeCloseTo(hand.landmarks[0]!.x * W, 10);
  });

  it('uses the configured dot radius, and honours an override', () => {
    const surface = new RecordingSurface();
    drawHands(surface, [makeHand('Right')], W, H);
    expect(surface.arcs.every((a) => a.radius === RENDER.landmarkRadiusPx)).toBe(
      true,
    );

    const custom = new RecordingSurface();
    drawHands(custom, [makeHand('Right')], W, H, { radiusPx: 9 });
    expect(custom.arcs.every((a) => a.radius === 9)).toBe(true);
  });

  it('colours dots by handedness so identity is eyeball-checkable', () => {
    const surface = new RecordingSurface();
    const left = makeHand('Left');
    const right = makeHand('Right');

    drawHands(surface, [left, right], W, H);

    expect(colorForHand(left)).toBe(RENDER.leftColor);
    expect(colorForHand(right)).toBe(RENDER.rightColor);
    expect(surface.fills).toEqual([RENDER.leftColor, RENDER.rightColor]);
  });

  it('draws both hands independently, for two-hand frames', () => {
    const surface = new RecordingSurface();
    const dots = drawHands(surface, [makeHand('Left'), makeHand('Right', 0.2)], W, H);
    expect(dots).toBe(LANDMARK_COUNT * 2);
    expect(surface.beginPathCalls).toBe(2);
  });

  it('draws nothing for an empty frame, without opening a path', () => {
    const surface = new RecordingSurface();
    const dots = drawHands(surface, [], W, H);
    expect(dots).toBe(0);
    expect(surface.arcs).toHaveLength(0);
    expect(surface.beginPathCalls).toBe(0);
    expect(surface.fills).toHaveLength(0);
  });

  it('does not mutate the hands it is given', () => {
    const surface = new RecordingSurface();
    const hand = makeHand('Right');
    const before = JSON.stringify(hand);
    drawHands(surface, [hand], W, H);
    expect(JSON.stringify(hand)).toBe(before);
  });

  it('works on non-square backing stores without swapping axes', () => {
    const surface = new RecordingSurface();
    const hand = makeHand('Right');
    drawHands(surface, [hand], 1000, 100);
    const expected = toCanvas(hand.landmarks[3]!, 1000, 100);
    expect(surface.arcs[3]!.x).toBeCloseTo(expected.x, 10);
    expect(surface.arcs[3]!.y).toBeCloseTo(expected.y, 10);
  });

  it('rejects a zero-sized backing store, which would mean Rule A was skipped', () => {
    const surface = new RecordingSurface();
    expect(() => drawHands(surface, [makeHand('Right')], 0, H)).toThrow(RangeError);
    expect(() => drawHands(surface, [makeHand('Right')], W, 0)).toThrow(RangeError);
    expect(() =>
      drawHands(surface, [makeHand('Right')], W, H, { radiusPx: 0 }),
    ).toThrow(RangeError);
  });
});
