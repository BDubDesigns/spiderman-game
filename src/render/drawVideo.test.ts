/**
 * Unit tests for the mirrored camera pass.
 *
 * The assertions that matter are about the *transform contract*: the mirror is a
 * horizontal flip about the canvas width, and it is released before returning so
 * the HUD cannot inherit it (PLAN.md §8 Rule B).
 */

import { describe, expect, it } from 'vitest';

import { drawMirroredVideo, type MirrorDrawSurface } from './drawVideo';

class RecordingSurface implements MirrorDrawSurface {
  readonly transforms: Array<[number, number, number, number, number, number]> = [];
  readonly draws: Array<{ dx: number; dy: number; dw: number; dh: number }> = [];
  saveCalls = 0;
  restoreCalls = 0;
  /** Depth of save/restore nesting, to prove the pair is balanced. */
  private depth = 0;
  maxDepth = 0;

  save(): void {
    this.saveCalls += 1;
    this.depth += 1;
    this.maxDepth = Math.max(this.maxDepth, this.depth);
  }

  restore(): void {
    this.restoreCalls += 1;
    this.depth -= 1;
  }

  setTransform(
    a: number,
    b: number,
    c: number,
    d: number,
    e: number,
    f: number,
  ): void {
    this.transforms.push([a, b, c, d, e, f]);
  }

  drawImage(_image: CanvasImageSource, dx: number, dy: number, dw: number, dh: number): void {
    this.draws.push({ dx, dy, dw, dh });
  }
}

const W = 640;
const H = 480;
const fakeVideo = {} as CanvasImageSource;

describe('drawMirroredVideo', () => {
  it('applies a horizontal flip about the canvas width', () => {
    const surface = new RecordingSurface();
    drawMirroredVideo(surface, fakeVideo, W, H);

    expect(surface.transforms).toEqual([[-1, 0, 0, 1, W, 0]]);
  });

  it('draws the frame across the whole canvas, not letterboxed', () => {
    const surface = new RecordingSurface();
    drawMirroredVideo(surface, fakeVideo, W, H);

    // Rule A: the backing store equals the source, so this is a full-rect blit
    // and normalized -> canvas stays a pure multiply.
    expect(surface.draws).toEqual([{ dx: 0, dy: 0, dw: W, dh: H }]);
  });

  it('releases the mirror transform before returning, so the HUD stays readable', () => {
    const surface = new RecordingSurface();
    drawMirroredVideo(surface, fakeVideo, W, H);

    expect(surface.saveCalls).toBe(1);
    expect(surface.restoreCalls).toBe(1);
    // Balanced nesting: nothing is left on the transform stack.
    expect(surface.maxDepth).toBeLessThanOrEqual(1);
  });

  it('mirrors about the given width for non-square and unusual stages', () => {
    for (const [w, h] of [
      [1000, 100],
      [100, 1000],
      [1, 1],
    ] as const) {
      const surface = new RecordingSurface();
      drawMirroredVideo(surface, fakeVideo, w, h);
      expect(surface.transforms[0]?.[4]).toBe(w);
      expect(surface.draws[0]).toEqual({ dx: 0, dy: 0, dw: w, dh: h });
    }
  });

  it('does not depend on the transform being identity beforehand', () => {
    // save/restore is what makes this safe regardless of prior state, which is
    // why the function never calls setTransform to "reset" first.
    const surface = new RecordingSurface();
    surface.setTransform(2, 0, 0, 2, 10, 10);
    drawMirroredVideo(surface, fakeVideo, W, H);

    expect(surface.transforms).toHaveLength(2);
    expect(surface.transforms[1]).toEqual([-1, 0, 0, 1, W, 0]);
  });

  it('rejects a zero-sized backing store, which would mean Rule A was skipped', () => {
    const surface = new RecordingSurface();
    expect(() => drawMirroredVideo(surface, fakeVideo, 0, H)).toThrow(RangeError);
    expect(() => drawMirroredVideo(surface, fakeVideo, W, 0)).toThrow(RangeError);
    expect(surface.saveCalls).toBe(0);
  });
});
