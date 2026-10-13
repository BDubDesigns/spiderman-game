/**
 * On-device gesture capture (PLAN.md §11.2, §11.5).
 *
 * The classifier thresholds cannot be tuned from synthetic fixtures, and a screenshot of
 * the HUD cannot be replayed. This records, for each **observed** hand frame, the raw
 * landmarks MediaPipe produced *and* the measurements both classifiers derived from them,
 * so the numbers can be read here and the frames replayed offline as regression fixtures.
 *
 * Deliberately records only frames where a hand was actually **observed**. Stale frames
 * repeat the previous observation, so recording them would inflate the sample with
 * duplicates and misrepresent how much distinct data there is.
 *
 * Pure: no DOM. The panel that displays it lives in `capturePanel.ts`.
 */

import { GESTURE, JOINT } from '../config';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';

/**
 * What the player was deliberately doing when a frame was captured.
 *
 * Labeling exists because the thresholds cannot be tuned from unlabeled data: a run of
 * numbers with no statement of intent cannot distinguish "the classifier missed my
 * gesture" from "I was not gesturing". The labels are the ground truth the measurements
 * are scored against, and they are chosen so that the three poses the maintainer reported
 * separately — a palm-facing gesture, a natural wrist-away Spider-Man pose, and a plain
 * open hand — stay distinguishable in the analysis.
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
  /** Captured before a label was chosen. Excluded from tuning. */
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
  /** What the player was deliberately doing, when a label was selected. */
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

export class HandFrameCapture {
  private frames: CapturedFrame[] = [];
  private label: CaptureLabel = 'unlabeled';

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.frames.length;
  }

  /** The label applied to frames captured from now on. */
  get currentLabel(): CaptureLabel {
    return this.label;
  }

  /**
   * Set the label for **subsequent** frames.
   *
   * Applied going forward rather than retroactively, so a mis-tap cannot relabel data the
   * player was not doing the new thing during.
   */
  setLabel(label: CaptureLabel): void {
    this.label = label;
  }

  get capacityFrames(): number {
    return this.capacity;
  }

  get all(): readonly CapturedFrame[] {
    return this.frames;
  }

  /** Keep the newest `capacity` frames; the oldest are dropped. */
  record(frame: Omit<CapturedFrame, 'label'>): void {
    this.frames.push({ ...frame, label: this.label });
    if (this.frames.length > this.capacity) {
      this.frames.splice(0, this.frames.length - this.capacity);
    }
  }

  clear(): void {
    this.frames = [];
  }

  /**
   * Everything needed to interpret the capture offline.
   *
   * The thresholds are included because a capture without them cannot be compared against
   * a later build's thresholds, and the whole point is to tune them.
   */
  toJson(meta: { url: string; capturedAt: string }): string {
    return JSON.stringify(
      {
        schema: 'web-slinger-gesture-capture/1',
        capturedAt: meta.capturedAt,
        url: meta.url,
        note:
          'Each frame is one observation. `landmarks` are MediaPipe normalized coordinates ' +
          'verbatim (x by image width, y by image height). `distance` ratios are normalized ' +
          'by wrist-to-middle-MCP span. `angle.pip` is the interior PIP joint angle in ' +
          'degrees (180 = straight). Both classifiers ran on the same landmarks.',
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
        frames: this.frames,
      },
      null,
      1,
    );
  }

  /**
   * A compact, pasteable table.
   *
   * This is what to send back when the question is "which threshold is wrong?" — it is a
   * few dozen lines rather than a few hundred kilobytes, and it carries the four numbers
   * that decide between tuning and a structural change.
   */
  toTextSummary(): string {
    const lines: string[] = [];
    lines.push(
      `observations ${this.frames.length} of ${this.capacity} (one line per observed hand frame)`,
    );
    if (this.frames.length > 1) {
      const first = this.frames[0]!.tMs;
      const last = this.frames[this.frames.length - 1]!.tMs;
      const spanMs = Math.max(1, last - first);
      const hz = ((this.frames.length - 1) * 1000) / spanMs;
      // The rate is stated because it is the check that this really is per-observation:
      // a real capture reads ~5 Hz here, while one polluted by render callbacks reads ~60.
      lines.push(
        `span ${(spanMs / 1000).toFixed(1)} s   mean ${hz.toFixed(1)} Hz (expect ~5, NOT ~60)`,
      );
    }
    lines.push(
      'cols: t | label | hand | dist mid/ring/idx/pky | angle PIP mid/ring/idx/pky | verdict D/A',
    );
    for (const frame of this.frames) {
      const d = frame.distance;
      const pip = frame.angle.pip;
      const fmt = (value: number | null | undefined): string =>
        value === null || value === undefined ? '  --' : value.toFixed(2);
      lines.push(
        [
          String(Math.round(frame.tMs - (this.frames[0]?.tMs ?? 0))).padStart(6),
          frame.label.padEnd(16),
          frame.identity.padEnd(5),
          `${d.middleToPalm.toFixed(2)}/${d.ringToPalm.toFixed(2)}/${d.indexExt.toFixed(2)}/${d.pinkyExt.toFixed(2)}`,
          `${fmt(pip['middle'])}/${fmt(pip['ring'])}/${fmt(pip['index'])}/${fmt(pip['pinky'])}`,
          `${frame.verdict.distanceGesture ? 'Y' : 'n'}/${frame.verdict.angleGesture ? 'Y' : 'n'}`,
        ].join('  '),
      );
    }

    // Per-label minima/maxima, which is what actually decides a threshold. Reported here so
    // the numbers needed for tuning come back with the paste rather than requiring the JSON.
    lines.push('');
    lines.push('per-label margins (what tuning needs):');
    for (const label of [...CAPTURE_LABELS.map((l) => l.id), 'unlabeled' as CaptureLabel]) {
      const group = this.frames.filter((frame) => frame.label === label);
      if (group.length === 0) continue;
      const range = (pick: (frame: CapturedFrame) => number | null | undefined): string => {
        const values = group.map(pick).filter((v): v is number => typeof v === 'number');
        if (values.length === 0) return '--';
        return `${Math.min(...values).toFixed(0)}..${Math.max(...values).toFixed(0)}`;
      };
      const fires = group.filter((frame) => frame.verdict.angleGesture).length;
      lines.push(
        `  ${label.padEnd(17)} n=${String(group.length).padStart(3)}  PIP mid ${range((f) => f.angle.pip['middle'])}  idx ${range((f) => f.angle.pip['index'])}  angle-fired ${fires}/${group.length}`,
      );
    }
    return lines.join('\n');
  }
}
