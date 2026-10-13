/**
 * Per-identity gesture pipeline (PLAN.md §11.6, §11.7, §10.3).
 *
 * Ties the three stages together for each tracked hand:
 *
 *   tracked landmarks
 *     -> One Euro filter, **classify** copy (§11.6)
 *     -> classifyGesture with hysteresis (§11.1, §11.3, §11.4)
 *     -> smoothed score
 *     -> GestureStateMachine (§11.7, §11.8)
 *
 * The **render** copy of the filter is exposed separately via `smoothedForRender`,
 * so the drawing path can use heavier smoothing than the classifier without the
 * two ever sharing state. §11.6 requires the split; mixing them would add the
 * render filter's lag to the gesture's reaction time.
 *
 * A stale hand (in grace, not observed this frame) **freezes** its state machine
 * rather than advancing it (§10.3). Feeding frozen positions to the machine would
 * let a held pose keep counting toward HOLD_MS from data that is not being
 * observed, which is precisely the "do not let a lost hand fire" case.
 *
 * Pure apart from the filters: no DOM, no canvas, no MediaPipe.
 */

import { GESTURE, GESTURE_METHOD, SMOOTHING, type GestureMethod } from '../config';
import { Landmark } from '../tracking/landmarkTypes';
import { LandmarkSmoother } from './oneEuro';
import { classifyGesture, type GestureGeometry, type GesturePose } from './classifyGesture';
import { DEFAULT_ASPECT } from './geometry';
import {
  classifyGestureByJoints,
  palmCenterOf,
  spanOf,
  type FingerMeasure,
  type FingerName,
} from './jointCurl';
import { GestureStateMachine, type GestureState } from './gestureStateMachine';
import type { HandIdentityId, TrackedHand } from '../tracking/handIdentity';
import type { NormalizedLandmark, NormalizedPoint } from '../tracking/landmarkTypes';

/** A completed, fresh arming edge. */
export interface GestureEvent {
  identity: HandIdentityId;
  /** The smoothed computed score at the moment of firing. Never a model output. */
  score: number;
  atMs: number;
  /** Where the palm was, for aiming the web (M3). */
  palmCenter: NormalizedPoint;
}

/** Everything the HUD needs about one hand's gesture state. */
export interface HandGestureState {
  identity: HandIdentityId;
  state: GestureState;
  /** Smoothed computed heuristic, `[0,1]` (§11.4). */
  score: number;
  /** Unsmoothed score for this frame. */
  rawScore: number;
  pose: GesturePose;
  geometry: GestureGeometry | null;
  heldMs: number;
  cooldownRemainingMs: number;
  rearmBlocked: boolean;
  suppressedByHold: boolean;
  /** True when the identity is coasting in grace and the machine is frozen. */
  frozen: boolean;
  palmCenter: NormalizedPoint;
  /**
   * Wrist and index tip from the **observed** landmarks, carried through for aiming
   * (§12.1). They are never interpolated: §7.2 keeps advanced positions out of
   * anything that decides gameplay, and aiming decides a hit.
   */
  wrist: NormalizedPoint | null;
  indexTip: NormalizedPoint | null;
  /** Which classifier decided `pose` and `score` this frame. */
  method: GestureMethod;
  /**
   * The *other* classifier's verdict on this same frame (PLAN.md §11.5).
   *
   * This is the comparison diagnostic: both run on identical observed landmarks, so
   * the two can be judged against each other on the device without a code change.
   * Only the active one drives the state machine.
   */
  alternate: {
    method: GestureMethod;
    pose: GesturePose;
    score: number;
    reliableFraction: number;
    /** Per-finger joint measurements, for all four digits. */
    measures: Record<FingerName, FingerMeasure>;
  };
}

export interface GestureFrame {
  hands: HandGestureState[];
  events: GestureEvent[];
}

interface IdentityPipeline {
  classifyFilter: LandmarkSmoother;
  renderFilter: LandmarkSmoother;
  machine: GestureStateMachine;
  /**
   * Hysteresis memory, **kept separately per classifier**.
   *
   * Sharing one would let the inactive method's verdict bias the active method's edge
   * detection — and the two disagree by design (that is the whole point of running
   * both), so a shared seed would make the comparison itself meaningless.
   */
  previousDistancePose: GesturePose | null;
  previousAnglePose: GesturePose | null;
  smoothedScore: number;
  /** Latest smoothed landmarks for drawing. */
  renderLandmarks: NormalizedLandmark[];
}

export class GestureController {
  private readonly pipelines = new Map<HandIdentityId, IdentityPipeline>();

  /**
   * Capture aspect (width / height), used by both classifiers' metric math.
   *
   * Settable because a camera session adopts the negotiated resolution after this
   * controller exists, so the aspect is not known at construction.
   */
  private aspect = DEFAULT_ASPECT;

  constructor(private method: GestureMethod = GESTURE_METHOD) {}

  setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) this.aspect = aspect;
  }

  setMethod(method: GestureMethod): void {
    this.method = method;
  }

  get activeMethod(): GestureMethod {
    return this.method;
  }

  /** The render-smoothed landmarks for an identity, or `null` if unknown. */
  smoothedForRender(identity: HandIdentityId): readonly NormalizedLandmark[] | null {
    return this.pipelines.get(identity)?.renderLandmarks ?? null;
  }

  /** Drop all per-identity state. Used when the source changes. */
  reset(): void {
    this.pipelines.clear();
  }

  /**
   * Advance every tracked identity by one frame.
   *
   * `tracked` is the identity tracker's snapshot; identities absent from it are
   * treated as lost, which is what triggers the §11.8 reset.
   */
  update(tracked: readonly TrackedHand[], nowMs: number): GestureFrame {
    const seen = new Set<HandIdentityId>();
    const hands: HandGestureState[] = [];
    const events: GestureEvent[] = [];

    for (const hand of tracked) {
      seen.add(hand.identity);
      let pipeline = this.pipelines.get(hand.identity);

      if (pipeline === undefined) {
        pipeline = {
          classifyFilter: new LandmarkSmoother(SMOOTHING.classify),
          renderFilter: new LandmarkSmoother(SMOOTHING.render),
          machine: new GestureStateMachine(),
          previousDistancePose: null,
          previousAnglePose: null,
          smoothedScore: 0,
          renderLandmarks: [],
        };
        this.pipelines.set(hand.identity, pipeline);

        // §11.8: a hand that has just been reacquired must be observed released
        // before it can arm, so re-entering the frame already in pose cannot fire.
        if (hand.reacquiredAtMs !== null) pipeline.machine.blockRearm();
      }

      // §11.6: classify on the light stream, render from the heavy one. Both are
      // advanced, from the same observation, so they stay in step.
      const classifyLandmarks = pipeline.classifyFilter.filter(hand.landmarks, nowMs);
      pipeline.renderLandmarks = pipeline.renderFilter.filter(hand.landmarks, nowMs);

      const classification = classifyGesture(
        classifyLandmarks,
        pipeline.previousDistancePose,
        this.aspect,
      );

      // §11.5: run the *other* classifier on the same observed frame so the two can be
      // compared on the device without a rebuild. Only the active one reaches the state
      // machine, so the alternative cannot change gameplay.
      const joint = classifyGestureByJoints(
        classifyLandmarks,
        pipeline.previousAnglePose,
        this.aspect,
        spanOf(classifyLandmarks, this.aspect),
        palmCenterOf(classifyLandmarks) ?? hand.palmCenter,
      );

      pipeline.previousDistancePose = classification.pose;
      pipeline.previousAnglePose = joint.pose;

      // The active method decides what the state machine sees — including the score it
      // gates on. Feeding the machine one method's pose and the other's score would
      // leave it permanently unable to arm.
      const active = this.method === 'angle' ? joint : classification;

      const alternate =
        this.method === 'distance'
          ? {
              method: 'angle' as GestureMethod,
              pose: joint.pose,
              score: joint.score,
              reliableFraction: joint.reliableFraction,
              measures: joint.measures,
            }
          : {
              method: 'distance' as GestureMethod,
              pose: classification.pose,
              score: classification.score,
              reliableFraction: 1,
              measures: joint.measures,
            };

      // Smooth the **active** method's score, so the value the machine gates on and the
      // value the HUD shows belong to the method that is actually in charge (§11.3).
      const alpha = GESTURE.scoreSmoothingAlpha;
      pipeline.smoothedScore =
        pipeline.smoothedScore === 0
          ? active.score
          : alpha * active.score + (1 - alpha) * pipeline.smoothedScore;

      if (hand.isStale) {
        // §10.3: freeze rather than advance, so frozen data cannot satisfy HOLD_MS.
        hands.push({
          identity: hand.identity,
          state: pipeline.machine.currentState,
          score: pipeline.smoothedScore,
          rawScore: classification.score,
          pose: classification.pose,
          geometry: classification.geometry,
          heldMs: 0,
          cooldownRemainingMs: 0,
          rearmBlocked: pipeline.machine.isRearmBlocked,
          suppressedByHold: false,
          frozen: true,
          palmCenter: hand.palmCenter,
          wrist: hand.landmarks[Landmark.WRIST] ?? null,
          indexTip: hand.landmarks[Landmark.INDEX_TIP] ?? null,
          method: this.method,
          alternate,
        });
        continue;
      }

      // The active method decides what the state machine sees.
      const step = pipeline.machine.update(
        active.pose.isGesture,
        pipeline.smoothedScore,
        nowMs,
      );

      if (step.fired) {
        events.push({
          identity: hand.identity,
          score: pipeline.smoothedScore,
          atMs: nowMs,
          palmCenter: hand.palmCenter,
        });
      }

      hands.push({
        identity: hand.identity,
        state: step.state,
        score: pipeline.smoothedScore,
        rawScore: active.score,
        pose: active.pose,
        geometry: classification.geometry,
        heldMs: step.heldMs,
        cooldownRemainingMs: step.cooldownRemainingMs,
        rearmBlocked: step.rearmBlocked,
        suppressedByHold: step.suppressedByHold,
        frozen: false,
        palmCenter: hand.palmCenter,
        wrist: hand.landmarks[Landmark.WRIST] ?? null,
        indexTip: hand.landmarks[Landmark.INDEX_TIP] ?? null,
        method: this.method,
        alternate,
      });
    }

    // §11.8: an identity that has gone (grace expired) is reset, so no armed latch
    // survives a loss.
    for (const [identity, pipeline] of this.pipelines) {
      if (seen.has(identity)) continue;
      pipeline.machine.reset();
      this.pipelines.delete(identity);
    }

    return { hands, events };
  }
}
