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

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.frames.length;
  }

  get capacityFrames(): number {
    return this.capacity;
  }

  get all(): readonly CapturedFrame[] {
    return this.frames;
  }

  /** Keep the newest `capacity` frames; the oldest are dropped. */
  record(frame: CapturedFrame): void {
    this.frames.push(frame);
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
    lines.push(`frames ${this.frames.length} of ${this.capacity} (observed hands only)`);
    lines.push(
      'cols: t | hand | dist mid/ring/idx/pky | angle PIP mid/ring/idx/pky | verdict D/A',
    );
    for (const frame of this.frames) {
      const d = frame.distance;
      const pip = frame.angle.pip;
      const fmt = (value: number | null | undefined): string =>
        value === null || value === undefined ? '  --' : value.toFixed(2);
      lines.push(
        [
          String(Math.round(frame.tMs)).padStart(6),
          frame.identity.padEnd(5),
          `${d.middleToPalm.toFixed(2)}/${d.ringToPalm.toFixed(2)}/${d.indexExt.toFixed(2)}/${d.pinkyExt.toFixed(2)}`,
          `${fmt(pip['middle'])}/${fmt(pip['ring'])}/${fmt(pip['index'])}/${fmt(pip['pinky'])}`,
          `${frame.verdict.distanceGesture ? 'Y' : 'n'}/${frame.verdict.angleGesture ? 'Y' : 'n'}`,
        ].join('  '),
      );
    }
    return lines.join('\n');
  }
}
