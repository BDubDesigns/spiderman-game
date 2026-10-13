/**
 * Unit tests for aspect-corrected hand geometry (PLAN.md §11.1).
 *
 * The bug these lock down: MediaPipe normalizes `x` by image width and `y` by image
 * height, so a raw `hypot(dx, dy)` is only a true distance on a square image. The
 * gesture classifier used one, while `handIdentity` and `autoAim` both corrected for
 * aspect — so the same physical hand was measured differently depending on the
 * capture aspect, and the thresholds meant different things in portrait and
 * landscape.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ASPECT, angleAtDeg, centroid, metricDistance, polylineLength } from './geometry';

const LANDSCAPE = 4 / 3;
const PORTRAIT = 3 / 4;
const SQUARE = 1;

describe('metricDistance', () => {
  it('is the plain hypot on a square image, where normalized units are square', () => {
    expect(metricDistance({ x: 0, y: 0 }, { x: 0.3, y: 0.4 }, SQUARE)).toBeCloseTo(0.5, 12);
  });

  it('scales horizontal offsets by the aspect, so both axes are the same real size', () => {
    // One unit of x is `aspect` units of y in real terms.
    expect(metricDistance({ x: 0, y: 0 }, { x: 1, y: 0 }, LANDSCAPE)).toBeCloseTo(4 / 3, 12);
    expect(metricDistance({ x: 0, y: 0 }, { x: 1, y: 0 }, PORTRAIT)).toBeCloseTo(3 / 4, 12);
    // Vertical offsets are the reference axis and never scale.
    expect(metricDistance({ x: 0, y: 0 }, { x: 0, y: 1 }, LANDSCAPE)).toBeCloseTo(1, 12);
    expect(metricDistance({ x: 0, y: 0 }, { x: 0, y: 1 }, PORTRAIT)).toBeCloseTo(1, 12);
  });

  it('would be wrong without the correction, which is what the old code did', () => {
    // A purely horizontal offset: uncorrected it reads 1.0 at any aspect, but the
    // real distance genuinely differs between landscape and portrait.
    const raw = Math.hypot(1 - 0, 0 - 0);
    expect(raw).toBeCloseTo(1, 12);
    expect(metricDistance({ x: 0, y: 0 }, { x: 1, y: 0 }, PORTRAIT)).toBeCloseTo(0.75, 12);
    expect(metricDistance({ x: 0, y: 0 }, { x: 1, y: 0 }, LANDSCAPE)).toBeCloseTo(1.333, 3);
  });

  it('agrees with a pixel distance, up to the units it is expressed in', () => {
    // The identity `hypot(dx*W, dy*H) == H * metricDistance(a, b, W/H)` is the whole
    // justification for the convention, so it is asserted rather than described.
    const width = 1280;
    const height = 720;
    const a = { x: 0.2, y: 0.1 };
    const b = { x: 0.7, y: 0.8 };
    const pixelDistance = Math.hypot((b.x - a.x) * width, (b.y - a.y) * height);
    expect(height * metricDistance(a, b, width / height)).toBeCloseTo(pixelDistance, 9);
  });
});

describe('angleAtDeg', () => {
  it('measures a right angle', () => {
    const angle = angleAtDeg({ x: 0, y: 0 }, { x: 0, y: 0.5 }, { x: 0.5, y: 0.5 }, LANDSCAPE);
    expect(angle).toBeCloseTo(90, 6);
  });

  it('measures a straight line as 180', () => {
    const angle = angleAtDeg({ x: 0, y: 0 }, { x: 0, y: 0.5 }, { x: 0, y: 1 }, LANDSCAPE);
    expect(angle).toBeCloseTo(180, 6);
  });

  it('is aspect-independent for a physically identical configuration', () => {
    // A right angle in metric space stays a right angle whatever the capture aspect,
    // once the coordinates are expressed for that aspect.
    const inLandscape = angleAtDeg(
      { x: 0, y: 0 },
      { x: 0, y: 0.5 },
      { x: 0.5, y: 0.5 },
      LANDSCAPE,
    );
    // The same physical point re-expressed for a portrait capture.
    const portraitX = (0.5 * LANDSCAPE) / PORTRAIT;
    const inPortrait = angleAtDeg(
      { x: 0, y: 0 },
      { x: 0, y: 0.5 },
      { x: portraitX, y: 0.5 },
      PORTRAIT,
    );
    expect(inPortrait).not.toBeNull();
    expect(inPortrait as number).toBeCloseTo(inLandscape as number, 6);
  });

  it('returns null when an arm is too short to define a direction', () => {
    // A finger pointing at the camera projects its phalanges to nothing. An angle
    // from two near-zero vectors is noise, and must not be reported as a confident
    // bend, so this is `null` rather than a number.
    expect(angleAtDeg({ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, LANDSCAPE)).toBeNull();
    expect(angleAtDeg({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.9, y: 0.5 }, LANDSCAPE)).toBeNull();
  });

  it('tolerates floating-point overshoot instead of returning NaN', () => {
    // Collinear points can push the cosine a hair past ±1; acos would give NaN.
    const angle = angleAtDeg({ x: 0, y: 0 }, { x: 0.3, y: 0.3 }, { x: 0.6, y: 0.6 }, LANDSCAPE);
    expect(angle).not.toBeNull();
    expect(Number.isFinite(angle as number)).toBe(true);
    expect(angle).toBeCloseTo(180, 4);
  });
});

describe('polylineLength', () => {
  it('sums the segments', () => {
    const length = polylineLength(
      [
        { x: 0, y: 0 },
        { x: 0, y: 1 },
        { x: 0, y: 2 },
      ],
      LANDSCAPE,
    );
    expect(length).toBeCloseTo(2, 12);
  });

  it('is zero for a degenerate chain', () => {
    expect(polylineLength([{ x: 0.5, y: 0.5 }], LANDSCAPE)).toBe(0);
  });
});

describe('centroid', () => {
  it('averages the points and tolerates an empty list', () => {
    expect(centroid([{ x: 0, y: 0 }, { x: 1, y: 0.4 }])).toEqual({ x: 0.5, y: 0.2 });
    expect(centroid([])).toEqual({ x: 0, y: 0 });
  });
});

describe('DEFAULT_ASPECT', () => {
  it('matches the M0 harness placeholder, so omitting it is the documented default', () => {
    expect(DEFAULT_ASPECT).toBeCloseTo(4 / 3, 12);
  });
});
