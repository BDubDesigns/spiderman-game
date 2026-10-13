/**
 * Unit tests for the One Euro filter (PLAN.md §11.6).
 *
 * §11.6 requires two instances per identity — a lightly-smoothed stream for
 * classification and a heavily-smoothed one for rendering — so the tests here
 * establish the property that makes that split worth doing: the filter trades
 * jitter against lag according to its cutoff, and `beta` recovers responsiveness
 * when the signal actually moves.
 */

import { describe, expect, it } from 'vitest';

import { SMOOTHING } from '../config';
import { LandmarkSmoother, LowPassFilter, OneEuroFilter } from './oneEuro';

const RENDER = SMOOTHING.render;
const CLASSIFY = SMOOTHING.classify;

/** Feed a scalar series at a steady 60 Hz and return the outputs. */
function run(
  filter: OneEuroFilter,
  samples: readonly number[],
  stepMs = 1000 / 60,
): number[] {
  return samples.map((sample, index) => filter.filter(sample, index * stepMs));
}

/** Root-mean-square deviation from a constant, i.e. how much jitter survived. */
function jitter(outputs: readonly number[], truth: number): number {
  const sum = outputs.reduce((total, value) => total + (value - truth) ** 2, 0);
  return Math.sqrt(sum / outputs.length);
}

describe('LowPassFilter', () => {
  it('seeds from the first sample rather than from zero', () => {
    const filter = new LowPassFilter();
    filter.setAlpha(0.5);
    expect(filter.filter(10)).toBe(10);
    expect(filter.hasLastValue()).toBe(true);
  });

  it('takes the new sample verbatim at alpha 1 and ignores it at alpha 0', () => {
    const open = new LowPassFilter();
    open.setAlpha(1);
    open.filter(0);
    expect(open.filter(5)).toBe(5);

    const closed = new LowPassFilter();
    closed.setAlpha(0);
    closed.filter(0);
    expect(closed.filter(5)).toBe(0);
  });

  it('reset() clears the seeded value', () => {
    const filter = new LowPassFilter();
    filter.filter(3);
    filter.reset();
    expect(filter.hasLastValue()).toBe(false);
    expect(filter.lastValue()).toBeNull();
  });
});

describe('OneEuroFilter', () => {
  it('passes the first sample through untouched', () => {
    expect(new OneEuroFilter(RENDER).filter(0.42, 0)).toBeCloseTo(0.42, 12);
  });

  it('suppresses jitter on a signal that is actually still', () => {
    const truth = 0.5;
    const noisy = Array.from({ length: 120 }, (_, i) => truth + (i % 2 === 0 ? 0.03 : -0.03));

    const raw = jitter(noisy, truth);
    const filtered = jitter(run(new OneEuroFilter(RENDER), noisy), truth);

    expect(filtered).toBeLessThan(raw / 4);
  });

  it('smooths harder at the render cutoff than at the classify cutoff', () => {
    const truth = 0.5;
    const noisy = Array.from({ length: 120 }, (_, i) => truth + (i % 2 === 0 ? 0.03 : -0.03));

    const render = jitter(run(new OneEuroFilter(RENDER), noisy), truth);
    const classify = jitter(run(new OneEuroFilter(CLASSIFY), noisy), truth);

    // §11.6: the render filter is the heavier of the two.
    expect(render).toBeLessThan(classify);
  });

  it('lags a moving signal less than a fixed filter at the same cutoff', () => {
    // The property that justifies One Euro: `beta` raises the cutoff with speed,
    // so a moving hand is tracked more closely than a fixed low-pass of the same
    // baseline cutoff. Comparing against an absolute number would just encode
    // whatever the untuned §11.6 defaults happen to produce.
    const dt = 1000 / 60;
    const ramp = Array.from({ length: 60 }, (_, i) => i / 60);
    const truth = ramp[ramp.length - 1]!;

    const oneEuro = run(new OneEuroFilter(RENDER), ramp);
    const oneEuroLag = truth - oneEuro[oneEuro.length - 1]!;

    const tau = 1 / (2 * Math.PI * RENDER.minCutoff);
    const fixed = new LowPassFilter();
    fixed.setAlpha(1 / (1 + tau / (dt / 1000)));
    const fixedOut = ramp.map((sample) => fixed.filter(sample));
    const fixedLag = truth - fixedOut[fixedOut.length - 1]!;

    expect(oneEuroLag).toBeLessThan(fixedLag);
    // And the tracking is genuinely close, not merely closer.
    expect(oneEuroLag).toBeLessThan(0.2);
  });

  it('uses the timestamps, so a slower frame clock smooths differently', () => {
    const fast = new OneEuroFilter(RENDER);
    const slow = new OneEuroFilter(RENDER);
    run(fast, [0, 0, 0, 1], 1000 / 60);
    run(slow, [0, 0, 0, 1], 1000 / 4);

    // The same samples at a lower rate must not produce identical output, or the
    // filter would be ignoring the clock it was given.
    const fastValue = fast.filter(1, 4 * (1000 / 60));
    const slowValue = slow.filter(1, 4 * (1000 / 4));
    expect(fastValue).not.toBeCloseTo(slowValue, 6);
  });

  it('tolerates a repeated or non-monotonic timestamp without dividing by zero', () => {
    const filter = new OneEuroFilter(RENDER);
    filter.filter(0, 0);
    expect(Number.isFinite(filter.filter(1, 0))).toBe(true);
    expect(Number.isFinite(filter.filter(1, -5))).toBe(true);
  });

  it('reset() clears history and reports it', () => {
    const filter = new OneEuroFilter(RENDER);
    filter.filter(1, 0);
    expect(filter.hasHistory()).toBe(true);
    filter.reset();
    expect(filter.hasHistory()).toBe(false);
    expect(filter.filter(0.7, 100)).toBeCloseTo(0.7, 12);
  });
});

describe('LandmarkSmoother', () => {
  it('keeps a filter per landmark per axis', () => {
    const smoother = new LandmarkSmoother(RENDER);
    smoother.filter([{ x: 0.1, y: 0.9 }, { x: 0.8, y: 0.2 }], 0);
    const out = smoother.filter([{ x: 0.1, y: 0.9 }, { x: 0.8, y: 0.2 }], 16);

    expect(out).toHaveLength(2);
    expect(out[0]!.x).toBeCloseTo(0.1, 6);
    expect(out[1]!.x).toBeCloseTo(0.8, 6);
  });

  it('never invents a z the input never carried', () => {
    const smoother = new LandmarkSmoother(RENDER);
    const out = smoother.filter([{ x: 0.1, y: 0.2 }], 0);
    expect('z' in out[0]!).toBe(false);
  });

  it('filters z once the input starts carrying it', () => {
    const smoother = new LandmarkSmoother(RENDER);
    const out = smoother.filter([{ x: 0.1, y: 0.2, z: 0.05 }], 0);
    expect(out[0]!.z).toBeCloseTo(0.05, 12);
  });

  it('reset() clears every per-landmark filter', () => {
    const smoother = new LandmarkSmoother(RENDER);
    smoother.filter([{ x: 0.2, y: 0.2 }], 0);
    smoother.reset();
    expect(smoother.filter([{ x: 0.9, y: 0.9 }], 16)[0]!.x).toBeCloseTo(0.9, 12);
  });
});
