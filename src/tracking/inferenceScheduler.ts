/**
 * Adaptive inference scheduling (PLAN.md §7.1).
 *
 * "Inference is adaptive, not fixed. The 24–30 Hz inference success condition is
 * removed. Rendering FPS and inference frequency are decoupled."
 *
 * The policy implemented here:
 *
 * - Never run faster than `maxInferenceHz`, so inference cannot monopolise frames.
 * - Always run at least every `1 / minInferenceHz`, so a slow device still tracks
 *   rather than freezing on a stale hand.
 * - Between those bounds, run only when the *predicted* cost of the call fits
 *   inside `inferenceBudgetFraction` of the observed frame budget. Prediction is a
 *   moving average of measured call duration, so the estimate tracks the device
 *   rather than a number someone guessed.
 *
 * The scheduler is pure and clock-driven by its caller: it never reads a clock or
 * schedules a timer itself, which is what makes the whole policy testable.
 *
 * It decides *whether* to run. It cannot make a synchronous call asynchronous —
 * see `docs/M1_WORKER_DECISION.md` for why that matters on the main thread.
 */

/** Observable scheduling state, surfaced in the debug HUD (§7.2). */
export interface InferenceSchedulerStats {
  /** Measured achieved inference rate, from actual run timestamps. */
  inferenceHz: number;
  /** Predicted cost of the next call, in ms (moving average). */
  predictedCostMs: number;
  /** Duration of the most recent call, in ms. */
  lastCostMs: number;
  /** Observed frame budget basis, in ms (moving average of frame intervals). */
  frameBudgetMs: number;
  runs: number;
  /** Frames skipped because the predicted cost would not fit the budget. */
  skipsOverBudget: number;
  /** Frames skipped by the `maxInferenceHz` rate cap. */
  skipsRateCap: number;
  /** Runs forced by the `minInferenceHz` floor. */
  forcedRuns: number;
}

export interface InferenceSchedulerOptions {
  minInferenceHz: number;
  maxInferenceHz: number;
  inferenceBudgetFraction: number;
  costEmaAlpha: number;
  /** Cost assumed before anything is measured, in ms. */
  initialCostEstimateMs: number;
  /** Frame-interval basis before any frame has been observed, in ms. */
  initialFrameBudgetMs?: number;
  /** How many run timestamps the measured Hz averages over. */
  hzWindow?: number;
}

export class InferenceScheduler {
  readonly stats: InferenceSchedulerStats;

  private readonly minHz: number;
  private readonly maxHz: number;
  private readonly budgetFraction: number;
  private readonly alpha: number;
  private readonly hzWindow: number;

  private readonly runStamps: number[] = [];
  private lastRunMs = 0;
  private hasRun = false;
  private lastFrameMs: number | null = null;

  constructor(options: InferenceSchedulerOptions) {
    if (!(options.minInferenceHz > 0)) {
      throw new RangeError(`minInferenceHz must be positive, got ${options.minInferenceHz}`);
    }
    if (!(options.maxInferenceHz > 0)) {
      throw new RangeError(`maxInferenceHz must be positive, got ${options.maxInferenceHz}`);
    }
    if (options.maxInferenceHz < options.minInferenceHz) {
      throw new RangeError(
        `maxInferenceHz (${options.maxInferenceHz}) must be >= minInferenceHz (${options.minInferenceHz})`,
      );
    }

    this.minHz = options.minInferenceHz;
    this.maxHz = options.maxInferenceHz;
    this.budgetFraction = options.inferenceBudgetFraction;
    this.alpha = options.costEmaAlpha;
    this.hzWindow = options.hzWindow ?? 32;

    this.stats = {
      inferenceHz: 0,
      predictedCostMs: options.initialCostEstimateMs,
      lastCostMs: 0,
      frameBudgetMs: options.initialFrameBudgetMs ?? 1000 / 30,
      runs: 0,
      skipsOverBudget: 0,
      skipsRateCap: 0,
      forcedRuns: 0,
    };
  }

  /** Minimum interval between runs, from `maxInferenceHz`. */
  private get minIntervalMs(): number {
    return 1000 / this.maxHz;
  }

  /** Maximum interval between runs, from `minInferenceHz`. */
  private get maxIntervalMs(): number {
    return 1000 / this.minHz;
  }

  /**
   * Report that a frame was displayed at `nowMs`.
   *
   * Frame intervals are what inference has to fit inside, so the budget basis is
   * measured rather than assumed. A zero or negative delta (two callbacks on the
   * same timestamp) is ignored rather than allowed to poison the average.
   */
  observeFrame(nowMs: number): void {
    const previous = this.lastFrameMs;
    this.lastFrameMs = nowMs;
    if (previous === null) return;
    const delta = nowMs - previous;
    if (!(delta > 0)) return;
    this.stats.frameBudgetMs =
      this.stats.frameBudgetMs * (1 - this.alpha) + delta * this.alpha;
  }

  /**
   * Whether inference should run at `nowMs`.
   *
   * Call once per new source frame. Returning `false` is normal and expected: it
   * is how the render loop keeps its budget.
   */
  shouldRun(nowMs: number): boolean {
    if (!this.hasRun) return true;

    const sinceLastRun = nowMs - this.lastRunMs;

    if (sinceLastRun < this.minIntervalMs) {
      this.stats.skipsRateCap += 1;
      return false;
    }

    // The floor wins over the budget: a device too slow to afford inference still
    // has to track, just infrequently.
    if (sinceLastRun >= this.maxIntervalMs) {
      this.stats.forcedRuns += 1;
      return true;
    }

    const affordable = this.budgetFraction * this.stats.frameBudgetMs;
    if (this.stats.predictedCostMs > affordable) {
      this.stats.skipsOverBudget += 1;
      return false;
    }

    return true;
  }

  /**
   * Record how long a call actually took.
   *
   * `durationMs` should be the measured wall time of the synchronous detect call.
   */
  recordRun(durationMs: number, nowMs: number): void {
    const measured = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;

    this.stats.lastCostMs = measured;
    this.stats.predictedCostMs =
      this.stats.predictedCostMs * (1 - this.alpha) + measured * this.alpha;
    this.stats.runs += 1;

    this.lastRunMs = nowMs;
    this.hasRun = true;

    this.runStamps.push(nowMs);
    if (this.runStamps.length > this.hzWindow) this.runStamps.shift();

    const first = this.runStamps[0];
    const last = this.runStamps[this.runStamps.length - 1];
    if (first === undefined || last === undefined || this.runStamps.length < 2) {
      this.stats.inferenceHz = 0;
      return;
    }
    const span = last - first;
    this.stats.inferenceHz =
      span > 0 ? ((this.runStamps.length - 1) * 1000) / span : 0;
  }

  /** Reset the measured history, keeping configuration. */
  reset(): void {
    this.runStamps.length = 0;
    this.hasRun = false;
    this.lastRunMs = 0;
    this.lastFrameMs = null;
    this.stats.inferenceHz = 0;
    this.stats.lastCostMs = 0;
    this.stats.runs = 0;
    this.stats.skipsOverBudget = 0;
    this.stats.skipsRateCap = 0;
    this.stats.forcedRuns = 0;
  }
}
