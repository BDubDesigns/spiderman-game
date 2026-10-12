/**
 * Unit tests for the on-device measurement recorder (PLAN.md §7.3).
 *
 * This module decides nothing on its own, but it is the only source of the numbers
 * the worker decision is made from, so its arithmetic and its honesty rules are
 * worth pinning: percentiles must reflect the tail, the window must actually trim,
 * and an empty session must not report `NaN`.
 */

import { describe, expect, it } from 'vitest';

import { MeasurementRecorder, type SchedulerSnapshot } from './measurement';

function makeRecorder(windowMs = 60_000) {
  return new MeasurementRecorder({ windowMs });
}

/** Record `count` frames of a fixed duration, starting at `atMs`. */
function recordFrames(recorder: MeasurementRecorder, ms: number, count: number, atMs = 0) {
  for (let i = 0; i < count; i += 1) recorder.recordFrame(ms, atMs + i);
}

describe('MeasurementRecorder summary', () => {
  it('reports zeroes rather than NaN for an empty session', () => {
    const summary = makeRecorder().summary(0);

    expect(summary.frames).toBe(0);
    expect(summary.detections).toBe(0);
    expect(summary.frameTimeMs).toEqual({
      p50: 0,
      p95: 0,
      p99: 0,
      max: 0,
      mean: 0,
      variance: 0,
      samples: 0,
    });
    expect(JSON.stringify(summary)).not.toMatch(/NaN|Infinity/);
  });

  it('computes percentiles, mean and max from the samples', () => {
    const recorder = makeRecorder();
    for (let ms = 1; ms <= 10; ms += 1) recorder.recordFrame(ms, ms);

    const stats = recorder.summary(10).frameTimeMs;

    expect(stats.samples).toBe(10);
    expect(stats.p50).toBe(6);
    expect(stats.p95).toBe(10);
    expect(stats.p99).toBe(10);
    expect(stats.max).toBe(10);
    expect(stats.mean).toBeCloseTo(5.5, 10);
  });

  it('exposes a tail that p50 and p95 hide', () => {
    // The reason `p99`/`max` were added: a first device run had a comfortable p50
    // and a variance that is arithmetically impossible without a few very slow
    // calls. A tail inferred from a variance is not evidence; this records it.
    const recorder = makeRecorder();
    recordFrames(recorder, 10, 99);
    recorder.recordFrame(1000, 99);

    const stats = recorder.summary(100).frameTimeMs;

    expect(stats.p50).toBe(10);
    expect(stats.p95).toBe(10);
    expect(stats.max).toBe(1000);
  });

  it('is monotonic across percentiles', () => {
    const recorder = makeRecorder();
    for (const ms of [4, 9, 12, 30, 8, 55, 11, 7, 300, 6]) recorder.recordFrame(ms, ms);

    const stats = recorder.summary(10).frameTimeMs;

    expect(stats.p50).toBeLessThanOrEqual(stats.p95);
    expect(stats.p95).toBeLessThanOrEqual(stats.p99);
    expect(stats.p99).toBeLessThanOrEqual(stats.max);
  });

  it('derives render FPS from the frame times', () => {
    const recorder = makeRecorder();
    recordFrames(recorder, 1000 / 120, 50);

    const summary = recorder.summary(50);

    expect(summary.renderFps.p50).toBeCloseTo(120, 0);
    expect(summary.renderFps.p05).toBeCloseTo(120, 0);
  });

  it('trims samples that fall outside the window', () => {
    const recorder = makeRecorder(100);
    recordFrames(recorder, 10, 5, 0);
    recorder.recordFrame(10, 1000);

    const summary = recorder.summary(1000);

    // Everything older than (now - window) is gone, so one sample remains.
    expect(summary.frameTimeMs.samples).toBe(1);
  });

  it('separates cost from latency and counts detections', () => {
    const recorder = makeRecorder();
    recorder.recordDetection(20, 25, 0);
    recorder.recordDetection(30, 35, 100);

    const summary = recorder.summary(100);

    expect(summary.detections).toBe(2);
    // Cost and latency are recorded separately even though the main-thread path
    // makes them equal today; a worker would separate them.
    expect(summary.detectionCostMs.max).toBe(30);
    expect(summary.detectionLatencyMs.max).toBe(35);
    // Two detections 100 ms apart is a 10 Hz achieved rate.
    expect(summary.inferenceHz).toBeCloseTo(10, 6);
  });

  it('counts stale frames and keeps fallback events as a list', () => {
    const recorder = makeRecorder();
    recorder.recordFrame(8, 0);
    recorder.recordStaleFrame();
    recorder.recordStaleFrame();
    recorder.recordFallback('GPU delegate unavailable', 5);

    const summary = recorder.summary(10);

    expect(summary.staleFrames).toBe(2);
    expect(summary.fallbackEvents).toEqual([
      { atMs: 5, label: 'GPU delegate unavailable' },
    ]);
    expect(recorder.events).toHaveLength(1);
  });

  it('reports the session length from the first sample', () => {
    const recorder = makeRecorder();
    recorder.recordFrame(8, 1000);

    expect(recorder.summary(4000).sessionMs).toBe(3000);
  });
});

describe('MeasurementRecorder export', () => {
  const scheduler: SchedulerSnapshot = {
    inferenceHz: 5.5,
    predictedCostMs: 21.4,
    frameBudgetMs: 41.7,
    runs: 643,
    skipsRateCap: 0,
    skipsOverBudget: 900,
    forcedRuns: 12,
  };

  it('includes the scheduler snapshot so the achieved rate is interpretable', () => {
    const recorder = makeRecorder();
    recorder.recordFrame(8, 0);

    const parsed = JSON.parse(recorder.toJson(10, scheduler)) as Record<string, unknown>;

    expect(parsed['scheduler']).toEqual(scheduler);
    expect(parsed['measuredAt']).toBeTypeOf('string');
  });

  it('reports a null scheduler rather than omitting the key', () => {
    const recorder = makeRecorder();
    const parsed = JSON.parse(recorder.toJson(0)) as Record<string, unknown>;

    // A missing key and a null one mean different things to whoever reads it back.
    expect(parsed).toHaveProperty('scheduler', null);
  });

  it('carries the caveat about what latency means on the main thread', () => {
    const recorder = makeRecorder();
    const parsed = JSON.parse(recorder.toJson(0)) as Record<string, unknown>;

    expect(String(parsed['note'])).toContain('main-thread');
    expect(String(parsed['note'])).toContain('M1_WORKER_DECISION.md');
  });
});
