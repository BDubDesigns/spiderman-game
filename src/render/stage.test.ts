/**
 * Unit tests for the coordinate transform (PLAN.md §21.3).
 *
 * Required coverage per the M0 brief: origin, horizontal mirror, edge values,
 * and non-square aspect ratios. The mirroring tests are the important ones —
 * PLAN.md §15 risk #1 is a coordinate/mirroring bug that detaches the web from
 * the hand, and this is the only place that can introduce it.
 */

import { describe, expect, it } from 'vitest';

import { clamp, syncCanvasBackingStore, toCanvas, toNormalized } from './stage';

const W = 640;
const H = 480;

describe('toCanvas', () => {
  describe('origin', () => {
    it('maps video (0,0) to the top-RIGHT of the canvas, because x is mirrored', () => {
      expect(toCanvas({ x: 0, y: 0 }, W, H)).toEqual({ x: W, y: 0 });
    });

    it('maps video (1,1) to the bottom-left of the canvas', () => {
      expect(toCanvas({ x: 1, y: 1 }, W, H)).toEqual({ x: 0, y: H });
    });
  });

  describe('horizontal mirror', () => {
    it('maps the horizontal centre to the horizontal centre', () => {
      expect(toCanvas({ x: 0.5, y: 0 }, W, H).x).toBe(W / 2);
    });

    it('mirrors x: video x=0 -> canvas right, video x=1 -> canvas left', () => {
      expect(toCanvas({ x: 0, y: 0.5 }, W, H).x).toBe(W);
      expect(toCanvas({ x: 1, y: 0.5 }, W, H).x).toBe(0);
    });

    it('is symmetric about the centre: x and 1-x are equidistant from it', () => {
      for (const x of [0, 0.1, 0.25, 0.4, 0.5, 0.6, 0.75, 0.9, 1]) {
        const left = toCanvas({ x, y: 0 }, W, H).x;
        const right = toCanvas({ x: 1 - x, y: 0 }, W, H).x;
        expect(left + right).toBeCloseTo(W, 10);
      }
    });

    it('is monotonically decreasing in x (so the image is flipped, not skewed)', () => {
      const xs = [0, 0.2, 0.5, 0.8, 1];
      const mapped = xs.map((x) => toCanvas({ x, y: 0 }, W, H).x);
      for (let i = 1; i < mapped.length; i += 1) {
        expect(mapped[i]!).toBeLessThan(mapped[i - 1]!);
      }
    });

    it('does NOT mirror y', () => {
      expect(toCanvas({ x: 0.5, y: 0 }, W, H).y).toBe(0);
      expect(toCanvas({ x: 0.5, y: 0.25 }, W, H).y).toBeCloseTo(H * 0.25, 10);
      expect(toCanvas({ x: 0.5, y: 1 }, W, H).y).toBe(H);
    });
  });

  describe('edge values', () => {
    it('maps all four corners exactly, with no off-by-one clamping', () => {
      expect(toCanvas({ x: 0, y: 0 }, W, H)).toEqual({ x: 640, y: 0 });
      expect(toCanvas({ x: 0, y: 1 }, W, H)).toEqual({ x: 640, y: 480 });
      expect(toCanvas({ x: 1, y: 0 }, W, H)).toEqual({ x: 0, y: 0 });
      expect(toCanvas({ x: 1, y: 1 }, W, H)).toEqual({ x: 0, y: 480 });
    });

    it('preserves out-of-range values rather than silently clamping them', () => {
      // The model can emit slightly out-of-range points. Clamping here would
      // hide a real tracking fault behind a plausible-looking dot.
      const out = toCanvas({ x: 1.25, y: -0.1 }, W, H);
      expect(out.x).toBeCloseTo((1 - 1.25) * W, 10);
      expect(out.y).toBeCloseTo(-0.1 * H, 10);
    });
  });

  describe('non-square aspect ratios', () => {
    it('scales x by width and y by height independently', () => {
      const wide = toCanvas({ x: 0.25, y: 0.25 }, 1000, 300);
      expect(wide).toEqual({ x: 750, y: 75 });

      const tall = toCanvas({ x: 0.25, y: 0.25 }, 300, 1000);
      expect(tall).toEqual({ x: 225, y: 250 });
    });

    it('does not swap axes for extreme aspect ratios', () => {
      for (const [cw, ch] of [
        [640, 480],
        [480, 640],
        [1920, 1080],
        [1000, 100],
        [100, 1000],
        [1, 1],
      ] as const) {
        const p = toCanvas({ x: 0.25, y: 0.75 }, cw, ch);
        expect(p.x).toBeCloseTo(0.75 * cw, 10);
        expect(p.y).toBeCloseTo(0.75 * ch, 10);
      }
    });

    it('keeps the horizontal centre at cw/2 for any aspect ratio', () => {
      for (const [cw, ch] of [
        [640, 480],
        [101, 999],
        [3, 7],
      ] as const) {
        expect(toCanvas({ x: 0.5, y: 0.5 }, cw, ch)).toEqual({
          x: cw / 2,
          y: ch / 2,
        });
      }
    });
  });

  describe('toNormalized (Rule E inverse)', () => {
    it('round-trips through toCanvas', () => {
      for (const lm of [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
        { x: 0.5, y: 0.5 },
        { x: 0.123, y: 0.876 },
        { x: -0.2, y: 1.4 },
      ]) {
        const back = toNormalized(toCanvas(lm, W, H), W, H);
        expect(back.x).toBeCloseTo(lm.x, 10);
        expect(back.y).toBeCloseTo(lm.y, 10);
      }
    });

    it('round-trips through toNormalized for non-square stages', () => {
      const point = { x: 123, y: 45 };
      const back = toCanvas(toNormalized(point, 1000, 100), 1000, 100);
      expect(back.x).toBeCloseTo(point.x, 10);
      expect(back.y).toBeCloseTo(point.y, 10);
    });

    it('maps the canvas origin to video (1,0)', () => {
      expect(toNormalized({ x: 0, y: 0 }, W, H)).toEqual({ x: 1, y: 0 });
    });
  });
});

describe('syncCanvasBackingStore (Rule A)', () => {
  it('sets the backing store to the source intrinsic dimensions', () => {
    const canvas = { width: 0, height: 0 };
    expect(syncCanvasBackingStore(canvas, 640, 480)).toBe(true);
    expect(canvas).toEqual({ width: 640, height: 480 });
  });

  it('reports no change when already in sync, so context state is not reset', () => {
    const canvas = { width: 640, height: 480 };
    expect(syncCanvasBackingStore(canvas, 640, 480)).toBe(false);
    expect(canvas).toEqual({ width: 640, height: 480 });
  });

  it('re-syncs on an orientation change rather than caching dimensions', () => {
    const canvas = { width: 640, height: 480 };
    expect(syncCanvasBackingStore(canvas, 480, 640)).toBe(true);
    expect(canvas).toEqual({ width: 480, height: 640 });
  });

  it('rounds fractional intrinsic dimensions to integers', () => {
    const canvas = { width: 0, height: 0 };
    syncCanvasBackingStore(canvas, 640.4, 479.6);
    expect(canvas).toEqual({ width: 640, height: 480 });
  });

  it('rejects non-positive and non-finite dimensions', () => {
    for (const [w, h] of [
      [0, 480],
      [640, 0],
      [-640, 480],
      [Number.NaN, 480],
      [640, Number.POSITIVE_INFINITY],
    ] as const) {
      expect(() => syncCanvasBackingStore({ width: 0, height: 0 }, w, h)).toThrow(
        RangeError,
      );
    }
  });
});

describe('clamp', () => {
  it('clamps into range and passes through in-range values', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
