/**
 * Unit tests for rendering-only interpolation (PLAN.md §7.2).
 *
 * §7.2 forbids three things, and the last three tests here assert each in turn:
 * feeding interpolated frames to the classifier, treating them as observations,
 * and reporting them as increased inference rate.
 */

import { describe, expect, it } from 'vitest';

import { INTERPOLATION } from '../config';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';
import { LandmarkInterpolator } from './interpolate';

const MAX_AGE = INTERPOLATION.maxInterpolationAgeMs;

function hand(x: number, y = 0.5): NormalizedLandmark[] {
  return Array.from({ length: 21 }, () => ({ x, y }));
}

describe('LandmarkInterpolator', () => {
  it('returns null before anything is observed', () => {
    expect(new LandmarkInterpolator().advance(0)).toBeNull();
  });

  it('draws the first observation unchanged, because there is no velocity yet', () => {
    const interpolator = new LandmarkInterpolator();
    interpolator.observe(hand(0.30), 0);

    const frame = interpolator.advance(20)!;
    expect(frame.landmarks[0]!.x).toBeCloseTo(0.30, 12);
    expect(frame.interpolated).toBe(false);
    expect(frame.stale).toBe(false);
  });

  it('advances the hand between detections using the last two observations', () => {
    const interpolator = new LandmarkInterpolator();
    interpolator.observe(hand(0.20), 0);
    interpolator.observe(hand(0.30), 100); // 0.10 per 100 ms

    // 50 ms after the newest observation: halfway to the next if it continued.
    const frame = interpolator.advance(150)!;
    expect(frame.landmarks[0]!.x).toBeCloseTo(0.35, 12);
    expect(frame.ageMs).toBe(50);
    expect(frame.interpolated).toBe(true);
    expect(frame.stale).toBe(false);
  });

  it('stops advancing and marks the frame stale past maxInterpolationAgeMs', () => {
    const interpolator = new LandmarkInterpolator();
    interpolator.observe(hand(0.20), 0);
    interpolator.observe(hand(0.30), 100);

    const frame = interpolator.advance(100 + MAX_AGE + 1)!;
    expect(frame.stale).toBe(true);
    expect(frame.interpolated).toBe(false);
    // Held at the last real position — a lost hand must not drift.
    expect(frame.landmarks[0]!.x).toBeCloseTo(0.30, 12);
  });

  it('does not drift even when left alone for a long time', () => {
    const interpolator = new LandmarkInterpolator();
    interpolator.observe(hand(0.10), 0);
    interpolator.observe(hand(0.90), 100); // a fast hand

    const frame = interpolator.advance(60_000)!;
    expect(frame.landmarks[0]!.x).toBeCloseTo(0.90, 12);
    expect(frame.stale).toBe(true);
  });

  it('holds a landmark that only appears in the newer observation', () => {
    const interpolator = new LandmarkInterpolator();
    interpolator.observe([{ x: 0.2, y: 0.5 }], 0);
    interpolator.observe([{ x: 0.3, y: 0.5 }, { x: 0.9, y: 0.5 }], 100);

    const frame = interpolator.advance(150)!;
    expect(frame.landmarks[1]!.x).toBeCloseTo(0.9, 12);
  });

  it('passes z through rather than extrapolating it', () => {
    const interpolator = new LandmarkInterpolator();
    interpolator.observe([{ x: 0.2, y: 0.5, z: 0.01 }], 0);
    interpolator.observe([{ x: 0.3, y: 0.5, z: 0.02 }], 100);

    const frame = interpolator.advance(150)!;
    expect(frame.landmarks[0]!.z).toBeCloseTo(0.02, 12);
  });

  it('counts only frames it actually advanced', () => {
    const interpolator = new LandmarkInterpolator();
    interpolator.observe(hand(0.2), 0);
    interpolator.advance(10); // no velocity: not counted
    interpolator.observe(hand(0.3), 100);
    interpolator.advance(150); // advanced
    interpolator.advance(200); // advanced

    expect(interpolator.interpolatedFrames).toBe(2);
  });

  it('reset() clears the history so a new source cannot inherit velocity', () => {
    const interpolator = new LandmarkInterpolator();
    interpolator.observe(hand(0.2), 0);
    interpolator.observe(hand(0.9), 100);
    interpolator.reset();

    expect(interpolator.advance(150)).toBeNull();
    expect(interpolator.interpolatedFrames).toBe(0);
  });

  it('does not mutate the observation it was given (§7.2: not an observation)', () => {
    const interpolator = new LandmarkInterpolator();
    const first = hand(0.2);
    const second = hand(0.3);
    interpolator.observe(first, 0);
    interpolator.observe(second, 100);
    interpolator.advance(150);

    // The caller's arrays must be untouched: nothing downstream may see advanced
    // positions as if they had been measured.
    expect(first[0]!.x).toBeCloseTo(0.2, 12);
    expect(second[0]!.x).toBeCloseTo(0.3, 12);
  });
});
