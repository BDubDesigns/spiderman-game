/**
 * Long animation frame reporting (Chrome's `long-animation-frame` entry type).
 *
 * This exists to answer one question with evidence instead of inference: **is
 * inference actually blocking rendering?**
 *
 * The reason it matters: measured on the target laptop, `detectForVideo` costs a
 * ~9 ms median and runs ~19 times a second on the main thread — about 18% of wall
 * time — yet the render loop holds p50 120.5 fps with p05 119.0 and a frame-time
 * variance of ~1 ms². Those two facts are hard to reconcile by reasoning about
 * `requestAnimationFrame` deltas alone, and "the numbers say it is fine but I cannot
 * explain why" is not a basis for deciding whether to build a worker.
 *
 * `long-animation-frame` entries are Chrome's own account of frames where rendering
 * was delayed, including `blockingDuration` and which script was responsible. That
 * is direct evidence rather than a derivation, and it names the culprit.
 *
 * Everything here is optional and feature-detected: browsers without the entry type
 * simply report `unsupported`, and nothing else in the app depends on it.
 */

/** One animation frame that ran long, reduced to what is worth recording. */
export interface LongFrameSample {
  /** Total frame duration, ms. */
  durationMs: number;
  /** The part of it that delayed rendering, ms. */
  blockingMs: number;
  /**
   * The `invoker` of the longest script in the frame, e.g. a callback name. Empty
   * when Chrome did not attribute the work to a script.
   */
  topInvoker: string;
}

/** The bits of a script record this module reads. */
interface ScriptLike {
  duration?: unknown;
  invoker?: unknown;
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The longest script in a frame, or `null` when none is reported. */
function longestScript(scripts: unknown): ScriptLike | null {
  if (!Array.isArray(scripts)) return null;
  let best: ScriptLike | null = null;
  let bestDuration = -1;
  for (const candidate of scripts) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const script = candidate as ScriptLike;
    const duration = numberOf(script.duration);
    if (duration > bestDuration) {
      bestDuration = duration;
      best = script;
    }
  }
  return best;
}

/**
 * Reduce a performance entry to a {@link LongFrameSample}, or `null` if it is not a
 * usable long-animation-frame entry.
 *
 * Structural on purpose. `PerformanceLongAnimationFrameTiming` is not in every
 * TypeScript DOM lib, and a structural read keeps this testable with plain objects
 * and tolerant of Chrome adding fields.
 */
export function describeLongFrame(entry: unknown): LongFrameSample | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const record = entry as Record<string, unknown>;

  if (record['entryType'] !== 'long-animation-frame') return null;

  const durationMs = numberOf(record['duration']);
  const blockingMs = numberOf(record['blockingDuration']);
  const script = longestScript(record['scripts']);
  // Guarded rather than `String(...)`: an object here would become the useless
  // "[object Object]", which is worse than admitting there is no attribution.
  const invoker = typeof script?.invoker === 'string' ? script.invoker : '';

  return { durationMs, blockingMs, topInvoker: invoker };
}

/** The `PerformanceObserver` surface this module needs. */
export interface PerformanceObserverLike {
  observe(options: { type: string; buffered?: boolean }): void;
  disconnect(): void;
}

export interface LongFrameEnvironment {
  /** `undefined` when the platform has no `PerformanceObserver` at all. */
  createObserver?: (
    callback: (entries: unknown[]) => void,
  ) => PerformanceObserverLike;
  /** Entry types the platform claims to support. */
  supportedEntryTypes: readonly string[];
  now(): number;
}

/** The real environment, feature-detected. */
export function browserLongFrameEnvironment(): LongFrameEnvironment {
  const supported =
    typeof PerformanceObserver !== 'undefined' &&
    Array.isArray(PerformanceObserver.supportedEntryTypes)
      ? PerformanceObserver.supportedEntryTypes
      : [];

  if (
    typeof PerformanceObserver === 'undefined' ||
    typeof PerformanceObserver.supportedEntryTypes === 'undefined'
  ) {
    return { supportedEntryTypes: supported, now: () => performance.now() };
  }

  return {
    supportedEntryTypes: supported,
    now: () => performance.now(),
    createObserver: (callback) =>
      new PerformanceObserver((list) => {
        callback(list.getEntries());
      }),
  };
}

export interface LongFrameObserver {
  /** `'unsupported'` when the browser does not implement the entry type. */
  readonly kind: 'long-animation-frame' | 'unsupported';
  /** Stop observing. Safe to call more than once. */
  disconnect(): void;
}

/**
 * Start observing long animation frames.
 *
 * `onSample` is called once per long frame with a reduced sample. Returning
 * `unsupported` is a normal outcome, not an error: the entry type is Chrome-only and
 * the rest of the app does not depend on it.
 */
export function observeLongFrames(
  onSample: (sample: LongFrameSample, nowMs: number) => void,
  environment: LongFrameEnvironment = browserLongFrameEnvironment(),
): LongFrameObserver {
  if (
    environment.createObserver === undefined ||
    !environment.supportedEntryTypes.includes('long-animation-frame')
  ) {
    return { kind: 'unsupported', disconnect: () => {} };
  }

  const observer = environment.createObserver((entries) => {
    for (const entry of entries) {
      const sample = describeLongFrame(entry);
      if (sample !== null) onSample(sample, environment.now());
    }
  });

  try {
    observer.observe({ type: 'long-animation-frame', buffered: false });
  } catch {
    // Documented as supported but rejected in practice: treat as unsupported
    // rather than taking the app down over instrumentation.
    observer.disconnect();
    return { kind: 'unsupported', disconnect: () => {} };
  }

  let stopped = false;
  return {
    kind: 'long-animation-frame',
    disconnect: () => {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
    },
  };
}
