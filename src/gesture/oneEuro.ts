/**
 * One Euro filter (PLAN.md §11.6).
 *
 * A low-pass filter whose cutoff rises with the signal's speed: slow movement is
 * smoothed hard (little jitter), fast movement is smoothed lightly (little lag).
 * That trade-off is exactly what hand tracking needs, and a fixed-cutoff filter
 * cannot make it.
 *
 * Reference: Casiez, Roussel & Vogel, "1€ Filter" (CHI 2012).
 *
 * Pure and dependency-free: no DOM, no MediaPipe, so it unit-tests directly.
 */

/** Tuning for one filter instance. */
export interface OneEuroOptions {
  /** Baseline cutoff in Hz. Lower = smoother but laggier when still. */
  minCutoff: number;
  /** How aggressively the cutoff rises with speed. Higher = less lag when moving. */
  beta: number;
  /** Cutoff for the derivative estimate itself. Almost never needs tuning. */
  dCutoff: number;
}

/** A scalar One Euro filter. */
export class LowPassFilter {
  private value: number | null = null;

  constructor(private alpha = 1) {}

  /** Set the smoothing factor, `[0,1]`: 1 means "take the new sample as-is". */
  setAlpha(alpha: number): void {
    this.alpha = alpha;
  }

  lastValue(): number | null {
    return this.value;
  }

  hasLastValue(): boolean {
    return this.value !== null;
  }

  /** Filter `sample`, seeding the filter from it on the first call. */
  filter(sample: number): number {
    if (this.value === null) {
      this.value = sample;
      return sample;
    }
    const filtered = this.alpha * sample + (1 - this.alpha) * this.value;
    this.value = filtered;
    return filtered;
  }

  reset(): void {
    this.value = null;
  }
}

function smoothingFactor(cutoffHz: number, dtSeconds: number): number {
  // The standard derivation. `tau` is the filter's time constant in seconds.
  const tau = 1 / (2 * Math.PI * cutoffHz);
  return 1 / (1 + tau / dtSeconds);
}

/**
 * One Euro filter for a single scalar signal.
 *
 * `dtSeconds` is passed per sample rather than fixed, because a real frame clock
 * is jittery and a filter that assumes a constant rate mis-tunes itself exactly
 * when the rate changes.
 */
export class OneEuroFilter {
  private readonly x = new LowPassFilter();
  private readonly dx = new LowPassFilter();
  private lastTimestampMs: number | null = null;

  constructor(readonly options: OneEuroOptions) {}

  reset(): void {
    this.x.reset();
    this.dx.reset();
    this.lastTimestampMs = null;
  }

  hasHistory(): boolean {
    return this.x.hasLastValue();
  }

  filter(sample: number, timestampMs: number): number {
    const previous = this.lastTimestampMs;
    // Guard against a zero or negative interval, which would divide by zero.
    const dtSeconds =
      previous === null ? 1 / 60 : Math.max((timestampMs - previous) / 1000, 1 / 240);
    this.lastTimestampMs = timestampMs;

    const previousValue = this.x.lastValue();
    const derivative = previousValue === null ? 0 : (sample - previousValue) / dtSeconds;

    this.dx.setAlpha(smoothingFactor(this.options.dCutoff, dtSeconds));
    const filteredDerivative = this.dx.filter(derivative);

    // The whole point: cutoff tracks the signal's speed.
    const cutoff = this.options.minCutoff + this.options.beta * Math.abs(filteredDerivative);
    this.x.setAlpha(smoothingFactor(cutoff, dtSeconds));

    return this.x.filter(sample);
  }
}

/** A point in whatever space the caller is filtering. */
export interface FilterPoint {
  x: number;
  y: number;
  z?: number;
}

/**
 * One Euro filtering for a whole landmark set, one filter per landmark per axis.
 *
 * Filters are keyed by landmark index rather than array position, and `z` is
 * filtered only when the input carries it — the raw landmark's `z` is otherwise
 * absent, and inventing a filtered zero would be fabricating data (§8 Rule C).
 */
export class LandmarkSmoother {
  private readonly x: OneEuroFilter[] = [];
  private readonly y: OneEuroFilter[] = [];
  private readonly z: OneEuroFilter[] = [];
  private hasZ = false;

  constructor(private readonly options: OneEuroOptions) {}

  reset(): void {
    for (const filter of [...this.x, ...this.y, ...this.z]) filter.reset();
  }

  filter<TPoint extends FilterPoint>(
    points: readonly TPoint[],
    timestampMs: number,
  ): { x: number; y: number; z?: number }[] {
    const carriesZ = points.some((point) => point.z !== undefined);
    if (carriesZ) this.hasZ = true;

    return points.map((point, index) => {
      const fx = (this.x[index] ??= new OneEuroFilter(this.options));
      const fy = (this.y[index] ??= new OneEuroFilter(this.options));
      const filtered: { x: number; y: number; z?: number } = {
        x: fx.filter(point.x, timestampMs),
        y: fy.filter(point.y, timestampMs),
      };

      // Only emit `z` if any frame has carried one, so the output shape matches
      // the raw landmark type rather than gaining a field it never had.
      if (this.hasZ) {
        const fz = (this.z[index] ??= new OneEuroFilter(this.options));
        filtered.z = fz.filter(point.z ?? 0, timestampMs);
      }
      return filtered;
    });
  }
}
