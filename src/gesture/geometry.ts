/**
 * Aspect-corrected geometry for hand measurements (PLAN.md §11.1).
 *
 * ---- Why this module exists ----
 *
 * MediaPipe returns landmarks normalized **per axis**: `x` by image width and `y`
 * by image height. So `hypot(dx, dy)` on raw normalized coordinates is only a true
 * distance when the image is square, which a camera image never is.
 *
 * `handIdentity` and `autoAim` already correct for this; the gesture classifier did
 * not, so the same physical hand measured differently depending on the capture
 * aspect. Everything in `src/gesture/` now goes through here.
 *
 * ---- The convention ----
 *
 * `aspect` is **width / height**. Scaling `x` by it and leaving `y` alone expresses
 * every distance in units of the image **height**:
 *
 *     hypot(dx * W, dy * H)  ==  H * hypot(dx * (W/H), dy)
 *
 * which is why the same `aspect` works for 640x480 and 1280x720 without any
 * resolution term appearing in a threshold.
 *
 * Distances are therefore comparable across resolutions and across portrait and
 * landscape, and ratios of them (which is all the classifier uses) are invariant.
 */

import type { NormalizedPoint } from '../tracking/landmarkTypes';

/** The default capture aspect, matching the M0 harness placeholder. */
export const DEFAULT_ASPECT = 4 / 3;

/** A point in metric space: distance units are fractions of the image height. */
export interface MetricPoint {
  x: number;
  y: number;
}

/**
 * Convert a normalized landmark to metric space.
 *
 * `x` is scaled by the aspect so that one unit is the same real distance on both
 * axes. `y` is the reference axis and is left alone.
 */
export function toMetric(point: NormalizedPoint, aspect: number): MetricPoint {
  return { x: point.x * aspect, y: point.y };
}

/** True distance between two normalized points, in units of image height. */
export function metricDistance(
  a: NormalizedPoint,
  b: NormalizedPoint,
  aspect: number,
): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

/** Length of a metric delta. */
export function metricLength(dx: number, dy: number): number {
  return Math.hypot(dx, dy);
}

/**
 * Interior angle at `vertex`, in degrees, between `a` and `c`.
 *
 * Returns `null` when either arm is too short to define a direction. That is a real
 * case, not a defensive one: a finger pointing at the camera projects its phalanges
 * to almost nothing, and an angle computed from two near-zero vectors is noise that
 * could be reported as a confident bend. Callers must treat `null` as "unknown",
 * never as "straight".
 */
export function angleAtDeg(
  a: NormalizedPoint,
  vertex: NormalizedPoint,
  c: NormalizedPoint,
  aspect: number,
): number | null {
  const v1x = (a.x - vertex.x) * aspect;
  const v1y = a.y - vertex.y;
  const v2x = (c.x - vertex.x) * aspect;
  const v2y = c.y - vertex.y;

  const n1 = metricLength(v1x, v1y);
  const n2 = metricLength(v2x, v2y);
  if (n1 < 1e-9 || n2 < 1e-9) return null;

  const cosine = (v1x * v2x + v1y * v2y) / (n1 * n2);
  // Clamp against floating-point overshoot rather than trusting the input.
  const clamped = Math.min(1, Math.max(-1, cosine));
  return (Math.acos(clamped) * 180) / Math.PI;
}

/** Sum of the lengths of a polyline through the given points. */
export function polylineLength(
  points: readonly NormalizedPoint[],
  aspect: number,
): number {
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (!previous || !current) continue;
    total += metricDistance(previous, current, aspect);
  }
  return total;
}

/**
 * Centroid of the palm, matching §11.1 and `handIdentity`.
 *
 * Deliberately the arithmetic mean of the wrist and the four MCPs, in **normalized**
 * space: it is a position, not a length, so the aspect does not enter until a
 * distance is taken from it. Averaging in metric space would give the same result
 * up to the same per-axis scaling, so doing it here keeps this comparable with
 * `palmCenterOf` in `handIdentity`, which identity continuity depends on.
 */
export function centroid(
  points: readonly NormalizedPoint[],
): NormalizedPoint {
  let x = 0;
  let y = 0;
  for (const point of points) {
    x += point.x;
    y += point.y;
  }
  const n = Math.max(1, points.length);
  return { x: x / n, y: y / n };
}
