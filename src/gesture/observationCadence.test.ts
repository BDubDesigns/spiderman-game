/**
 * Integration regression test: the arrangement the **browser** actually runs.
 *
 * Roughly 5 Hz detection, 60 FPS rendering, one observation held across many render
 * frames, then new observed poses, release, tracking loss, and reacquisition.
 *
 * This is the test that would have caught the bug found in the second real-device
 * playtest. The old code called a single `update()` from the render loop, so the same
 * reused observation advanced the gesture state machine ~12 times per detection — which
 * satisfied `HOLD_MS` (150 ms) from a **single** observation and fired on one glimpse of
 * the pose.
 *
 * The device capture that exposed it held 150 "frames" spanning 4.75 seconds with 16-17 ms
 * deltas: 12 distinct observations, each repeated 10-15 times, with 70 frames reporting
 * `angleGesture: true` for only 8 genuinely gesturing observations.
 *
 * Everything here is expressed in wall-clock milliseconds so the two rates are visible in
 * the test rather than implied by a helper.
 */

import { describe, expect, it } from 'vitest';

import { GESTURE, IDENTITY, INFERENCE } from '../config';
import { Landmark } from '../tracking/landmarkTypes';
import type { NormalizedLandmark } from '../tracking/landmarkTypes';
import { HandIdentityTracker } from '../tracking/handIdentity';
import type { TrackedHand } from '../tracking/handIdentity';
import { GestureController } from './gestureController';
import { HandFrameCapture, recordGestureObservations } from '../debug/capture';

const RENDER_MS = 1000 / 60; // ~60 FPS
const DETECTION_MS = 1000 / 4.7; // ~4.7 Hz, as measured on the Pixel 10 Pro XL
const SOURCE = { sourceWidth: 640, sourceHeight: 480 };

/** Geometry scaffold: wrist-to-middle-MCP span of 0.2 normalized units. */
const WRIST = { x: 0.5, y: 0.8 };
const MIDDLE_MCP = { x: 0.5, y: 0.6 };
const SPAN = 0.2;
const PALM = { x: 0.516, y: 0.656 };

const POSE = {
  gesture: { middle: 0.2 * SPAN, ring: 0.25 * SPAN, index: 1.4 * SPAN, pinky: 1.3 * SPAN },
  open: { middle: 0.9 * SPAN, ring: 0.9 * SPAN, index: 1.5 * SPAN, pinky: 1.4 * SPAN },
};

function buildLandmarks(spec: typeof POSE.gesture, xJitter = 0): NormalizedLandmark[] {
  const points: NormalizedLandmark[] = Array.from({ length: 21 }, () => ({
    x: PALM.x,
    y: PALM.y,
  }));
  points[Landmark.WRIST] = { ...WRIST };
  points[Landmark.MIDDLE_MCP] = { ...MIDDLE_MCP };
  points[Landmark.INDEX_MCP] = { x: 0.45, y: 0.62 };
  points[Landmark.RING_MCP] = { x: 0.55, y: 0.62 };
  points[Landmark.PINKY_MCP] = { x: 0.58, y: 0.64 };
  points[Landmark.MIDDLE_TIP] = { x: PALM.x, y: PALM.y - spec.middle };
  points[Landmark.RING_TIP] = { x: PALM.x, y: PALM.y - spec.ring };
  points[Landmark.INDEX_TIP] = { x: WRIST.x + xJitter, y: WRIST.y - spec.index };
  points[Landmark.PINKY_TIP] = { x: WRIST.x + xJitter, y: WRIST.y - spec.pinky };
  return points;
}

/**
 * A browser-shaped session.
 *
 * `detect()` is called only by the driver at detection times and mimics MediaPipe
 * returning its result; `render()` is called every animation frame and mimics the render
 * loop. The point is that the two are separate code paths, as they now are in `main.ts`.
 */
class BrowserSession {
  readonly controller = new GestureController();
  readonly identity = new HandIdentityTracker(SOURCE);
  readonly capture = new HandFrameCapture({ rollingCapacity: 150, sessionFrameCapacity: 2000 });
  /** Set by a test to simulate the camera returning nothing. */
  cameraReturnsNothing = false;

  private latestTracked: readonly TrackedHand[] = [];
  /**
   * The session's own clock, advanced by `runTimeline`.
   *
   * Kept on the session rather than as a local loop variable so consecutive `runTimeline` calls
   * stay **monotonic**, like the browser's clock. Restarting from zero made time run backwards,
   * which zeroed out `stalenessMs` and made a coasting hand look freshly observed.
   */
  now = 0;
  fires: string[] = [];
  /** Render frames that produced an event. Must always be empty. */
  readonly renderFrameFires: number[] = [];

  /** One MediaPipe detection, at the detection rate. */
  detect(atMs: number, landmarks: NormalizedLandmark[]): void {
    const hands = this.cameraReturnsNothing ? [] : [{ landmarks, handedness: { label: 'Right' as const, score: 0.95 } }];
    this.latestTracked = this.identity.update(hands, atMs).hands;

    const frame = this.controller.observe(this.latestTracked, atMs);
    for (const event of frame.events) this.fires.push(event.identity);
    this.recordCapture(frame, atMs);
  }

  /** One animation frame. Cannot fire, by construction. */
  render(atMs: number): void {
    const frame = this.controller.renderFrame(atMs);
    for (const event of frame.events) this.renderFrameFires.push(event.atMs);
  }

  private recordCapture(frame: ReturnType<GestureController['observe']>, atMs: number): void {
    // The **real** production function, so these tests assert the shipped behaviour rather than a
    // test-local reimplementation that could silently drift from it. (The previous version of this
    // file did reimplement it, which is part of why review flagged the coverage.)
    recordGestureObservations(this.capture, frame, this.latestTracked, atMs);
  }

  /** Whether the pose is currently reported, for the HUD-shaped assertions. */
  isFrozen(atMs: number): boolean {
    return this.controller.renderFrame(atMs).hands[0]?.frozen ?? false;
  }
}

/**
 * Run a full browser-shaped timeline.
 *
 * `poseAt(t)` decides what the *player* is doing at wall-clock `t`; detections sample it
 * at the detection rate and render frames sample it at 60 FPS, but only detections can
 * change gesture state.
 */
function runTimeline(
  session: BrowserSession,
  durationMs: number,
  poseAt: (t: number) => NormalizedLandmark[],
  silentAt: (t: number) => boolean = () => false,
  onFrame?: (t: number, session: BrowserSession) => void,
): void {
  const endMs = session.now + durationMs;
  let nextDetectionAt = session.now;
  for (let t = session.now; t <= endMs; t += RENDER_MS) {
    session.now = t;
    session.cameraReturnsNothing = silentAt(t);
    if (t >= nextDetectionAt) {
      nextDetectionAt = t + DETECTION_MS;
      session.detect(t, poseAt(t));
    } else {
      session.render(t);
    }
    onFrame?.(t, session);
  }
  session.now = endMs;
}

describe('browser arrangement: 4.7 Hz detection, 60 FPS rendering', () => {
  it('confirms the cadence mismatch that caused the bug', () => {
    // ~12.8 render frames per detection interval. `HOLD_MS` (150 ms) fits inside one
    // interval, which is precisely why advancing per render frame fired on one glimpse.
    const framesPerDetection = DETECTION_MS / RENDER_MS;
    expect(framesPerDetection).toBeGreaterThan(12);
    expect(DETECTION_MS).toBeGreaterThan(GESTURE.holdMs);
  });

  it('does not fire from a single held observation', () => {
    const session = new BrowserSession();
    // The pose appears for exactly one detection interval and never returns.
    runTimeline(session, DETECTION_MS * 0.9, () => buildLandmarks(POSE.gesture));

    expect(session.fires).toEqual([]);
  });

  it('fires once the pose is confirmed by a second observation', () => {
    const session = new BrowserSession();
    runTimeline(session, DETECTION_MS * 2.5, () => buildLandmarks(POSE.gesture));

    expect(session.fires).toEqual(['right']);
  });

  it('never fires from a render frame, across a full held observation', () => {
    // The structural guarantee: render frames cannot produce events at all.
    const session = new BrowserSession();
    runTimeline(session, DETECTION_MS * 4, () => buildLandmarks(POSE.gesture));

    expect(session.renderFrameFires).toEqual([]);
  });

  it('runs a full timeline: hold, release, new pose, tracking loss, reacquisition', () => {
    const session = new BrowserSession();
    const T = {
      holdStart: 0,
      holdEnd: DETECTION_MS * 3,
      releaseEnd: DETECTION_MS * 6,
      lossStart: DETECTION_MS * 7,
      lossEnd: DETECTION_MS * 9,
      returnEnd: DETECTION_MS * 13,
    };

    runTimeline(
      session,
      T.returnEnd,
      (t) => {
        if (t < T.holdEnd) return buildLandmarks(POSE.gesture);
        if (t < T.releaseEnd) return buildLandmarks(POSE.open);
        if (t < T.lossStart) return buildLandmarks(POSE.open);
        if (t < T.lossEnd) return buildLandmarks(POSE.open); // camera sees nothing
        // Reacquisition, already in the gesture pose: must NOT fire immediately (§11.8).
        return buildLandmarks(POSE.gesture);
      },
      (t) => t >= T.lossStart && t < T.lossEnd,
    );

    // Exactly one fire, from the first deliberate hold. The reacquired pose must be held
    // through the rearm block rather than firing on arrival.
    expect(session.fires).toEqual(['right']);
  });

  it('does not let a single posed observation, then loss, coast into a fire', () => {
    const session = new BrowserSession();
    // The pose is seen by exactly ONE detection, then the hand vanishes entirely. One
    // observation can never satisfy the hold, and the coasting frames that follow must not
    // complete it on the hand's behalf.
    const holdEnd = DETECTION_MS * 0.9;
    runTimeline(
      session,
      DETECTION_MS * 8,
      () => buildLandmarks(POSE.gesture),
      (t) => t >= holdEnd,
    );

    expect(session.fires).toEqual([]);
  });

  it('marks the hand frozen while the camera reports nothing', () => {
    const session = new BrowserSession();
    let frozenDuringLoss: boolean | null = null;
    const lossStart = DETECTION_MS * 4;
    const lossEnd = DETECTION_MS * 7;

    runTimeline(
      session,
      DETECTION_MS * 9,
      () => buildLandmarks(POSE.open),
      (t) => t >= lossStart && t < lossEnd,
      (t) => {
        // Sampled inside the loss window, past the staleness threshold.
        if (t > lossStart + INFERENCE.maxStalenessMs && t < lossEnd) {
          frozenDuringLoss ??= session.isFrozen(t);
        }
      },
    );

    expect(frozenDuringLoss).toBe(true);
  });
});

describe('reacquisition after a coast (§11.8) — a bug this test found', () => {
  /**
   * The rearm block used to be applied only when the identity's pipeline was **created**.
   * An identity that goes stale-but-not-lost keeps its pipeline (the tracker still returns it
   * in its snapshot), so a hand that left briefly and came back **already in pose** skipped
   * the rearm block and fired on arrival — an accidental shot, from the wrong cause.
   *
   * The fix keys the block on the tracker's reacquisition *timestamp* changing, which is the
   * event §11.8 actually describes.
   *
   * The coast is kept shorter than `IDENTITY.graceMs` deliberately: that is the whole point.
   * A longer absence makes the identity lost, the pipeline is deleted, and the block already
   * applied on creation.
   */

  const D = DETECTION_MS;

  it('does not fire when a briefly-occluded hand returns already in pose', () => {
    const session = new BrowserSession();

    runTimeline(
      session,
      D * 12,
      (t) => {
        if (t < D * 3) return buildLandmarks(POSE.open); // settle released
        if (t < D * 5) return buildLandmarks(POSE.open); // coast (camera silent)
        // Returns already in pose, and stays in pose.
        return buildLandmarks(POSE.gesture);
      },
      // A brief occlusion: ~2 detection intervals, comfortably inside the grace period.
      (t) => t >= D * 3 && t < D * 5,
    );

    // The pose arrives while the identity is still coasting, so the §11.8 rearm block must
    // hold it off rather than firing on arrival.
    expect(session.fires).toEqual([]);
  });

  it('fires again once the returned hand has been observed released and re-posed', () => {
    const session = new BrowserSession();

    runTimeline(
      session,
      D * 16,
      (t) => {
        if (t < D * 3) return buildLandmarks(POSE.open); // released
        if (t < D * 5) return buildLandmarks(POSE.open); // coast
        if (t < D * 9) return buildLandmarks(POSE.gesture); // returns in pose: blocked
        if (t < D * 12) return buildLandmarks(POSE.open); // observed released
        return buildLandmarks(POSE.gesture); // re-posed deliberately
      },
      (t) => t >= D * 3 && t < D * 5,
    );

    // Exactly one fire, and it comes from the second deliberate pose — not from the
    // reacquisition. The block lifting is what makes the later pose work.
    expect(session.fires).toEqual(['right']);
  });
});

describe('within-grace occlusions must still block the rearm (§11.8) — a review finding', () => {
  /**
   * `handIdentity.update()` only sets `reacquiredAtMs` when `wasLost || staleness > graceMs`
   * (600 ms). A hand that vanishes and returns *inside* that window keeps `reacquiredAtMs`
   * null throughout, so keying the rearm block on the tracker's reacquisition alone skipped it.
   *
   * That mattered because the machine's `armedAtMs` survives a freeze: a hand **armed but not
   * yet fired** before a brief occlusion fired the instant it returned, with the hold
   * "completed" across a gap in which nothing was observed.
   *
   * Two timing details make this case easy to miss, and both are asserted rather than assumed:
   *
   * 1. The gap is measured **from the last observation**, not from when the silence begins — the
   *    first detection that finds nothing is already one interval after the last real
   *    observation. One silent detection therefore produces a two-interval gap.
   * 2. The hand must be **armed and un-fired** when the silence starts. If it has already fired,
   *    `armedAtMs` is null and there is no latch to bridge anything, so the bug cannot appear.
   *
   * The earlier test in this file used a ~638 ms gap starting after a fire, which is outside the
   * grace window *and* after the latch cleared — so it exercised neither condition.
   */

  const D = DETECTION_MS;
  const lastObservedBeforeCoast = 0;
  const coastStart = D * 1;
  const coastEnd = D * 2;
  const gapMs = coastEnd - lastObservedBeforeCoast;

  it('is genuinely testing the within-grace case', () => {
    // Guards the guard: if the gap ever grows past the grace period, or the pose stops being
    // held through the coast, this suite silently stops testing what it claims to.
    expect(gapMs).toBeLessThan(IDENTITY.graceMs);
    expect(gapMs).toBeGreaterThan(GESTURE.holdMs);
  });

  it('does not fire when an armed-but-unfired hand returns in pose inside the grace window', () => {
    const session = new BrowserSession();

    // The pose is held from the very first detection, so the machine arms at t=0 and the hold
    // completes *across the gap* unless the return re-blocks it.
    runTimeline(
      session,
      D * 6,
      () => buildLandmarks(POSE.gesture),
      (t) => t >= coastStart && t < coastEnd,
    );

    // Before the fix this was one fire, on arrival at t=coastEnd, from a latch armed before the
    // hand was lost. The gap contained no observation, so no hold was ever confirmed.
    expect(session.fires).toEqual([]);
  });

  it('still fires after the returned hand is observed released and re-posed', () => {
    // The block must not be permanent: a deliberate pose after a real release still works.
    const session = new BrowserSession();

    runTimeline(
      session,
      D * 10,
      (t) => {
        if (t < coastEnd) return buildLandmarks(POSE.gesture); // pose, then coast
        if (t < D * 6) return buildLandmarks(POSE.open); // observed released: block lifts
        return buildLandmarks(POSE.gesture); // deliberate re-pose
      },
      (t) => t >= coastStart && t < coastEnd,
    );

    expect(session.fires).toEqual(['right']);
  });

  it('blocks the rearm on return even though the tracker reports no reacquisition', () => {
    // The mechanism the fix rests on: a coasted identity keeps `reacquiredAtMs === null` and is
    // never counted as a loss, so the controller cannot rely on that signal alone.
    const session = new BrowserSession();

    runTimeline(
      session,
      D * 6,
      () => buildLandmarks(POSE.gesture),
      (t) => t >= coastStart && t < coastEnd,
    );

    expect(session.identity.stats.reacquisitions).toBe(0);
    expect(session.identity.stats.losses).toBe(0);
  });
});

describe('coasting hands never enter the capture — a review finding', () => {
  /**
   * When the camera reports nothing, the identity tracker returns *retained* `isStale` hands;
   * `observe()` returns a frozen copy of the prior state — non-null geometry, and the *old*
   * landmarks — so recording it stamps a fresh timestamp on stale data. That is what made the
   * previous device capture 150 "frames" out of 12 observations, and it would re-pollute the
   * labeled data the thresholds are tuned from.
   *
   * The session below records through the **real** `recordGestureObservations`, so these assert
   * production behaviour rather than a test-local reimplementation.
   */

  it('records nothing while the camera reports no hands at all', () => {
    const session = new BrowserSession();
    runTimeline(
      session,
      DETECTION_MS * 6,
      () => buildLandmarks(POSE.gesture),
      () => true, // nothing is ever reported
    );

    expect(session.capture.size).toBe(0);
  });

  it('does not grow once a previously-captured hand has gone', () => {
    const session = new BrowserSession();
    runTimeline(session, DETECTION_MS * 3, () => buildLandmarks(POSE.gesture));
    const whileVisible = session.capture.size;
    expect(whileVisible).toBeGreaterThan(0);

    // The hand leaves. The tracker keeps coasting on it for the grace period, so those frames
    // must add nothing.
    runTimeline(session, DETECTION_MS * 2, () => buildLandmarks(POSE.gesture), () => true);

    expect(session.capture.size).toBe(whileVisible);
  });
});

describe('capture buffer holds observations, not render frames', () => {
  it('records one entry per detection, not one per animation frame', () => {
    const session = new BrowserSession();
    const detections = 12;
    runTimeline(session, DETECTION_MS * detections, () => buildLandmarks(POSE.gesture));

    // This is the device bug in one assertion: the old code produced 150 entries for ~12
    // observations. Now the counts must agree.
    expect(session.capture.size).toBeGreaterThanOrEqual(detections);
    expect(session.capture.size).toBeLessThanOrEqual(detections + 1);
  });

  it('produces no duplicate landmark sets, which the device capture was full of', () => {
    const session = new BrowserSession();
    runTimeline(session, DETECTION_MS * 10, (t) =>
      // A little real movement, so consecutive observations genuinely differ.
      buildLandmarks(POSE.gesture, Math.sin(t / 400) * 0.02),
    );

    const fingerprints = session.capture.all.map((frame) =>
      frame.landmarks.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join('|'),
    );
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
  });

  it('cannot mark 150 frames as gesturing when only a few observations were', () => {
    // In the device capture, 70 of 150 frames claimed a gesture for 8 real observations.
    const session = new BrowserSession();
    runTimeline(session, DETECTION_MS * 10, () => buildLandmarks(POSE.gesture));

    const gesturingFrames = session.capture.all.filter((f) => f.verdict.angleGesture).length;
    expect(gesturingFrames).toBeLessThanOrEqual(session.capture.size);
    expect(session.capture.size).toBeLessThan(20);
  });
});
