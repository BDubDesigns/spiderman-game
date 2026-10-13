/**
 * On-device gesture capture (PLAN.md §11.2, §11.5).
 *
 * The classifier thresholds cannot be tuned from synthetic fixtures, and a screenshot of the HUD
 * cannot be replayed. This records raw landmarks plus both classifiers' measurements so the
 * numbers can be read here and the landmark sequences replayed offline.
 *
 * ---- Two buffers, deliberately ----
 *
 * 1. A **rolling** buffer of recent observations, capped small. Purely diagnostic: it backs the
 *    live view, so the panel can show what the camera is seeing right now.
 * 2. A **session dataset of takes**, which is what tuning reads. A take is an explicit snapshot
 *    the player saves by tapping, stamped with the label they selected.
 *
 * The split exists because the first version had only the rolling buffer and a button that merely
 * re-rendered it. At the measured ~4.7 Hz a 150-observation buffer holds about **32 seconds**, so
 * a real session — five poses, three or four repetitions, roughly four minutes — silently evicted
 * its own early takes before the download. The button said "Capture samples" and captured
 * nothing, and whatever survived was whatever happened to be recent.
 *
 * Deciding *when* a pose was being held is the player's job, not the buffer's: only frames inside
 * a saved take are labelled, so the frames while a hand is moving between poses are excluded by
 * construction rather than being guessed at from timestamps.
 *
 * Pure: no DOM. The panel that drives it lives in `capturePanel.ts`.
 */

import { GESTURE, JOINT } from '../config';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';
import type { TrackedHand } from '../tracking/handIdentity';
import type { HandGestureState } from '../gesture/gestureController';

/**
 * What the player was deliberately doing when a take was saved.
 *
 * Labelling exists because thresholds cannot be tuned from unlabeled data: a run of numbers with
 * no statement of intent cannot distinguish "the classifier missed my gesture" from "I was not
 * gesturing". The labels are the ground truth the measurements are scored against, and they are
 * chosen so that the poses the maintainer reported separately — a palm-facing gesture, a natural
 * wrist-away Spider-Man pose, and a plain open hand — stay distinguishable in the analysis.
 */
export type CaptureLabel =
  /** Hand flat and open. Must never fire. */
  | 'open'
  /** The deliberate gesture, palm toward the camera. Should fire. */
  | 'palm-gesture'
  /** The natural Spider-Man firing pose, wrist turned away/upward. Should fire. */
  | 'wrist-away-gesture'
  /** Fist. Must never fire. */
  | 'fist'
  /** Loosely relaxed hand. Must never fire. */
  | 'relaxed'
  /** Recorded before any take claimed it. Diagnostic only; never tuned from. */
  | 'unlabeled';

/** The labels a player can select, in the order the panel shows them. */
export const CAPTURE_LABELS: readonly { id: CaptureLabel; text: string }[] = [
  { id: 'open', text: 'Open hand' },
  { id: 'palm-gesture', text: 'Gesture (palm facing)' },
  { id: 'wrist-away-gesture', text: 'Gesture (wrist away)' },
  { id: 'fist', text: 'Fist' },
  { id: 'relaxed', text: 'Relaxed' },
];

/** The distance classifier's four ratios, plus the normalizer they were divided by. */
export interface DistanceMeasurements {
  span: number;
  middleToPalm: number;
  ringToPalm: number;
  indexExt: number;
  pinkyExt: number;
}

/** The joint classifier's per-finger measurements, in a flat shape for pasting. */
export interface AngleMeasurements {
  /** Interior PIP angle per finger, degrees. `null` when ill-conditioned. */
  pip: Record<string, number | null>;
  /** `|tip - mcp| / arc` per finger. */
  chord: Record<string, number | null>;
  /** `arc / span` per finger; small means pointing at the camera. */
  chain: Record<string, number | null>;
  /** Whether each finger's PIP angle was well-conditioned. */
  reliable: Record<string, boolean>;
  /** How each finger's curl was decided. */
  basis: Record<string, string>;
}

export interface CapturedFrame {
  /** Milliseconds on the page clock, so frames can be ordered and replayed. */
  tMs: number;
  /** The label this frame carries. Meaningful only inside a take. */
  label: CaptureLabel;
  identity: string;
  handednessLabel: string;
  handednessScore: number;
  /** Raw landmarks, verbatim, so the frame can be re-fed to either classifier. */
  landmarks: NormalizedLandmark[];
  distance: DistanceMeasurements;
  angle: AngleMeasurements;
  /** Both verdicts for this frame, so the disagreement is visible. */
  verdict: {
    distanceGesture: boolean;
    distanceScore: number;
    angleGesture: boolean;
    angleScore: number;
    /** Which classifier the session is actually running. */
    method: string;
  };
}

/** One deliberate snapshot, labelled by the player. */
export interface CaptureTake {
  id: number;
  label: CaptureLabel;
  /** When the player tapped. */
  takenAtMs: number;
  /** The observation window the take covers, for the record. */
  windowMs: number;
  frames: CapturedFrame[];
}

/** The live webs/targets state is not capture's business; only the gesture frame is. */
export interface CaptureSource {
  hands: readonly HandGestureState[];
}

/**
 * Record one entry per **freshly observed** hand from a gesture frame.
 *
 * Extracted from `main.ts` so it can be tested directly — a reimplementation in a test would only
 * prove the test agrees with itself, which is the trap the cadence test fell into.
 *
 * Two hands are skipped, and both matter:
 *
 * - **`frozen`**: a coasting hand is not an observation. When the camera reports nothing the
 *   identity tracker returns retained `isStale` hands, and `observe()` returns a frozen copy of
 *   the prior state — non-null geometry, *old* landmarks — so recording it stamps a fresh
 *   timestamp on stale data.
 * - **`geometry === null`**: nothing measurable, so there is nothing to record.
 */
export function recordGestureObservations(
  capture: HandFrameCapture,
  frame: CaptureSource,
  tracked: readonly TrackedHand[],
  atMs: number,
): void {
  for (const hand of frame.hands) {
    if (hand.frozen || hand.geometry === null) continue;
    const source = tracked.find((candidate) => candidate.identity === hand.identity);
    if (source === undefined) continue;

    const pip: Record<string, number | null> = {};
    const chord: Record<string, number | null> = {};
    const chain: Record<string, number | null> = {};
    const reliable: Record<string, boolean> = {};
    const basis: Record<string, string> = {};
    for (const name of ['index', 'middle', 'ring', 'pinky'] as const) {
      const measure = hand.alternate.measures[name];
      pip[name] = measure.pipAngleDeg;
      chord[name] = measure.chordRatio;
      chain[name] = measure.chainRatio;
      reliable[name] = measure.reliable;
      basis[name] = measure.basis;
    }

    capture.record({
      tMs: atMs,
      identity: hand.identity,
      handednessLabel: source.handedness.label,
      handednessScore: source.handedness.score,
      // Copied, so a later observation cannot mutate what was captured.
      landmarks: source.landmarks.map((point) => ({ ...point })),
      distance: {
        span: hand.geometry.span,
        middleToPalm: hand.geometry.middleToPalm,
        ringToPalm: hand.geometry.ringToPalm,
        indexExt: hand.geometry.indexExt,
        pinkyExt: hand.geometry.pinkyExt,
      },
      angle: { pip, chord, chain, reliable, basis },
      verdict: {
        distanceGesture:
          hand.method === 'distance' ? hand.pose.isGesture : hand.alternate.pose.isGesture,
        distanceScore: hand.method === 'distance' ? hand.rawScore : hand.alternate.score,
        angleGesture:
          hand.method === 'angle' ? hand.pose.isGesture : hand.alternate.pose.isGesture,
        angleScore: hand.method === 'angle' ? hand.rawScore : hand.alternate.score,
        method: hand.method,
      },
    });
  }
}

export interface HandFrameCaptureOptions {
  /** Rolling diagnostic buffer size, in observations. */
  rollingCapacity: number;
  /**
   * Total frames the saved-take dataset may hold.
   *
   * Generous on purpose. The dataset must never evict during a normal session: a four-minute run
   * of five poses with four repetitions each is roughly 20 takes of a few observations, so this
   * exists only to bound memory, not to decide what is kept.
   */
  sessionFrameCapacity: number;
}

export class HandFrameCapture {
  /** Recent observations, newest last. Diagnostic only. */
  private rolling: CapturedFrame[] = [];
  private savedTakes: CaptureTake[] = [];
  /** Observation timestamps already claimed by a take, so a double-tap cannot duplicate. */
  private readonly claimed = new Set<number>();
  private label: CaptureLabel = 'unlabeled';
  private nextTakeId = 1;
  private readonly options: HandFrameCaptureOptions;

  constructor(options: HandFrameCaptureOptions) {
    this.options = options;
  }

  /** Rolling observations currently held (diagnostic). */
  get size(): number {
    return this.rolling.length;
  }

  get capacityFrames(): number {
    return this.options.rollingCapacity;
  }

  /** Saved takes, in the order they were saved. */
  get takes(): readonly CaptureTake[] {
    return this.savedTakes;
  }

  get takeCount(): number {
    return this.savedTakes.length;
  }

  /** Total observations across every saved take — the dataset tuning reads. */
  get sessionFrames(): number {
    return this.savedTakes.reduce((total, take) => total + take.frames.length, 0);
  }

  /** The rolling buffer, for the diagnostic view. Never the tuning input. */
  get all(): readonly CapturedFrame[] {
    return this.rolling;
  }

  /** The label that will be stamped on the **next** take. */
  get currentLabel(): CaptureLabel {
    return this.label;
  }

  /**
   * Set the label for the next take.
   *
   * Applied to takes, not retroactively to the rolling buffer, so a mis-tap cannot relabel data
   * the player was not doing the new thing during.
   */
  setLabel(label: CaptureLabel): void {
    this.label = label;
  }

  /** How many takes exist per label. */
  labelCounts(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const take of this.savedTakes) {
      counts[take.label] = (counts[take.label] ?? 0) + 1;
    }
    return counts;
  }

  /** Keep the newest `rollingCapacity` observations; the oldest are dropped. */
  record(frame: Omit<CapturedFrame, 'label'>): void {
    this.rolling.push({ ...frame, label: this.label });
    if (this.rolling.length > this.options.rollingCapacity) {
      this.rolling.splice(0, this.rolling.length - this.options.rollingCapacity);
    }
  }

  /**
   * Save a take: snapshot the trailing `windowMs` of unclaimed observations, stamped with the
   * currently selected label.
   *
   * Returns the take, or `null` when there was nothing fresh to save — which happens if the
   * player taps twice in quick succession, or before any observation has arrived. A `null` is an
   * ordinary outcome, not an error: the panel says so rather than silently saving an empty take.
   */
  take(nowMs: number, windowMs: number): CaptureTake | null {
    const window = this.rolling.filter(
      (frame) => frame.tMs > nowMs - windowMs && !this.claimed.has(frame.tMs),
    );
    if (window.length === 0) return null;

    const stamp = this.label;
    const frames = window.map((frame) => ({ ...frame, label: stamp }));
    for (const frame of frames) this.claimed.add(frame.tMs);

    const saved: CaptureTake = {
      id: this.nextTakeId,
      label: stamp,
      takenAtMs: nowMs,
      windowMs,
      frames,
    };
    this.nextTakeId += 1;
    this.savedTakes.push(saved);
    this.enforceSessionCapacity();
    return saved;
  }

  /** Drop the oldest takes only if the dataset exceeded its (generous) memory bound. */
  private enforceSessionCapacity(): void {
    let total = this.sessionFrames;
    while (total > this.options.sessionFrameCapacity && this.savedTakes.length > 1) {
      const oldest = this.savedTakes.shift();
      if (oldest === undefined) break;
      for (const frame of oldest.frames) this.claimed.delete(frame.tMs);
      total -= oldest.frames.length;
    }
  }

  /** Clear everything: rolling observations and saved takes. */
  clear(): void {
    this.rolling = [];
    this.savedTakes = [];
    this.claimed.clear();
    this.nextTakeId = 1;
  }

  /**
   * Everything needed to interpret the capture offline.
   *
   * The thresholds are included because a capture without them cannot be compared against a later
   * build's thresholds, and the whole point is to tune them.
   */
  toJson(meta: { url: string; capturedAt: string }): string {
    return JSON.stringify(
      {
        schema: 'web-slinger-gesture-capture/2',
        capturedAt: meta.capturedAt,
        url: meta.url,
        note:
          'Each take is a deliberate snapshot the player saved, labelled with the pose they were ' +
          'holding. `frames` are fresh observations only: no render-frame repeats and no coasting ' +
          '(stale) hands. `landmarks` are MediaPipe normalized coordinates verbatim (x by image ' +
          'width, y by image height). `distance` ratios are normalized by wrist-to-middle-MCP ' +
          'span. `angle.pip` is the interior PIP joint angle in degrees (180 = straight). Both ' +
          'classifiers ran on the same landmarks.',
        thresholds: {
          distance: {
            foldEnter: GESTURE.foldEnter,
            foldExit: GESTURE.foldExit,
            extEnter: GESTURE.extEnter,
            extExit: GESTURE.extExit,
          },
          joint: {
            curlStrongDeg: JOINT.curlStrongDeg,
            curlEnterDeg: JOINT.curlEnterDeg,
            curlExitDeg: JOINT.curlExitDeg,
            chordEnterRatio: JOINT.chordEnterRatio,
            chordExitRatio: JOINT.chordExitRatio,
            extendEnterDeg: JOINT.extendEnterDeg,
            extendExitDeg: JOINT.extendExitDeg,
            minSegmentRatio: JOINT.minSegmentRatio,
            minChainRatio: JOINT.minChainRatio,
          },
        },
        takeCount: this.savedTakes.length,
        sessionFrames: this.sessionFrames,
        takes: this.savedTakes,
      },
      null,
      1,
    );
  }

  /**
   * A compact, pasteable table of the **saved takes**.
   *
   * This is what to send back when the question is "which threshold is wrong?" — a few dozen
   * lines rather than a few hundred kilobytes, carrying the numbers that decide between tuning
   * and a structural change.
   */
  toTextSummary(): string {
    const lines: string[] = [];
    const counts = this.labelCounts();
    const breakdown = Object.entries(counts)
      .map(([label, n]) => `${label} x${n}`)
      .join(', ');

    lines.push(
      `takes ${this.savedTakes.length}   observations in dataset ${this.sessionFrames}   rolling ${this.rolling.length} of ${this.options.rollingCapacity} (diagnostic only)`,
    );
    lines.push(`labels: ${breakdown === '' ? '(none saved yet)' : breakdown}`);

    if (this.rolling.length > 1) {
      const first = this.rolling[0]!.tMs;
      const last = this.rolling[this.rolling.length - 1]!.tMs;
      const spanMs = Math.max(1, last - first);
      const hz = ((this.rolling.length - 1) * 1000) / spanMs;
      // The rate is stated because it is the check that this really is per-observation: a real
      // capture reads ~5 Hz, while one polluted by render callbacks reads ~60.
      lines.push(
        `rolling span ${(spanMs / 1000).toFixed(1)} s   mean ${hz.toFixed(1)} Hz (expect ~5, NOT ~60)`,
      );
    }

    if (this.savedTakes.length === 0) {
      lines.push('');
      lines.push(
        'No takes saved yet. Pick a label, hold that pose, then tap "Save take" — the take ' +
          'covers the last moments before the tap.',
      );
      return lines.join('\n');
    }

    lines.push('');
    for (const take of this.savedTakes) {
      lines.push(
        `take ${take.id}  ${take.label}  n=${take.frames.length}  (window ${take.windowMs} ms)`,
      );
    }

    lines.push('');
    lines.push('per-label margins (what tuning needs):');
    for (const { id } of CAPTURE_LABELS) {
      const takes = this.savedTakes.filter((take) => take.label === id);
      const frames = takes.flatMap((take) => take.frames);
      if (frames.length === 0) continue;
      const range = (pick: (frame: CapturedFrame) => number | null | undefined): string => {
        const values = frames.map(pick).filter((v): v is number => typeof v === 'number');
        if (values.length === 0) return '--';
        return `${Math.min(...values).toFixed(0)}..${Math.max(...values).toFixed(0)}`;
      };
      const fired = frames.filter((frame) => frame.verdict.angleGesture).length;
      lines.push(
        `  ${id.padEnd(19)} takes ${String(takes.length).padStart(2)}  n=${String(frames.length).padStart(3)}  PIP mid ${range((f) => f.angle.pip['middle'])}  idx ${range((f) => f.angle.pip['index'])}  angle-fired ${fired}/${frames.length}`,
      );
    }
    return lines.join('\n');
  }
}
