/**
 * How long a gesture must be held before it fires, as a function of the achieved
 * inference rate (PLAN.md §11.7, §7.1, §7.2).
 *
 * This is a **measurement**, not a policy test: it exists because the first real
 * playtest reported ~4.7 Hz inference and gestures that "almost never" registered,
 * and the interaction between the detection cadence, the stale-hand freeze and the
 * `HOLD_MS` requirement is not obvious by inspection.
 *
 * The cadence below mirrors `main.ts` exactly: detections arrive at the inference
 * rate, and the render loop ticks at 60 fps in between. Every render frame that did
 * not coincide with a detection is `isStale` (the identity tracker sets
 * `stalenessMs > 0`), and `GestureController` freezes a stale hand's state machine
 * rather than advancing it (§10.3, §7.2). So the machine effectively advances once
 * per *detection*, not once per rendered frame.
 *
 * The consequence is that `HOLD_MS` is not a wall-clock hold the player can feel:
 * it is a count of *detections*, and at a low inference rate it can span a long
 * real time. These tests pin that number down.
 */

import { describe, expect, it } from 'vitest';

import { GESTURE } from '../config';
import { Landmark } from '../tracking/landmarkTypes';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';
import type { TrackedHand } from '../tracking/handIdentity';
import { classifyGesture } from './classifyGesture';
import { GestureController } from './gestureController';

const LANDMARK_COUNT = 21;
const WRIST = { x: 0.5, y: 0.8 };
const MIDDLE_MCP = { x: 0.5, y: 0.6 };
const SPAN = 0.2;
const PALM = { x: 0.516, y: 0.656 };

/** A clean web gesture: middle and ring pressed to the palm, index and pinky out. */
const POSE_GESTURE = {
  middle: 0.2 * SPAN,
  ring: 0.25 * SPAN,
  index: 1.4 * SPAN,
  pinky: 1.3 * SPAN,
};
/** An open hand. */
const POSE_OPEN = {
  middle: 0.9 * SPAN,
  ring: 0.9 * SPAN,
  index: 1.5 * SPAN,
  pinky: 1.4 * SPAN,
};

function buildLandmarks(spec: typeof POSE_GESTURE): NormalizedLandmark[] {
  const points: NormalizedLandmark[] = Array.from({ length: LANDMARK_COUNT }, () => ({
    x: PALM.x,
    y: PALM.y,
  }));
  points[Landmark.WRIST] = { ...WRIST };
  points[Landmark.MIDDLE_MCP] = { ...MIDDLE_MCP };
  points[Landmark.INDEX_MCP] = { x: 0.45, y: 0.62 };
  points[Landmark.RING_MCP] = { x: 0.55, y: 0.62 };
  points[Landmark.PINKY_MCP] = { x: 0.58, y: 0.64 };
  points[Landmark.MIDDLE_TIP] = { x: PALM.x, y: PALM.y - spec.middle };
  // Vertical, so the aspect correction cannot scale it. This file measures *latency*,
  // and a fixture sitting a hair inside the fold threshold would make the measurement
  // about the threshold rather than about the cadence.
  points[Landmark.RING_TIP] = { x: PALM.x, y: PALM.y - spec.ring };
  points[Landmark.INDEX_TIP] = { x: WRIST.x, y: WRIST.y - spec.index };
  points[Landmark.PINKY_TIP] = { x: WRIST.x, y: WRIST.y - spec.pinky };
  return points;
}

function tracked(landmarks: NormalizedLandmark[], isStale: boolean): TrackedHand {
  return {
    identity: 'right',
    landmarks,
    handedness: { label: 'Right', score: 0.95 },
    palmCenter: { x: PALM.x, y: PALM.y },
    identityMatchScore: 1,
    stalenessMs: isStale ? 20 : 0,
    isStale,
    handednessConflicted: false,
    reacquiredAtMs: null,
  };
}

const RENDER_MS = 1000 / 60;

interface PlayResult {
  fired: boolean;
  /** Wall-clock ms from the pose's first frame to the FIRE, or `null`. */
  msToFire: number | null;
  /** Detections that landed while the pose was held. */
  detectionsInPose: number;
}

/**
 * Play a pose-hold-release sequence at a given inference rate.
 *
 * `holdMs` is the real time the player holds the gesture. `inferenceHz` is the
 * achieved detection rate. The pose is presented from t=0 and released at
 * `holdMs`; nothing else is held, so a fire can only come from this one effort.
 */
function play(holdMs: number, inferenceHz: number, tailMs = 1500): PlayResult {
  const controller = new GestureController();
  const detectionInterval = 1000 / inferenceHz;

  let nextDetectionAt = 0;
  let detectionsInPose = 0;
  let fired = false;
  let msToFire: number | null = null;

  // Start released so the machine is genuinely idle before the effort begins, and
  // so the cooldown from any earlier state is long expired.
  for (let t = -400; t < 0; t += RENDER_MS) {
    controller.update([tracked(buildLandmarks(POSE_OPEN), true)], t);
  }

  for (let t = 0; t <= holdMs + tailMs; t += RENDER_MS) {
    const inPose = t < holdMs;
    const landmarks = buildLandmarks(inPose ? POSE_GESTURE : POSE_OPEN);

    // A detection lands roughly every `detectionInterval`; other render frames
    // carry a stale copy of whatever was last observed.
    const isDetectionFrame = t >= nextDetectionAt;
    if (isDetectionFrame) {
      nextDetectionAt = t + detectionInterval;
      if (inPose) detectionsInPose += 1;
    }

    const frame = controller.update([tracked(landmarks, !isDetectionFrame)], t);
    if (frame.events.length > 0 && !fired) {
      fired = true;
      msToFire = t;
    }
  }

  return { fired, msToFire, detectionsInPose };
}

describe('gesture fire latency vs achieved inference rate', () => {
  it('a confident pose reports a full score when it is actually classified', () => {
    // Sanity: the synthetic gesture really is a clean gesture, so anything the
    // measurements below attribute to cadence is not a classifier failure.
    const result = classifyGesture(buildLandmarks(POSE_GESTURE));
    expect(result.pose.isGesture).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(GESTURE.minGestureScore);
  });

  it('measures the minimum hold that fires, across inference rates', () => {
    const rates = [5, 10, 15, 30];
    const table = rates.map((rate) => ({
      rate,
      // The shortest hold that fires, searching in render-frame steps.
      minimumHoldMs: (() => {
        for (let hold = RENDER_MS; hold <= 2000; hold += RENDER_MS) {
          if (play(hold, rate).fired) return Math.round(hold);
        }
        return null;
      })(),
    }));

    // Every rate must eventually fire — the machine is not broken, just slower at
    // low cadence. `null` would mean gestures can never register at all.
    for (const row of table) {
      expect({ rate: row.rate, fires: row.minimumHoldMs !== null }).toEqual({
        rate: row.rate,
        fires: true,
      });
    }

    // The reason this file exists: a low inference rate makes a gesture cost more
    // real time to register, because `HOLD_MS` elapses on the render clock while the
    // machine only advances on detection frames. That is a real, measurable penalty
    // — but it is bounded, and it is not "gestures never work".
    const atMeasuredRate = table.find((row) => row.rate === 5)!.minimumHoldMs!;
    const atBestRate = table.find((row) => row.rate === 30)!.minimumHoldMs!;
    expect(atMeasuredRate).toBeGreaterThan(atBestRate);
    expect(atMeasuredRate).toBeLessThan(1000);
  });

  it('a brief gesture is missed at the measured 4.7 Hz but caught at 30 Hz', () => {
    // 300 ms is a normal, deliberate flick: long enough to feel intentional, short
    // enough that a human would not expect it to be dropped.
    const at5 = play(300, 4.7);
    const at30 = play(300, 30);

    expect(at5.fired).toBe(false);
    expect(at30.fired).toBe(true);
  });

  it('needs at least two in-pose detections, so the hold spans a detection gap', () => {
    // This is the mechanism: `HOLD_MS` elapses on the *render* clock, but the
    // machine only advances on detection frames. One detection can never satisfy a
    // hold that is longer than the gap it was sampled in.
    const oneDetection = play(1, 4.7);
    expect(oneDetection.fired).toBe(false);

    const result = play(800, 4.7);
    expect(result.fired).toBe(true);
    expect(result.detectionsInPose).toBeGreaterThanOrEqual(2);
  });

  it('does not re-fire while the pose is held, at any rate', () => {
    // The §11.7 invariant must survive the cadence change.
    const controller = new GestureController();
    const detectionInterval = 1000 / 4.7;
    let nextDetectionAt = 0;
    let fires = 0;

    for (let t = 0; t <= 6000; t += RENDER_MS) {
      const isDetectionFrame = t >= nextDetectionAt;
      if (isDetectionFrame) nextDetectionAt = t + detectionInterval;
      const frame = controller.update([tracked(buildLandmarks(POSE_GESTURE), !isDetectionFrame)], t);
      fires += frame.events.length;
    }

    expect(fires).toBe(1);
  });
});
