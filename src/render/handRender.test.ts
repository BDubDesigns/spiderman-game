/**
 * Unit tests for the per-identity drawing pipeline (PLAN.md §7.2).
 *
 * Thin over `LandmarkInterpolator`, but not trivial: it owns *which* identity is
 * being advanced and the rule that a stale hand must not be re-observed. Both are
 * places where a mistake would let a frozen hand drift on screen.
 */

import { describe, expect, it } from 'vitest';

import { INTERPOLATION } from '../config';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';
import { HandRenderPipeline } from './handRender';

const MAX_AGE = INTERPOLATION.maxInterpolationAgeMs;

function hand(x: number): NormalizedLandmark[] {
  return Array.from({ length: 21 }, () => ({ x, y: 0.5 }));
}

describe('HandRenderPipeline', () => {
  it('returns nothing before any observation', () => {
    expect(new HandRenderPipeline().advance(0)).toEqual([]);
  });

  it('advances each identity independently', () => {
    const pipeline = new HandRenderPipeline();
    pipeline.observe('left', hand(0.0), 0);
    pipeline.observe('left', hand(0.2), 100);
    pipeline.observe('right', hand(0.8), 0);
    pipeline.observe('right', hand(0.8), 100); // stationary

    const drawn = pipeline.advance(150);
    const left = drawn.find((h) => h.identity === 'left')!;
    const right = drawn.find((h) => h.identity === 'right')!;

    expect(left.landmarks[0]!.x).toBeCloseTo(0.3, 12);
    expect(left.interpolated).toBe(true);
    expect(right.landmarks[0]!.x).toBeCloseTo(0.8, 12);
  });

  it('marks a hand stale rather than advancing it past maxInterpolationAgeMs', () => {
    const pipeline = new HandRenderPipeline();
    pipeline.observe('right', hand(0.2), 0);
    pipeline.observe('right', hand(0.9), 100);

    const drawn = pipeline.advance(100 + MAX_AGE + 1)[0]!;
    expect(drawn.stale).toBe(true);
    expect(drawn.landmarks[0]!.x).toBeCloseTo(0.9, 12);
  });

  it('forget() drops one identity without disturbing the other', () => {
    const pipeline = new HandRenderPipeline();
    pipeline.observe('left', hand(0.1), 0);
    pipeline.observe('right', hand(0.9), 0);
    pipeline.forget('left');

    const drawn = pipeline.advance(16);
    expect(drawn.map((h) => h.identity)).toEqual(['right']);
  });

  it('reset() clears everything, including the interpolated count', () => {
    const pipeline = new HandRenderPipeline();
    pipeline.observe('right', hand(0.2), 0);
    pipeline.observe('right', hand(0.6), 100);
    pipeline.advance(150);
    expect(pipeline.interpolatedFrames).toBe(1);

    pipeline.reset();
    expect(pipeline.advance(200)).toEqual([]);
    expect(pipeline.interpolatedFrames).toBe(0);
  });

  it('counts advanced frames across identities', () => {
    const pipeline = new HandRenderPipeline();
    for (const identity of ['left', 'right'] as const) {
      pipeline.observe(identity, hand(0.2), 0);
      pipeline.observe(identity, hand(0.6), 100);
    }
    pipeline.advance(150);

    expect(pipeline.interpolatedFrames).toBe(2);
  });
});
