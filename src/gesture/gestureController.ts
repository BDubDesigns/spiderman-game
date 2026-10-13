/**
 * Per-identity gesture pipeline (PLAN.md §11.6, §11.7, §10.3).
 *
 * Ties the stages together for each tracked hand:
 *
 *   observed landmarks
 *     -> One Euro filter, **classify** copy (§11.6)
 *     -> classifyGesture / classifyGestureByJoints with hysteresis (§11.1, §11.3, §11.5)
 *     -> smoothed score
 *     -> GestureStateMachine (§11.7, §11.8)
 *
 * ---- Observation cadence is not render cadence ----
 *
 * **`observe()` advances state; `renderFrame()` only reads.** They are separate methods
 * because conflating them was a real, measured bug: MediaPipe detects at ~4.7 Hz while
 * `requestAnimationFrame` runs at 60 Hz, so calling a single `update()` from the render
 * loop stepped the state machine roughly **12 times per observation**, feeding it the
 * same landmarks each time.
 *
 * That defeated every protection this module is supposed to provide:
 *
 * - `HOLD_MS` (150 ms) elapsed in render time, so **one** observation at 4.7 Hz spanned
 *   ~200 ms of render frames and satisfied the hold by itself. The machine fired on a
 *   single glimpse of the pose, which is exactly what §11.7's hold exists to prevent.
 * - The One Euro filters and the score smoother were fed the same sample repeatedly, so
 *   they converged on it as though it were sustained motion.
 * - The stale-hand freeze never engaged for the camera path, because the tracker's
 *   `isStale` was computed once — at detection time, when the hand *was* just observed —
 *   and then reused unchanged by every render frame.
 *
 * The split makes the correct behaviour structural rather than a convention: there is no
 * way to advance the machine from a render callback, because `renderFrame()` cannot.
 *
 * A hand with no recent observation **freezes** its state machine (§10.3, §7.2). Stale-ness
 * is recomputed from the age of the last *observation* on every render frame, which is what
 * makes it correct regardless of how the cadence varies.
 *
 * Pure apart from the filters: no DOM, no canvas, no MediaPipe.
 */

import {
  GESTURE,
  GESTURE_METHOD,
  INFERENCE,
  SMOOTHING,
  type GestureMethod,
} from '../config';
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
  /** Unsmoothed score for the observation this state came from. */
  rawScore: number;
  pose: GesturePose;
  geometry: GestureGeometry | null;
  heldMs: number;
  cooldownRemainingMs: number;
  rearmBlocked: boolean;
  suppressedByHold: boolean;
  /**
   * True when no observation has arrived recently, so this state is being held rather
   * than advanced (§10.3). Recomputed per render frame from the last observation's age.
   */
  frozen: boolean;
  /** Milliseconds since the observation this state was computed from. */
  observationAgeMs: number;
  palmCenter: NormalizedPoint;
  /**
   * Wrist and index tip from the **observed** landmarks, carried through for aiming
   * (§12.1). They are never interpolated: §7.2 keeps advanced positions out of anything
   * that decides gameplay, and aiming decides a hit.
   */
  wrist: NormalizedPoint | null;
  indexTip: NormalizedPoint | null;
  /** Which classifier decided `pose` and `score`. */
  method: GestureMethod;
  /**
   * The *other* classifier's verdict on the same observation (PLAN.md §11.5).
   *
   * The comparison diagnostic: both run on identical observed landmarks, so the two can be
   * judged against each other on the device without a code change. Only the active one
   * drives the state machine.
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
  /** Fires produced by **observations**, never by render frames. */
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
   * detection — and the two disagree by design (that is the whole point of running both),
   * so a shared seed would make the comparison itself meaningless.
   */
  previousDistancePose: GesturePose | null;
  previousAnglePose: GesturePose | null;
  smoothedScore: number;
  /** Latest render-smoothed landmarks, for drawing only. */
  renderLandmarks: NormalizedLandmark[];
  /** When the newest observation for this identity arrived. */
  lastObservedAtMs: number;
  /**
   * The `reacquiredAtMs` already handled, so a rearm block is applied exactly once per
   * reacquisition rather than on every observation.
   */
  lastReacquiredAtMs: number | null;
  /**
   * True once this identity has been seen **stale** — coasting on a held position because
   * the camera stopped reporting it — and cleared when it is next observed.
   *
   * The tracker's `reacquiredAtMs` is **not** sufficient for this. It is only set when
   * `wasLost || staleness > IDENTITY.graceMs` (600 ms), so a hand that vanishes and returns
   * *inside* the grace window keeps `reacquiredAtMs === null` throughout and would skip the
   * rearm block entirely. That mattered because the machine's `armedAtMs` survives a freeze, so
   * a hand armed before a brief occlusion fired the instant it returned — with the hold
   * "completed" across a gap in which nothing was observed.
   */
  coastedSinceObserved: boolean;
  /** The state computed from that observation, re-read (and re-aged) per render frame. */
  lastState: HandGestureState | null;
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
    const pipeline = this.pipelines.get(identity);
    if (pipeline === undefined) return null;
    return pipeline.renderLandmarks.length > 0 ? pipeline.renderLandmarks : null;
  }

  /** Drop all per-identity state. Used when the source changes. */
  reset(): void {
    this.pipelines.clear();
  }

  /**
   * Advance every identity by **one real observation**.
   *
   * Call this exactly once per detection, with the detection's timestamp. Identities
   * absent from `tracked` are treated as lost, which is what triggers the §11.8 reset.
   *
   * This is the only method that can advance the state machine or fire.
   */
  observe(tracked: readonly TrackedHand[], atMs: number): GestureFrame {
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
          lastObservedAtMs: atMs,
          lastReacquiredAtMs: null,
          coastedSinceObserved: false,
          lastState: null,
        };
        this.pipelines.set(hand.identity, pipeline);
      }

      // §11.8: a hand that has just been reacquired must be observed released before it can
      // arm, so re-entering the frame already in pose cannot fire.
      //
      // This is keyed on the tracker's reacquisition *timestamp*, not on the pipeline being
      // newly created. Those differ, and the difference was a real accidental-shot path: an
      // identity that went stale-but-not-lost keeps its pipeline (it is still in the
      // snapshot), so a hand that left briefly and returned already in pose used to skip the
      // rearm block entirely and fire on arrival.
      if (
        hand.reacquiredAtMs !== null &&
        hand.reacquiredAtMs !== pipeline.lastReacquiredAtMs
      ) {
        pipeline.machine.blockRearm();
      }
      pipeline.lastReacquiredAtMs = hand.reacquiredAtMs;

      // §10.3: a hand the tracker is *coasting* on is not a new observation. Its
      // landmarks are the held copy from the last real detection, so advancing the
      // filters, classifier or machine with them would be the same mistake as calling
      // this from a render frame — just arriving by a different route.
      if (hand.isStale) {
        const prior = pipeline.lastState;
        // Remember that we coasted, so the return can be treated as a recovery. The
        // tracker does not flag this inside its grace window (see the field's comment).
        pipeline.coastedSinceObserved = true;
        if (prior !== null) {
          const ageMs = Math.max(0, atMs - pipeline.lastObservedAtMs);
          hands.push({ ...prior, frozen: true, observationAgeMs: ageMs });
        }
        // Deliberately does NOT move `lastObservedAtMs`: there was no observation.
        continue;
      }


      if (pipeline.coastedSinceObserved) {
        // The hand returned inside the grace window, so the tracker reported neither a loss
        // nor a reacquisition — but an armed latch must not survive an unobserved gap. Without
        // this, `armedAtMs` bridges the gap and the machine fires on arrival.
        pipeline.machine.blockRearm();
        pipeline.coastedSinceObserved = false;
      }

      pipeline.lastObservedAtMs = atMs;

      // §11.6: classify on the light stream, render from the heavy one. Both advance from
      // the same observation, so they stay in step.
      const classifyLandmarks = pipeline.classifyFilter.filter(hand.landmarks, atMs);
      pipeline.renderLandmarks = pipeline.renderFilter.filter(hand.landmarks, atMs);

      const classification = classifyGesture(
        classifyLandmarks,
        pipeline.previousDistancePose,
        this.aspect,
      );

      // §11.5: run the *other* classifier on the same observation so the two can be
      // compared on the device without a rebuild. Only the active one reaches the machine.
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
      // gates on. Feeding the machine one method's pose and the other's score would leave
      // it permanently unable to arm.
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

      // Smooth the **active** method's score, once per observation (§11.3).
      const alpha = GESTURE.scoreSmoothingAlpha;
      pipeline.smoothedScore =
        pipeline.smoothedScore === 0
          ? active.score
          : alpha * active.score + (1 - alpha) * pipeline.smoothedScore;

      const step = pipeline.machine.update(
        active.pose.isGesture,
        pipeline.smoothedScore,
        atMs,
      );

      if (step.fired) {
        events.push({
          identity: hand.identity,
          score: pipeline.smoothedScore,
          atMs,
          palmCenter: hand.palmCenter,
        });
      }

      const state: HandGestureState = {
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
        observationAgeMs: 0,
        palmCenter: hand.palmCenter,
        wrist: hand.landmarks[Landmark.WRIST] ?? null,
        indexTip: hand.landmarks[Landmark.INDEX_TIP] ?? null,
        method: this.method,
        alternate,
      };
      pipeline.lastState = state;
      hands.push(state);
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

  /**
   * Read the current gesture state for **drawing**, without advancing anything.
   *
   * Safe to call every render frame. Returns no events by construction: a fire can only
   * come from a new observation, so repeated render callbacks can never manufacture a
   * sustained gesture or a shot.
   *
   * Stale-ness is recomputed here from the age of the last observation, so a hand that
   * stopped being observed is marked frozen regardless of how the cadence varies.
   */
  renderFrame(nowMs: number): GestureFrame {
    const hands: HandGestureState[] = [];

    for (const pipeline of this.pipelines.values()) {
      const state = pipeline.lastState;
      if (state === null) continue;

      const ageMs = Math.max(0, nowMs - pipeline.lastObservedAtMs);
      const frozen = ageMs > INFERENCE.maxStalenessMs;

      // Copy rather than mutate, so the stored state stays the observation's state.
      hands.push(
        frozen === state.frozen && ageMs === state.observationAgeMs
          ? state
          : { ...state, frozen, observationAgeMs: ageMs },
      );
    }

    // Deliberately empty: render frames produce no events.
    return { hands, events: [] };
  }
}
