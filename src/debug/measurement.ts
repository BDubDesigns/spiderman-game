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
 * the player explicitly copies (PLAN.md §14.2 forbids building measurement
 * infrastructure).
 *
 * Deliberate honesty about `latencyMs`: on the main-thread path inference is
 * synchronous, so the game loop cannot observe the result until the call has
 * already returned. Latency is therefore measured as frame-callback-start to
 * result-available, which for this configuration is the call cost plus trivial
 * overhead. It is labelled as such in the summary rather than presented as a
 * general end-to-end latency. Separating the two is precisely what a worker
 * configuration would demonstrate — see docs/M1_WORKER_DECISION.md.
 */

/** A percentile summary of one metric, in ms. */
export interface Percentiles {
  p50: number;
  p95: number;
  mean: number;
  /** Population variance. Stutter matters more than the mean (§7.3). */
  variance: number;
  samples: number;
}

/** One labelled fallback or degradation event, for the reliability story. */
export interface MeasurementEvent {
  atMs: number;
  label: string;
}

export interface MeasurementSummary {
  sessionMs: number;
  frames: number;
  detections: number;
  /** Sustained render rate. `p05` is the stutter floor §7.3 asks for. */
  renderFps: { p50: number; p05: number };
  frameTimeMs: Percentiles;
  /** Achieved inference rate over the whole session. */
  inferenceHz: number;
  detectionCostMs: Percentiles;
  /** Frame-callback start to result available. See the file header. */
  detectionLatencyMs: Percentiles;
  fallbackEvents: MeasurementEvent[];
  /** How many frames were rendered while the newest observation was already stale. */
  staleFrames: number;
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
    return { p50: 0, p95: 0, mean: 0, variance: 0, samples: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance =
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length;
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    mean,
    variance,
    samples: sorted.length,
  };
}

export interface MeasurementRecorderOptions {
  /** Rolling window. Samples older than this are dropped. */
  windowMs: number;
}

/**
 * Records the metrics §7.3 requires, over a rolling window.
 *
 * Bounded by construction: every series is trimmed to the window on each record,
 * so a five-minute session (the §17 reliability check) cannot grow without limit.
 */
export class MeasurementRecorder {
  private readonly windowMs: number;
  private startedAtMs: number | null = null;

  private readonly frameTimes: Array<{ at: number; ms: number }> = [];
  private readonly detectionCosts: Array<{ at: number; ms: number }> = [];
  private readonly detectionLatencies: Array<{ at: number; ms: number }> = [];
  private readonly detectionAt: number[] = [];
  private readonly fallbackEvents: MeasurementEvent[] = [];

  private staleFrames = 0;

  constructor(options: MeasurementRecorderOptions) {
    this.windowMs = options.windowMs;
  }

  private trim(series: Array<{ at: number; ms: number }>, nowMs: number): void {
    const cutoff = nowMs - this.windowMs;
    while (series.length > 0 && (series[0]?.at ?? 0) < cutoff) series.shift();
  }

  /** Record one rendered frame's wall time. */
  recordFrame(frameMs: number, nowMs: number): void {
    if (this.startedAtMs === null) this.startedAtMs = nowMs;
    this.frameTimes.push({ at: nowMs, ms: frameMs });
    this.trim(this.frameTimes, nowMs);
  }

  /** Record one detection: its cost and its observed latency. */
  recordDetection(costMs: number, latencyMs: number, nowMs: number): void {
    if (this.startedAtMs === null) this.startedAtMs = nowMs;
    this.detectionCosts.push({ at: nowMs, ms: costMs });
    this.detectionLatencies.push({ at: nowMs, ms: latencyMs });
    this.detectionAt.push(nowMs);
    this.trim(this.detectionCosts, nowMs);
    this.trim(this.detectionLatencies, nowMs);

    const cutoff = nowMs - this.windowMs;
    while (this.detectionAt.length > 0 && (this.detectionAt[0] ?? 0) < cutoff) {
      this.detectionAt.shift();
    }
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

  /** Snapshot the window. Percentiles are computed here, not maintained. */
  summary(nowMs: number): MeasurementSummary {
    this.trim(this.frameTimes, nowMs);
    this.trim(this.detectionCosts, nowMs);
    this.trim(this.detectionLatencies, nowMs);

    const frameMs = this.frameTimes.map((s) => s.ms);
    const costs = this.detectionCosts.map((s) => s.ms);
    const latencies = this.detectionLatencies.map((s) => s.ms);

    // Per-frame FPS samples, so p05 is a real "worst 5% of frames" figure rather
    // than a percentile of a summary.
    const fpsSamples = frameMs
      .filter((value) => value > 0)
      .map((value) => 1000 / value)
      .sort((a, b) => a - b);

    const detectionSpan =
      this.detectionAt.length > 1
        ? (this.detectionAt[this.detectionAt.length - 1] ?? 0) - (this.detectionAt[0] ?? 0)
        : 0;

    return {
      sessionMs: this.startedAtMs === null ? 0 : Math.max(0, nowMs - this.startedAtMs),
      frames: this.frameTimes.length,
      detections: this.detectionAt.length,
      renderFps: {
        p50: percentile(fpsSamples, 0.5),
        p05: percentile(fpsSamples, 0.05),
      },
      frameTimeMs: summarise(frameMs),
      inferenceHz:
        detectionSpan > 0
          ? ((this.detectionAt.length - 1) * 1000) / detectionSpan
          : 0,
      detectionCostMs: summarise(costs),
      detectionLatencyMs: summarise(latencies),
      fallbackEvents: [...this.fallbackEvents],
      staleFrames: this.staleFrames,
    };
  }

  /** The JSON a human copies back. Includes the definition caveat, on purpose. */
  toJson(nowMs: number): string {
    return JSON.stringify(
      {
        note:
          'M1 on-device measurement. detectionLatencyMs is frame-callback-start to result-available, which on the main-thread (synchronous) path is the call cost plus overhead. See docs/M1_WORKER_DECISION.md.',
        measuredAt: new Date().toISOString(),
        ...this.summary(nowMs),
      },
      null,
      2,
    );
  }
}
