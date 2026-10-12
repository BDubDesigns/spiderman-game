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

describe('MeasurementRecorder hand presence', () => {
  it('separates frames with hands from frames without', () => {
    // The gap that made a 13.7-minute export uninterpretable: "tracked perfectly"
    // and "detected nothing" produced identical output.
    const recorder = makeRecorder();
    for (let i = 0; i < 6; i += 1) recorder.recordFrame(8, i, 2);
    for (let i = 0; i < 4; i += 1) recorder.recordFrame(8, 100 + i, 0);

    const summary = recorder.summary(200);

    expect(summary.framesWithHands).toBe(6);
    expect(summary.framesWithNoHands).toBe(4);
  });

  it('ignores non-camera frames rather than counting them as empty', () => {
    const recorder = makeRecorder();
    recorder.recordFrame(8, 0); // no hand count supplied
    recorder.recordFrame(8, 1, 1);

    const summary = recorder.summary(10);

    expect(summary.framesWithHands).toBe(1);
    expect(summary.framesWithNoHands).toBe(0);
    expect(summary.frames).toBe(2);
  });
});

describe('MeasurementRecorder timeline', () => {
  it('keeps one bucket per interval with means, worst frame and hand counts', () => {
    const recorder = new MeasurementRecorder({ windowMs: 60_000, bucketMs: 1000 });

    // Bucket 0: three frames, worst 30 ms, two with hands.
    recorder.recordFrame(8, 0, 1);
    recorder.recordFrame(8, 1, 0);
    recorder.recordFrame(30, 2, 1);
    recorder.recordDetection(12, 12, 2);
    // Bucket 1: one frame.
    recorder.recordFrame(10, 1500, 0);

    const timeline = recorder.timeline();

    expect(timeline).toHaveLength(2);
    expect(timeline[0]).toMatchObject({
      tMs: 0,
      frames: 3,
      maxFrameMs: 30,
      detections: 1,
      meanCostMs: 12,
      framesWithHands: 2,
      framesWithNoHands: 1,
    });
    expect(timeline[0]!.meanFrameMs).toBeCloseTo((8 + 8 + 30) / 3, 6);
    // minFps is the worst frame in the bucket, which is what reads as a hitch.
    expect(timeline[0]!.minFps).toBeCloseTo(1000 / 30, 6);
    expect(timeline[1]).toMatchObject({ tMs: 1000, frames: 1, framesWithNoHands: 1 });
  });

  it('skips idle intervals instead of recording fake zero buckets', () => {
    // The tab not rendering is not the same as rendering at zero FPS, and an
    // earlier export was misread because the two looked alike.
    const recorder = new MeasurementRecorder({ windowMs: 60_000, bucketMs: 1000 });
    recorder.recordFrame(8, 0);
    recorder.recordFrame(8, 5000);

    const timeline = recorder.timeline();

    expect(timeline.map((bucket) => bucket.tMs)).toEqual([0, 5000]);
  });

  it('covers the whole session even when the window has moved on', () => {
    const recorder = new MeasurementRecorder({ windowMs: 1000, bucketMs: 1000 });
    recorder.recordFrame(8, 0);
    recorder.recordFrame(8, 10_000, 1);

    const summary = recorder.summary(10_000);

    // The window holds only recent samples...
    expect(summary.frames).toBe(1);
    // ...but the session totals and the timeline hold everything.
    expect(summary.sessionFrames).toBe(2);
    expect(recorder.timeline().map((bucket) => bucket.tMs)).toEqual([0, 10_000]);
  });

  it('labels the window explicitly so it cannot be misread', () => {
    const recorder = makeRecorder(120_000);
    recorder.recordFrame(8, 0);

    const summary = recorder.summary(0);

    expect(summary.windowMs).toBe(120_000);
    expect(summary.sessionFrames).toBe(1);
    expect(summary.sessionDetections).toBe(0);
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

  it('includes the session timeline so degradation is visible', () => {
    const recorder = new MeasurementRecorder({ windowMs: 60_000, bucketMs: 1000 });
    recorder.recordFrame(8, 0, 1);
    recorder.recordFrame(40, 1200, 1);

    const parsed = JSON.parse(recorder.toJson(2000)) as { timeline: unknown[] };

    expect(Array.isArray(parsed.timeline)).toBe(true);
    expect(parsed.timeline).toHaveLength(2);
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
