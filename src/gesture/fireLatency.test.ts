/**
 * Fire latency as a function of the **observation** rate (PLAN.md §11.7, §7.1, §7.2).
 *
 * This file models the real browser arrangement rather than an assumed one: detections
 * arrive at the inference rate (measured at ~4.7 Hz on the Pixel 10 Pro XL) while
 * `requestAnimationFrame` runs at ~60 Hz in between.
 *
 * **It previously modelled that arrangement wrongly, and the error hid a real bug.** Both
 * the old version of this file and the live code advanced the gesture state machine on
 * every render frame, reusing the last observation. Because ~12 render frames fit inside
 * one 4.7 Hz interval, `HOLD_MS` (150 ms) elapsed in *render* time: a **single**
 * observation satisfied the hold by itself, so the machine fired on one glimpse of the
 * pose. Every "minimum hold" number this file used to report was therefore describing
 * render frames, not held gestures.
 *
 * The corrected model, which is also what `main.ts` now does:
 *
 * - `observe()` — once per detection, at the detection's timestamp. Advances everything.
 * - `renderFrame()` — once per animation frame. Reads only, and cannot fire.
 *
 * The consequence worth stating plainly: `HOLD_MS` is now a wall-clock hold measured in
 * *observations*. At 4.7 Hz that means two detections roughly 213 ms apart, so a
 * deliberate gesture needs to be held across at least one detection interval.
 */

import { describe, expect, it } from 'vitest';

import { GESTURE } from '../config';
import { Landmark } from '../tracking/landmarkTypes';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';
import type { TrackedHand } from '../tracking/handIdentity';
import { classifyGesture } from './classifyGesture';
import { GestureController } from './gestureController';

const LANDMARK_COUNT = 21;
const RENDER_MS = 1000 / 60;

/** Geometry scaffold: wrist-to-middle-MCP span of 0.2 normalized units. */
const WRIST = { x: 0.5, y: 0.8 };
const MIDDLE_MCP = { x: 0.5, y: 0.6 };
const SPAN = 0.2;
const PALM = { x: 0.516, y: 0.656 };

/** The web gesture: middle and ring folded, index and pinky extended. */
const POSE_GESTURE = { middle: 0.2 * SPAN, ring: 0.25 * SPAN, index: 1.4 * SPAN, pinky: 1.3 * SPAN };
/** An open hand. */
const POSE_OPEN = { middle: 0.9 * SPAN, ring: 0.9 * SPAN, index: 1.5 * SPAN, pinky: 1.4 * SPAN };

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
  // Vertical, so the aspect correction cannot scale it and the fixture stays in band.
  points[Landmark.RING_TIP] = { x: PALM.x, y: PALM.y - spec.ring };
  points[Landmark.INDEX_TIP] = { x: WRIST.x, y: WRIST.y - spec.index };
  points[Landmark.PINKY_TIP] = { x: WRIST.x, y: WRIST.y - spec.pinky };
  return points;
}

function tracked(landmarks: NormalizedLandmark[]): TrackedHand {
  return {
    identity: 'right',
    landmarks,
    handedness: { label: 'Right', score: 0.95 },
    palmCenter: { x: PALM.x, y: PALM.y },
    identityMatchScore: 1,
    stalenessMs: 0,
    isStale: false,
    handednessConflicted: false,
    reacquiredAtMs: null,
  };
}

interface PlayResult {
  fired: boolean;
  /** Wall-clock ms from the pose's first frame to the FIRE, or `null`. */
  msToFire: number | null;
  /** Detections that landed while the pose was held. */
  detectionsInPose: number;
}

/**
 * Play a pose-hold-release sequence at the real two-rate arrangement.
 *
 * `holdMs` is the real time the player holds the gesture. `inferenceHz` is the achieved
 * detection rate. Only **detections** call `observe()`; every other animation frame calls
 * `renderFrame()`, exactly as `main.ts` does.
 */
function play(holdMs: number, inferenceHz: number, tailMs = 1500, firstDetectionAtMs = 0): PlayResult {
  const controller = new GestureController();
  const detectionInterval = 1000 / inferenceHz;

  let nextDetectionAt = firstDetectionAtMs;
  let detectionsInPose = 0;
  let fired = false;
  let msToFire: number | null = null;

  // Start released so the machine is genuinely idle before the effort begins.
  for (let t = -400; t < 0; t += detectionInterval) {
    controller.observe([tracked(buildLandmarks(POSE_OPEN))], t);
  }

  for (let t = 0; t <= holdMs + tailMs; t += RENDER_MS) {
    const inPose = t < holdMs;
    const landmarks = buildLandmarks(inPose ? POSE_GESTURE : POSE_OPEN);

    if (t >= nextDetectionAt) {
      nextDetectionAt = t + detectionInterval;
      if (inPose) detectionsInPose += 1;
      const frame = controller.observe([tracked(landmarks)], t);
      if (frame.events.length > 0 && !fired) {
        fired = true;
        msToFire = t;
      }
    } else {
      // A render frame must never produce an event.
      expect(controller.renderFrame(t).events).toHaveLength(0);
    }
  }

  return { fired, msToFire, detectionsInPose };
}

describe('render frames cannot advance the gesture machine', () => {
  /**
   * The regression this file exists for. Under the old code these assertions fail: a
   * single observation, repeated by render callbacks, satisfied `HOLD_MS` and fired.
   */

  it('does not fire when one observation is followed only by render frames', () => {
    const controller = new GestureController();
    const pose = tracked(buildLandmarks(POSE_GESTURE));

    // One genuine observation, then a full second of nothing but rendering.
    const observed = controller.observe([pose], 0);
    expect(observed.events).toHaveLength(0);

    let fires = 0;
    for (let t = RENDER_MS; t <= 1000; t += RENDER_MS) {
      fires += controller.renderFrame(t).events.length;
      // ...and re-reading the *same* observation as though it were new must not either.
      if (t < 500) fires += controller.renderFrame(t).events.length;
    }

    expect(fires).toBe(0);
  });

  it('reports the observation as frozen once it is older than maxStalenessMs', () => {
    const controller = new GestureController();
    controller.observe([tracked(buildLandmarks(POSE_GESTURE))], 0);

    expect(controller.renderFrame(0).hands[0]!.frozen).toBe(false);
    expect(controller.renderFrame(100).hands[0]!.frozen).toBe(false);
    // Past the staleness window the hand is held, not advanced (§10.3, §7.2).
    expect(controller.renderFrame(1000).hands[0]!.frozen).toBe(true);
    expect(controller.renderFrame(1000).hands[0]!.observationAgeMs).toBe(1000);
  });

  it('does not let renderFrame manufacture a sustained gesture from one glimpse', () => {
    const controller = new GestureController();
    // A single observation of the pose, then 60 render frames of it "hanging".
    controller.observe([tracked(buildLandmarks(POSE_GESTURE))], 0);
    for (let t = RENDER_MS; t <= 1000; t += RENDER_MS) controller.renderFrame(t);

    const state = controller.renderFrame(1000).hands[0]!;
    expect(state.state).toBe('armed');
    // Held for ~0 ms of *observation* time: the pose was seen once, and never confirmed.
    expect(state.heldMs).toBe(0);
  });
});

describe('fire latency measured in observations', () => {
  it('a confident pose reports a full score when it is actually classified', () => {
    // Sanity: the synthetic gesture really is a clean gesture, so anything attributed to
    // cadence below is not a classifier failure.
    const result = classifyGesture(buildLandmarks(POSE_GESTURE));
    expect(result.pose.isGesture).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(GESTURE.minGestureScore);
  });

  it('requires two observations, because HOLD_MS exceeds one detection interval at 4.7 Hz', () => {
    const interval = 1000 / 4.7; // ~213 ms
    expect(interval).toBeGreaterThan(GESTURE.holdMs);

    // Held for one interval only: the second detection lands as the pose is released.
    const oneInterval = play(interval * 0.9, 4.7);
    expect(oneInterval.detectionsInPose).toBeLessThan(2);

    // Held across two: fires.
    const twoIntervals = play(interval * 2.2, 4.7);
    expect(twoIntervals.fired).toBe(true);
    expect(twoIntervals.detectionsInPose).toBeGreaterThanOrEqual(2);
  });

  it('fires sooner at a higher inference rate, but never from one observation', () => {
    const results = [4.7, 10, 30].map((rate) => ({
      rate,
      ...play(2000, rate, 0),
    }));

    for (const result of results) {
      expect({ rate: result.rate, fired: result.fired }).toEqual({ rate: result.rate, fired: true });
      expect(result.detectionsInPose).toBeGreaterThanOrEqual(2);
    }

    // A faster detector needs less real time to confirm the same hold.
    const slow = results[0]!.msToFire!;
    const fast = results[2]!.msToFire!;
    expect(fast).toBeLessThan(slow);
  });

  it('does not re-fire while the pose is held, at any rate', () => {
    // The §11.7 invariant must survive the cadence correction.
    for (const rate of [4.7, 10, 30]) {
      const controller = new GestureController();
      const interval = 1000 / rate;
      let nextDetectionAt = 0;
      let fires = 0;

      for (let t = 0; t <= 6000; t += RENDER_MS) {
        if (t >= nextDetectionAt) {
          nextDetectionAt = t + interval;
          fires += controller.observe([tracked(buildLandmarks(POSE_GESTURE))], t).events.length;
        } else {
          controller.renderFrame(t);
        }
      }

      expect({ rate, fires }).toEqual({ rate, fires: 1 });
    }
  });

  it('does not fire on an open hand, at any rate', () => {
    for (const rate of [4.7, 30]) {
      const controller = new GestureController();
      const interval = 1000 / rate;
      let nextDetectionAt = 0;
      let fires = 0;

      for (let t = 0; t <= 4000; t += RENDER_MS) {
        if (t >= nextDetectionAt) {
          nextDetectionAt = t + interval;
          fires += controller.observe([tracked(buildLandmarks(POSE_OPEN))], t).events.length;
        } else {
          controller.renderFrame(t);
        }
      }

      expect({ rate, fires }).toEqual({ rate, fires: 0 });
    }
  });
});
