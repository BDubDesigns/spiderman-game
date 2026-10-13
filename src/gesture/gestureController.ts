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

import { GESTURE, SMOOTHING } from '../config';
import { Landmark } from '../tracking/landmarkTypes';
import { LandmarkSmoother } from './oneEuro';
import { classifyGesture, type GestureGeometry, type GesturePose } from './classifyGesture';
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
}

export interface GestureFrame {
  hands: HandGestureState[];
  events: GestureEvent[];
}

interface IdentityPipeline {
  classifyFilter: LandmarkSmoother;
  renderFilter: LandmarkSmoother;
  machine: GestureStateMachine;
  previousPose: GesturePose | null;
  smoothedScore: number;
  /** Latest smoothed landmarks for drawing. */
  renderLandmarks: NormalizedLandmark[];
}

export class GestureController {
  private readonly pipelines = new Map<HandIdentityId, IdentityPipeline>();

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
          previousPose: null,
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

      const classification = classifyGesture(classifyLandmarks, pipeline.previousPose);
      pipeline.previousPose = classification.pose;

      // Smooth the score so a pose hovering on MIN_GESTURE_SCORE cannot chatter
      // across the boundary (§11.3).
      const alpha = GESTURE.scoreSmoothingAlpha;
      pipeline.smoothedScore =
        pipeline.smoothedScore === 0
          ? classification.score
          : alpha * classification.score + (1 - alpha) * pipeline.smoothedScore;

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
        });
        continue;
      }

      const step = pipeline.machine.update(
        classification.pose.isGesture,
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
        rawScore: classification.score,
        pose: classification.pose,
        geometry: classification.geometry,
        heldMs: step.heldMs,
        cooldownRemainingMs: step.cooldownRemainingMs,
        rearmBlocked: step.rearmBlocked,
        suppressedByHold: step.suppressedByHold,
        frozen: false,
        palmCenter: hand.palmCenter,
        wrist: hand.landmarks[Landmark.WRIST] ?? null,
        indexTip: hand.landmarks[Landmark.INDEX_TIP] ?? null,
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
