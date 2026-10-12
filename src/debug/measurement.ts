/**
 * On-device measurement harness (PLAN.md §7.3, §14.3).
 *
 * §7.3 makes the worker decision a measurement question, not an assumption:
 *
 * > Measure on the Pixel 10 Pro XL in Chrome, for each candidate configuration:
 * > sustained render FPS (p50, p05), frame-time stability (variance, p95),
 * > end-to-end landmark latency (p50, p95), achieved inference frequency, control
 * > lag felt by a human, and reliability.
 *
 * This module collects the machine-measurable half of that list so a human can run
 * one session and hand back numbers. It is a recorder, not a telemetry system:
 * nothing leaves the device, there is no collector, and the export is a JSON blob
 * the player explicitly copies (PLAN.md §14.2 forbids measurement infrastructure).
 *
 * ---- Three things a real 13.7-minute session taught this module ----
 *
 * 1. **A rolling window cannot answer "did it degrade?".** The windowed percentiles
 *    cover only the last `windowMs`, so a long session's export said nothing about
 *    its first 11 minutes. `timeline()` now keeps one bucket per interval for the
 *    whole session, which is what a thermal-collapse check actually needs.
 * 2. **"No hands" and "hands tracked perfectly" looked identical.** Nothing counted
 *    hand presence, so an export could not distinguish a working tracker from one
 *    detecting nothing at all. Frames now carry a hand count.
 * 3. **Windowed and cumulative counters were silently mixed.** `detections` was
 *    windowed while the scheduler's `runs` was cumulative, and comparing the two
 *    suggested an 84%-failure rate that did not exist. The window is now labelled
 *    explicitly and the cumulative totals are separate fields.
 *
 * ---- A note on `latencyMs` ----
 *
 * On the main-thread path inference is synchronous, so the game loop cannot observe
 * the result until the call has already returned. Latency is therefore measured as
 * frame-callback-start to result-available, which for this configuration is the call
 * cost plus trivial overhead. It is labelled as such rather than presented as a
 * general end-to-end latency. Separating the two is what a worker would demonstrate.
 */

/** A percentile summary of one metric, in ms. */
export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
  /** Population variance. Stutter matters more than the mean (§7.3). */
  variance: number;
  samples: number;
}

/**
 * The scheduler's own view, recorded alongside the raw timings.
 *
 * Without this, "achieved 19.4 Hz" is uninterpretable: it could mean the rate cap
 * bound it, the floor forced it, or the budget permitted it. §7.3 is a decision
 * about *why* inference ran at the rate it did.
 */
export interface SchedulerSnapshot {
  inferenceHz: number;
  predictedCostMs: number;
  frameBudgetMs: number;
  runs: number;
  skipsRateCap: number;
  skipsOverBudget: number;
  forcedRuns: number;
}

/**
 * One interval of the session-wide timeline.
 *
 * This is the shape that answers "did it hold up?", which percentiles over a window
 * cannot: a collapsing frame rate shows up as a falling rate and a rising
 * `maxFrameMs` across successive buckets.
 */
export interface TimelineBucket {
  /** Bucket start, ms since the first sample. */
  tMs: number;
  frames: number;
  meanFrameMs: number;
  maxFrameMs: number;
  /** Lowest instantaneous FPS in the bucket, i.e. `1000 / maxFrameMs`. */
  minFps: number;
  detections: number;
  meanCostMs: number;
  maxCostMs: number;
  framesWithHands: number;
  framesWithNoHands: number;
}

/** One labelled fallback or degradation event, for the reliability story. */
export interface MeasurementEvent {
  atMs: number;
  label: string;
}

export interface MeasurementSummary {
  /** How far back the windowed percentiles below reach. */
  windowMs: number;
  /** Whole-session duration, measured from the first sample. */
  sessionMs: number;
  /** Frames inside the window. */
  frames: number;
  /** Detections inside the window. */
  detections: number;
  /** Frames since the session began, ignoring the window. */
  sessionFrames: number;
  /** Detections since the session began, ignoring the window. */
  sessionDetections: number;
  /** Frames in the window where at least one hand was present. */
  framesWithHands: number;
  /** Frames in the window where the tracker reported no hands. */
  framesWithNoHands: number;
  /** Sustained render rate. `p05` is the stutter floor §7.3 asks for. */
  renderFps: { p50: number; p05: number };
  frameTimeMs: Percentiles;
  /** Achieved inference rate over the window. */
  inferenceHz: number;
  detectionCostMs: Percentiles;
  /** Frame-callback start to result available. See the file header. */
  detectionLatencyMs: Percentiles;
  fallbackEvents: MeasurementEvent[];
  /** How many frames were rendered while the newest observation was already stale. */
  staleFrames: number;
}

interface FrameSample {
  at: number;
  ms: number;
  /** Hands reported for this frame, or `null` when it was not a camera frame. */
  hands: number | null;
}

interface BucketAccumulator {
  index: number;
  frames: number;
  frameSum: number;
  frameMax: number;
  detections: number;
  costSum: number;
  costMax: number;
  withHands: number;
  withoutHands: number;
}

function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[index] ?? 0;
}

function summarise(samples: readonly number[]): Percentiles {
  if (samples.length === 0) {
    return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0, variance: 0, samples: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? 0,
    mean,
    variance,
    samples: sorted.length,
  };
}

export interface MeasurementRecorderOptions {
  /** Rolling window for the percentile summary. Older samples are dropped. */
  windowMs: number;
  /** Length of one timeline bucket. Defaults to 10 s. */
  bucketMs?: number;
}

const DEFAULT_BUCKET_MS = 10_000;

/**
 * Records the metrics §7.3 requires over a rolling window, plus a bucketed timeline
 * covering the whole session.
 *
 * Bounded by construction: the windowed series are trimmed on every record, and the
 * timeline keeps one small object per bucket, so a 30-minute session costs a few
 * hundred entries rather than a few hundred thousand.
 */
export class MeasurementRecorder {
  private readonly windowMs: number;
  private readonly bucketMs: number;

  private startedAtMs: number | null = null;

  private readonly frameTimes: FrameSample[] = [];
  private readonly detectionCosts: Array<{ at: number; ms: number }> = [];
  private readonly detectionLatencies: Array<{ at: number; ms: number }> = [];
  private readonly detectionAt: number[] = [];
  private readonly fallbackEvents: MeasurementEvent[] = [];

  private readonly buckets: TimelineBucket[] = [];
  private current: BucketAccumulator | null = null;

  private sessionFrames = 0;
  private sessionDetections = 0;
  private staleFrames = 0;

  constructor(options: MeasurementRecorderOptions) {
    this.windowMs = options.windowMs;
    this.bucketMs = options.bucketMs ?? DEFAULT_BUCKET_MS;
  }

  private trim(series: Array<{ at: number }>, nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (series.length > 0 && (series[0]?.at ?? 0) < cutoff) series.shift();
  }

  /** The same trim for a bare list of timestamps. */
  private trimTimes(series: number[], nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (series.length > 0 && (series[0] ?? 0) < cutoff) series.shift();
  }

  /** Get the accumulator for `nowMs`, finalizing the previous bucket if needed. */
  private touch(nowMs: number): BucketAccumulator {
    if (this.startedAtMs === null) this.startedAtMs = nowMs;
    const index = Math.floor((nowMs - this.startedAtMs) / this.bucketMs);

    if (this.current !== null && this.current.index === index) {
      return this.current;
    }

    this.flushBucket();
    this.current = {
      index,
      frames: 0,
      frameSum: 0,
      frameMax: 0,
      detections: 0,
      costSum: 0,
      costMax: 0,
      withHands: 0,
      withoutHands: 0,
    };
    return this.current;
  }

  private static toBucket(
    accumulator: BucketAccumulator,
    bucketMs: number,
  ): TimelineBucket {
    return {
      tMs: accumulator.index * bucketMs,
      frames: accumulator.frames,
      meanFrameMs:
        accumulator.frames > 0 ? accumulator.frameSum / accumulator.frames : 0,
      maxFrameMs: accumulator.frameMax,
      // The worst frame in the bucket is the one that reads as a visible hitch.
      minFps: accumulator.frameMax > 0 ? 1000 / accumulator.frameMax : 0,
      detections: accumulator.detections,
      meanCostMs:
        accumulator.detections > 0 ? accumulator.costSum / accumulator.detections : 0,
      maxCostMs: accumulator.costMax,
      framesWithHands: accumulator.withHands,
      framesWithNoHands: accumulator.withoutHands,
    };
  }

  private flushBucket(): void {
    const accumulator = this.current;
    this.current = null;
    if (accumulator === null) return;
    // Idle intervals produce no samples and are simply not recorded, so the
    // timeline has gaps where the tab was not rendering rather than fake zeroes.
    if (accumulator.frames === 0 && accumulator.detections === 0) return;
    this.buckets.push(MeasurementRecorder.toBucket(accumulator, this.bucketMs));
  }

  /**
   * Record one rendered frame's wall time.
   *
   * `handCount` is how many hands the tracker reported for that frame, or `null`
   * when the frame did not come from the camera. Distinguishing "no hands" from
   * "hands tracked" is the difference between a working tracker and a dead one, and
   * an earlier export could not tell them apart.
   */
  recordFrame(frameMs: number, nowMs: number, handCount: number | null = null): void {
    const accumulator = this.touch(nowMs);

    accumulator.frames += 1;
    accumulator.frameSum += frameMs;
    accumulator.frameMax = Math.max(accumulator.frameMax, frameMs);
    if (handCount !== null) {
      if (handCount > 0) accumulator.withHands += 1;
      else accumulator.withoutHands += 1;
    }

    this.sessionFrames += 1;
    this.frameTimes.push({ at: nowMs, ms: frameMs, hands: handCount });
    this.trim(this.frameTimes, nowMs);
  }

  /** Record one detection: its cost and its observed latency. */
  recordDetection(costMs: number, latencyMs: number, nowMs: number): void {
    const accumulator = this.touch(nowMs);

    accumulator.detections += 1;
    accumulator.costSum += costMs;
    accumulator.costMax = Math.max(accumulator.costMax, costMs);

    this.sessionDetections += 1;
    this.detectionCosts.push({ at: nowMs, ms: costMs });
    this.detectionLatencies.push({ at: nowMs, ms: latencyMs });
    this.detectionAt.push(nowMs);
    this.trim(this.detectionCosts, nowMs);
    this.trim(this.detectionLatencies, nowMs);
    this.trimTimes(this.detectionAt, nowMs);
  }

  /** Count a frame drawn with an already-stale observation (§7.2). */
  recordStaleFrame(): void {
    this.staleFrames += 1;
  }

  /** Record a fallback or degradation transition for the reliability story. */
  recordFallback(label: string, nowMs: number): void {
    this.fallbackEvents.push({ atMs: nowMs, label });
  }

  get events(): readonly MeasurementEvent[] {
    return this.fallbackEvents;
  }

  /** One bucket per interval for the whole session, including the in-progress one. */
  timeline(): TimelineBucket[] {
    const finished = [...this.buckets];
    if (this.current !== null) {
      finished.push(MeasurementRecorder.toBucket(this.current, this.bucketMs));
    }
    return finished;
  }

  /** Snapshot the window. Percentiles are computed here, not maintained. */
  summary(nowMs: number): MeasurementSummary {
    this.trim(this.frameTimes, nowMs);
    this.trim(this.detectionCosts, nowMs);
    this.trim(this.detectionLatencies, nowMs);
    this.trimTimes(this.detectionAt, nowMs);

    const frameMs = this.frameTimes.map((sample) => sample.ms);
    const costs = this.detectionCosts.map((sample) => sample.ms);
    const latencies = this.detectionLatencies.map((sample) => sample.ms);

    let framesWithHands = 0;
    let framesWithNoHands = 0;
    for (const sample of this.frameTimes) {
      if (sample.hands === null) continue;
      if (sample.hands > 0) framesWithHands += 1;
      else framesWithNoHands += 1;
    }

    // Per-frame FPS samples, so p05 is a real "worst 5% of frames" figure rather
    // than a percentile of a summary.
    const fpsSamples = frameMs
      .filter((value) => value > 0)
      .map((value) => 1000 / value)
      .sort((a, b) => a - b);

    const detectionSpan =
      this.detectionAt.length > 1
        ? (this.detectionAt[this.detectionAt.length - 1] ?? 0) -
          (this.detectionAt[0] ?? 0)
        : 0;

    return {
      windowMs: this.windowMs,
      sessionMs: this.startedAtMs === null ? 0 : Math.max(0, nowMs - this.startedAtMs),
      frames: this.frameTimes.length,
      detections: this.detectionAt.length,
      sessionFrames: this.sessionFrames,
      sessionDetections: this.sessionDetections,
      framesWithHands,
      framesWithNoHands,
      renderFps: {
        p50: percentile(fpsSamples, 0.5),
        p05: percentile(fpsSamples, 0.05),
      },
      frameTimeMs: summarise(frameMs),
      inferenceHz:
        detectionSpan > 0 ? ((this.detectionAt.length - 1) * 1000) / detectionSpan : 0,
      detectionCostMs: summarise(costs),
      detectionLatencyMs: summarise(latencies),
      fallbackEvents: [...this.fallbackEvents],
      staleFrames: this.staleFrames,
    };
  }

  /**
   * The JSON a human copies back. Includes the definition caveats on purpose: every
   * misreading of an earlier export traced back to a missing label.
   *
   * `scheduler` is optional so the export still works when no detector is running.
   */
  toJson(nowMs: number, scheduler: SchedulerSnapshot | null = null): string {
    return JSON.stringify(
      {
        note:
          'M1 on-device measurement. `frames`, `detections` and the percentiles cover only the last `windowMs`; `sessionFrames`, `sessionDetections` and `timeline` cover the whole session. `detectionLatencyMs` is frame-callback-start to result-available, which on the main-thread (synchronous) path is the call cost plus overhead. `scheduler` explains why inference ran at the rate it did (rate cap vs budget vs floor). See docs/M1_WORKER_DECISION.md.',
        measuredAt: new Date().toISOString(),
        ...this.summary(nowMs),
        scheduler,
        timeline: this.timeline(),
      },
      null,
      2,
    );
  }
}
