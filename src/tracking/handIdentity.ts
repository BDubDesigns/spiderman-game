/**
 * Stable hand identity across frames (PLAN.md §10).
 *
 * v1 of this project keyed per-hand state on the detection array index. That is
 * unsafe: MediaPipe's array order is not guaranteed stable, and hands cross,
 * occlude and leave the frame. Nothing here keys on array position.
 *
 * ---- What this module is allowed to use (§10.1, §10.4) ----
 *
 * Only actual observations:
 *
 * 1. the model's handedness `{ label, score }` — a genuine model output;
 * 2. previous-frame palm-center position;
 * 3. computed continuity values derived from those two.
 *
 * `identityMatchScore` and `stalenessMs` are **game-computed heuristics**. They are
 * not model confidences and must never be presented as such (§5.1, §6.2, §10.4).
 * The model exposes no per-hand detection, presence or tracking confidence at all.
 *
 * ---- Purity (§6.1) ----
 *
 * No DOM, no canvas, no MediaPipe types: this module takes `RawHandFrame[]` and
 * returns plain data, so the whole association policy is unit-tested against
 * synthetic crossing and reacquisition sequences.
 */

import { IDENTITY } from '../config';
import { Landmark } from './landmarkTypes';
import type {
  Handedness,
  HandednessLabel,
  NormalizedLandmark,
  NormalizedPoint,
  RawHandFrame,
} from './landmarkTypes';

/** The two identities this game tracks. */
export type HandIdentityId = 'left' | 'right';

/** Stable iteration order, so output never depends on detection order. */
export const IDENTITY_IDS: readonly HandIdentityId[] = ['left', 'right'];

/**
 * Landmarks whose centroid is the palm, matching the gesture normalization in
 * PLAN.md §11.1. Kept identical on purpose: identity, aim and gesture must agree
 * on where the palm is.
 */
const PALM_LANDMARKS = [
  Landmark.WRIST,
  Landmark.INDEX_MCP,
  Landmark.MIDDLE_MCP,
  Landmark.RING_MCP,
  Landmark.PINKY_MCP,
] as const;

/** One hand after association, ready to render or to drive game state. */
export interface TrackedHand {
  identity: HandIdentityId;
  /** Landmarks from the last observation of this identity. */
  landmarks: NormalizedLandmark[];
  /** The model's handedness classification for that observation. */
  handedness: Handedness;
  /** Last observed palm center, in normalized video space. */
  palmCenter: NormalizedPoint;
  /**
   * Game-computed match quality in `[0,1]` (§6.2). **Not a model confidence.**
   * Decays while the identity goes unobserved.
   */
  identityMatchScore: number;
  /** Game-computed ms since this identity was last observed. **Not a model output.** */
  stalenessMs: number;
  /** True when the held position is no longer a current observation (§7.2, §10.3). */
  isStale: boolean;
  /**
   * True when the association had to ignore the handedness label to keep this
   * identity tracked, which is the signature of an inverted label (§8).
   */
  handednessConflicted: boolean;
  /**
   * Timestamp of the observation that re-acquired this identity after a loss or an
   * expired grace period, else `null`. M2's state machine uses it to enforce the
   * rearm block (§10.3).
   */
  reacquiredAtMs: number | null;
}

/** Association diagnostics. Crossings and losses are counted, not estimated. */
export interface IdentityStats {
  /** Detections offered this frame (incomplete ones excluded). */
  observed: number;
  /** Detections placed by the handedness-aware assignment. */
  matched: number;
  /** Detections rescued by the handedness-ignoring reconciliation pass. */
  reconciled: number;
  /** Detections adopted into a free identity slot. */
  adopted: number;
  /** Detections discarded because no identity could take them. */
  unmatched: number;
  /**
   * Detections discarded as a **duplicate of a hand already placed this frame**.
   *
   * Counted separately from `unmatched` because the two mean different things: an unmatched
   * detection found nowhere to go, while a duplicate found a place that was already occupied by
   * its own hand. A rising count here is MediaPipe emitting two boxes for one hand, which is a
   * detection-quality signal rather than a tracker fault.
   */
  duplicates: number;
  /** Detections dropped for not carrying a usable palm. */
  incomplete: number;
  /** Cumulative detections that had to ignore handedness. */
  handednessConflicts: number;
  /** Cumulative crossing events (transitions into a crossing). */
  crossings: number;
  inCrossing: boolean;
  /** Cumulative grace-period expiries. */
  losses: number;
  /** Cumulative re-acquisitions after a loss or an expired grace period. */
  reacquisitions: number;
}

export interface IdentityFrame {
  /** Non-lost identities, in `IDENTITY_IDS` order. */
  hands: TrackedHand[];
  stats: IdentityStats;
}

export interface HandIdentityTrackerOptions {
  /** Source intrinsic size, so distance thresholds are resolution-independent. */
  sourceWidth: number;
  sourceHeight: number;
  /** Largest palm-center distance that can still match, as a fraction of the diagonal. */
  maxMatchDistance?: number;
  /** Cost added when handedness contradicts, in the same distance units. */
  handednessMismatchPenalty?: number;
  /** How long an unobserved identity is held before it is declared lost. */
  graceMs?: number;
  /** Palm-center separation (fraction of the diagonal) below which hands cross. */
  crossingRadius?: number;
  /** Below this separation, two detections in one frame are one hand seen twice. */
  duplicateHandRadius?: number;
}

interface Detection {
  hand: RawHandFrame;
  palmCenter: NormalizedPoint;
}

interface IdentityState {
  identity: HandIdentityId;
  landmarks: NormalizedLandmark[] | null;
  handedness: Handedness | null;
  palmCenter: NormalizedPoint | null;
  lastSeenMs: number;
  everSeen: boolean;
  identityMatchScore: number;
  reacquiredAtMs: number | null;
  lost: boolean;
  handednessConflicted: boolean;
}

/** Palm centroid, per PLAN.md §11.1. Returns `null` for an incomplete hand. */
export function palmCenterOf(
  landmarks: readonly NormalizedLandmark[],
): NormalizedPoint | null {
  let x = 0;
  let y = 0;
  for (const index of PALM_LANDMARKS) {
    const lm = landmarks[index];
    if (lm === undefined) return null;
    x += lm.x;
    y += lm.y;
  }
  return { x: x / PALM_LANDMARKS.length, y: y / PALM_LANDMARKS.length };
}

/**
 * Which identity slot a handedness label implies.
 *
 * MediaPipe's handedness is defined against a mirroring assumption and this
 * pipeline mirrors, so the label may be inverted (§8). It is therefore a strong
 * signal, never a definition — which is why this is only used for adoption and
 * tie-breaking, and why every mismatch is counted.
 */
function identityForLabel(label: HandednessLabel): HandIdentityId {
  return label === 'Left' ? 'left' : 'right';
}

/**
 * Associates detections with stable left/right identities.
 *
 * Two passes, deliberately:
 *
 * 1. A handedness-aware assignment. During a crossing, position is down-weighted
 *    and handedness dominates, which is what stops the identities swapping
 *    (§10.2).
 * 2. A reconciliation pass that ignores handedness entirely, for detections the
 *    first pass could not place. Without it, an inverted handedness label (§8)
 *    would drop every hand during a crossing — a worse failure than the swap this
 *    guards against. Every rescue is counted, so an inversion shows up as a
 *    number rather than as hands mysteriously disappearing.
 */
export class HandIdentityTracker {
  readonly stats: IdentityStats = {
    observed: 0,
    matched: 0,
    reconciled: 0,
    adopted: 0,
    unmatched: 0,
    duplicates: 0,
    incomplete: 0,
    handednessConflicts: 0,
    crossings: 0,
    inCrossing: false,
    losses: 0,
    reacquisitions: 0,
  };

  private sourceWidth: number;
  private sourceHeight: number;
  private diagonalPx: number;
  private readonly maxMatchDistance: number;
  private readonly handednessMismatchPenalty: number;
  private readonly graceMs: number;
  private readonly crossingRadius: number;
  private readonly duplicateHandRadius: number;
  private readonly states = new Map<HandIdentityId, IdentityState>();

  constructor(options: HandIdentityTrackerOptions) {
    if (!(options.sourceWidth > 0) || !(options.sourceHeight > 0)) {
      throw new RangeError(
        `source dimensions must be positive, got ${options.sourceWidth}x${options.sourceHeight}`,
      );
    }
    this.sourceWidth = options.sourceWidth;
    this.sourceHeight = options.sourceHeight;
    this.diagonalPx = Math.hypot(options.sourceWidth, options.sourceHeight);
    this.maxMatchDistance = options.maxMatchDistance ?? IDENTITY.maxMatchDistance;
    this.handednessMismatchPenalty =
      options.handednessMismatchPenalty ?? IDENTITY.handednessMismatchPenalty;
    this.graceMs = options.graceMs ?? IDENTITY.graceMs;
    this.crossingRadius = options.crossingRadius ?? IDENTITY.crossingRadius;
    this.duplicateHandRadius = options.duplicateHandRadius ?? IDENTITY.duplicateHandRadius;

    for (const identity of IDENTITY_IDS) {
      this.states.set(identity, {
        identity,
        landmarks: null,
        handedness: null,
        palmCenter: null,
        lastSeenMs: 0,
        everSeen: false,
        identityMatchScore: 0,
        reacquiredAtMs: null,
        lost: false,
        handednessConflicted: false,
      });
    }
  }

  /**
   * Re-point the distance thresholds at a new source size.
   *
   * Called when the camera's intrinsic dimensions change (orientation change,
   * §8 Rule D). Identity state is deliberately preserved: a rotation is not a
   * reason to forget which hand is which.
   */
  setSourceSize(width: number, height: number): void {
    if (!(width > 0) || !(height > 0)) {
      throw new RangeError(`source dimensions must be positive, got ${width}x${height}`);
    }
    this.sourceWidth = width;
    this.sourceHeight = height;
    this.diagonalPx = Math.hypot(width, height);
  }

  private pixelDistance(a: NormalizedPoint, b: NormalizedPoint): number {
    return Math.hypot(
      (a.x - b.x) * this.sourceWidth,
      (a.y - b.y) * this.sourceHeight,
    );
  }

  /** Distance as a fraction of the source diagonal, so thresholds are portable. */
  private normalizedDistance(a: NormalizedPoint, b: NormalizedPoint): number {
    return this.pixelDistance(a, b) / this.diagonalPx;
  }

  /**
   * Whether an identity counts as an independent, live track right now.
   *
   * "Live" means observed recently enough that it is still inside its grace window: the
   * identity has a current position of its own rather than a stale remembered one.
   */
  private isLive(identity: HandIdentityId, nowMs: number): boolean {
    const state = this.states.get(identity);
    if (!state || !state.everSeen || state.lost) return false;
    return nowMs - state.lastSeenMs <= this.graceMs;
  }

  /**
   * Would placing this detection on `identity` put two identities on **one physical hand**?
   *
   * This is the duplicate detector, and it deliberately uses `duplicateHandRadius` rather
   * than `maxMatchDistance`: a matching radius is far too loose to decide "same hand".
   *
   * The escape clause is what keeps genuine two-hand play working. Two identities that are
   * *both already live* may legitimately sit this close — that is exactly what hands
   * crossing looks like — so they are allowed. Anything else is ambiguous, and the safe
   * reading of an ambiguous pair is one hand, not two: a phantom second hand can fire a
   * web, and a missing one merely fails to.
   */
  private collidesWithPlacedHand(
    identity: HandIdentityId,
    point: NormalizedPoint,
    placedCenters: ReadonlyMap<HandIdentityId, NormalizedPoint>,
    nowMs: number,
  ): boolean {
    for (const other of IDENTITY_IDS) {
      if (other === identity) continue;
      const center = placedCenters.get(other);
      if (center === undefined) continue;
      if (this.normalizedDistance(center, point) > this.duplicateHandRadius) continue;
      if (this.isLive(identity, nowMs) && this.isLive(other, nowMs)) continue;
      return true;
    }
    return false;
  }

  /** Whether two hands are close enough that position can no longer be trusted. */
  private detectCrossing(detections: readonly Detection[]): boolean {
    for (let i = 0; i < detections.length; i += 1) {
      for (let j = i + 1; j < detections.length; j += 1) {
        const a = detections[i];
        const b = detections[j];
        if (!a || !b) continue;
        if (this.normalizedDistance(a.palmCenter, b.palmCenter) < this.crossingRadius) {
          return true;
        }
      }
    }

    // Also treat two tracked identities sitting on top of each other as crossing.
    // This covers the frame where one hand has already been occluded and only one
    // detection remains.
    const live: NormalizedPoint[] = [];
    for (const identity of IDENTITY_IDS) {
      const state = this.states.get(identity);
      if (state && !state.lost && state.palmCenter) live.push(state.palmCenter);
    }
    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i];
        const b = live[j];
        if (!a || !b) continue;
        if (this.normalizedDistance(a, b) < this.crossingRadius) return true;
      }
    }

    return false;
  }

  /**
   * Associate one frame's detections and advance every identity.
   *
   * `nowMs` is the render clock. Output order is stable (`IDENTITY_IDS`), never
   * detection order.
   */
  update(hands: readonly RawHandFrame[], nowMs: number): IdentityFrame {
    const detections: Detection[] = [];
    let incomplete = 0;

    for (const hand of hands) {
      const palmCenter = palmCenterOf(hand.landmarks);
      if (palmCenter === null) {
        incomplete += 1;
        continue;
      }
      detections.push({ hand, palmCenter });
    }

    this.stats.observed = detections.length;
    this.stats.incomplete = incomplete;
    this.stats.matched = 0;
    this.stats.reconciled = 0;
    this.stats.adopted = 0;
    this.stats.unmatched = 0;
    this.stats.duplicates = 0;

    const inCrossing = this.detectCrossing(detections);
    if (inCrossing && !this.stats.inCrossing) this.stats.crossings += 1;
    this.stats.inCrossing = inCrossing;

    // §10.1's grace gate is evaluated in pass 3, not here: whether an unmatched
    // detection is a NEW hand or a DUPLICATE of one already placed depends on
    // which identities this frame actually observed, and that is only known once
    // passes 1 and 2 have assigned them.

    const positionWeight = inCrossing ? 0.25 : 1;
    const handednessWeight = inCrossing ? 0.9 : this.handednessMismatchPenalty;

    const assignedDetection = new Set<number>();
    const assignedIdentity = new Set<HandIdentityId>();
    /** Identities placed by ignoring handedness, so the HUD can flag them. */
    const reconciled = new Set<HandIdentityId>();
    const matches = new Map<number, { identity: HandIdentityId; cost: number }>();
    /**
     * Detections judged to be a **duplicate of a hand already placed this frame**.
     *
     * Tracked separately from `unmatched` because the two mean different things: an
     * unmatched detection found nowhere to go, while a duplicate found a place that was
     * already occupied by its own hand. Keeping them distinct is what makes a playtest
     * report diagnosable.
     */
    const duplicates = new Set<number>();
    /** Palm centers placed so far this frame — the reference set for the duplicate guard. */
    const placedCenters = new Map<HandIdentityId, NormalizedPoint>();

    interface Candidate {
      detectionIndex: number;
      identity: HandIdentityId;
      cost: number;
    }

    const candidates: Candidate[] = [];
    for (let d = 0; d < detections.length; d += 1) {
      const detection = detections[d];
      if (!detection) continue;
      for (const identity of IDENTITY_IDS) {
        const state = this.states.get(identity);
        // Never-seen slots are excluded here on purpose. This pass continues an
        // identity that already has a history; creating one is pass 3's job, and
        // only pass 3 knows about the grace gate. Without this split, a brand new
        // hand could claim a slot with no position to compare against, which is
        // indistinguishable from inventing an identity.
        if (!state || !state.everSeen) continue;
        const mismatch =
          state.handedness !== null &&
          state.handedness.label !== detection.hand.handedness.label;
        const distance =
          state.palmCenter === null
            ? this.maxMatchDistance
            : this.normalizedDistance(state.palmCenter, detection.palmCenter);
        candidates.push({
          detectionIndex: d,
          identity,
          cost: positionWeight * distance + handednessWeight * (mismatch ? 1 : 0),
        });
      }
    }

    // Greedy is sufficient, and is what §10.1 permits for two hands.
    candidates.sort((a, b) => a.cost - b.cost);
    for (const candidate of candidates) {
      if (candidate.cost > this.maxMatchDistance) continue;
      if (assignedDetection.has(candidate.detectionIndex)) continue;
      if (assignedIdentity.has(candidate.identity)) continue;
      assignedDetection.add(candidate.detectionIndex);
      assignedIdentity.add(candidate.identity);
      matches.set(candidate.detectionIndex, {
        identity: candidate.identity,
        cost: candidate.cost,
      });
      this.stats.matched += 1;
    }

    // Seed the duplicate reference set from pass 1 before pass 2 runs, so a leftover can be
    // recognised as a second copy of a hand that pass 1 already placed.
    for (const [detectionIndex, match] of matches) {
      const detection = detections[detectionIndex];
      if (detection) placedCenters.set(match.identity, detection.palmCenter);
    }

    // Pass 2: place leftovers by position alone. See the class comment.
    for (let d = 0; d < detections.length; d += 1) {
      if (assignedDetection.has(d)) continue;
      const detection = detections[d];
      if (!detection) continue;

      // A duplicate of a hand already placed this frame must not be reconciled into the
      // other slot. Pass 2 has no handedness check, so without this an identity that is
      // stale-but-nearby is the cheapest place to put a second copy of the same hand —
      // which is how one physical hand came to hold two tracking colours.
      let candidate: { identity: HandIdentityId; distance: number } | null = null;
      for (const identity of IDENTITY_IDS) {
        if (assignedIdentity.has(identity)) continue;
        const state = this.states.get(identity);
        if (!state || !state.everSeen) continue;
        const distance =
          state.palmCenter === null
            ? this.maxMatchDistance
            : this.normalizedDistance(state.palmCenter, detection.palmCenter);
        if (candidate === null || distance < candidate.distance) candidate = { identity, distance };
      }
      if (candidate === null || candidate.distance > this.maxMatchDistance) continue;

      if (this.collidesWithPlacedHand(candidate.identity, detection.palmCenter, placedCenters, nowMs)) {
        // Same physical hand. Retire the detection rather than hand it a second identity.
        duplicates.add(d);
        this.stats.duplicates += 1;
        continue;
      }

      assignedDetection.add(d);
      assignedIdentity.add(candidate.identity);
      reconciled.add(candidate.identity);
      matches.set(d, { identity: candidate.identity, cost: candidate.distance });
      placedCenters.set(candidate.identity, detection.palmCenter);
      this.stats.reconciled += 1;
      this.stats.handednessConflicts += 1;
    }

    // §10.1's grace gate, refined so that it cannot block a second hand.
    //
    // A detection that is plainly a *different* hand must be able to take a free
    // slot even while the other hand is being tracked. The original blanket rule
    // ("no identity may be inside its grace window") forbade that, and a visible
    // hand is always inside its own grace window — so a player who raised one hand
    // and then the other could never obtain a second identity at all, which is
    // fatal for a game whose central rule is alternating hands.
    //
    // The gate now blocks only the two cases where adoption would actually be
    // wrong:
    //
    //   A. **Mis-association.** An identity coasting in its grace window that was
    //      NOT observed this frame may be the very hand this detection represents.
    //      Adopting it would duplicate a single hand — the original §10.1 concern,
    //      and the reason the gate exists.
    //   B. **Duplicate observation.** A detection inside the match radius of a hand
    //      already placed this frame is that hand seen twice (MediaPipe emitting
    //      two boxes for one hand), not a second hand. Adopting it would invent a
    //      phantom identity.
    //
    // Deliberately NOT blocked: a detection far from every placed hand, whose
    // handedness implies a free slot, while the other identity WAS observed this
    // frame. That is a genuinely new opposite hand.
    const unobservedInGrace = IDENTITY_IDS.some((identity) => {
      if (assignedIdentity.has(identity)) return false;
      const state = this.states.get(identity);
      if (!state || !state.everSeen) return false;
      return !state.lost && nowMs - state.lastSeenMs <= this.graceMs;
    });
    const duplicatesPlacedHand = (identity: HandIdentityId, point: NormalizedPoint): boolean =>
      this.collidesWithPlacedHand(identity, point, placedCenters, nowMs);

    // Pass 3: give leftovers a slot — either re-occupying one that was lost, or
    // creating a new one. Both are gated by the two guards above.
    for (let d = 0; d < detections.length; d += 1) {
      if (assignedDetection.has(d) || duplicates.has(d)) continue;
      const detection = detections[d];
      if (!detection) continue;

      if (unobservedInGrace) {
        this.stats.unmatched += 1;
        continue;
      }

      const free = IDENTITY_IDS.filter((identity) => {
        const state = this.states.get(identity);
        return state !== undefined && (state.lost || !state.everSeen);
      });
      const fallback = free[0];
      if (fallback === undefined) {
        this.stats.unmatched += 1;
        continue;
      }

      // Prefer the slot the handedness label implies; otherwise the least
      // recently seen free slot, so adoption is deterministic.
      const implied = identityForLabel(detection.hand.handedness.label);
      const chosen = free.includes(implied)
        ? implied
        : free.reduce((oldest, candidate) => {
            const a = this.states.get(oldest);
            const b = this.states.get(candidate);
            return (b?.lastSeenMs ?? 0) < (a?.lastSeenMs ?? 0) ? candidate : oldest;
          }, fallback);

      assignedDetection.add(d);

      // The duplicate check runs **after** choosing the slot, because the previous two
      // identities matter to it and they are not known until now.
      if (duplicatesPlacedHand(chosen, detection.palmCenter)) {
        assignedDetection.delete(d);
        this.stats.unmatched += 1;
        this.stats.duplicates += 1;
        continue;
      }

      assignedIdentity.add(chosen);
      matches.set(d, { identity: chosen, cost: 0 });
      // Extend the reference set immediately. Building it once, before this loop, meant a
      // second leftover was compared against nothing and both copies of one hand were
      // adopted — the reproduced `adopted: 2`.
      placedCenters.set(chosen, detection.palmCenter);

      // Re-occupying a lost slot is a reacquisition, not a new identity. Keeping
      // the counters distinct is what makes a playtest report diagnosable.
      const chosenState = this.states.get(chosen);
      if (chosenState?.everSeen) {
        this.stats.matched += 1;
      } else {
        this.stats.adopted += 1;
      }
    }

    // Apply matches.
    for (const [detectionIndex, match] of matches) {
      const detection = detections[detectionIndex];
      const state = this.states.get(match.identity);
      if (!detection || !state) continue;

      const staleness = state.everSeen
        ? nowMs - state.lastSeenMs
        : Number.POSITIVE_INFINITY;
      const wasLost = state.lost;
      const reacquired = state.everSeen && (wasLost || staleness > this.graceMs);

      state.landmarks = detection.hand.landmarks;
      state.handedness = detection.hand.handedness;
      state.palmCenter = detection.palmCenter;
      state.lastSeenMs = nowMs;
      state.everSeen = true;
      state.lost = false;
      state.handednessConflicted = reconciled.has(match.identity);
      state.identityMatchScore = Math.max(
        0,
        Math.min(1, 1 - match.cost / this.maxMatchDistance),
      );

      if (reacquired) {
        state.reacquiredAtMs = nowMs;
        this.stats.reacquisitions += 1;
      } else {
        state.reacquiredAtMs = null;
      }
    }

    // Expire or hold identities that were not observed this frame.
    for (const identity of IDENTITY_IDS) {
      if (assignedIdentity.has(identity)) continue;
      const state = this.states.get(identity);
      if (!state || !state.everSeen) continue;

      const staleness = nowMs - state.lastSeenMs;
      if (staleness > this.graceMs) {
        if (!state.lost) this.stats.losses += 1;
        state.lost = true;
        state.identityMatchScore = 0;
        state.reacquiredAtMs = null;
        state.handednessConflicted = false;
      } else {
        // Hold the last known position, marked stale rather than current (§10.3).
        state.identityMatchScore = Math.max(
          0,
          state.identityMatchScore * (1 - staleness / this.graceMs),
        );
      }
    }

    return { hands: this.snapshot(nowMs), stats: { ...this.stats } };
  }

  /** Non-lost identities in stable order. Stale ones are included and flagged. */
  snapshot(nowMs: number): TrackedHand[] {
    const hands: TrackedHand[] = [];
    for (const identity of IDENTITY_IDS) {
      const state = this.states.get(identity);
      if (
        !state ||
        state.lost ||
        !state.landmarks ||
        !state.handedness ||
        !state.palmCenter
      ) {
        continue;
      }
      const stalenessMs = Math.max(0, nowMs - state.lastSeenMs);
      hands.push({
        identity,
        landmarks: state.landmarks,
        handedness: state.handedness,
        palmCenter: state.palmCenter,
        identityMatchScore: state.identityMatchScore,
        stalenessMs,
        isStale: stalenessMs > 0,
        handednessConflicted: state.handednessConflicted,
        reacquiredAtMs: state.reacquiredAtMs,
      });
    }
    return hands;
  }
}
