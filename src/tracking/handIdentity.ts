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

    const inCrossing = this.detectCrossing(detections);
    if (inCrossing && !this.stats.inCrossing) this.stats.crossings += 1;
    this.stats.inCrossing = inCrossing;

    // §10.1: a detection becomes a NEW identity only when no identity is inside
    // its grace window. Computed before assignment, because both "match an unused
    // slot" and "adopt a free slot" create an identity, and both must be gated.
    const anyInGrace = IDENTITY_IDS.some((identity) => {
      const state = this.states.get(identity);
      if (!state || !state.everSeen) return false;
      return !state.lost && nowMs - state.lastSeenMs <= this.graceMs;
    });

    const positionWeight = inCrossing ? 0.25 : 1;
    const handednessWeight = inCrossing ? 0.9 : this.handednessMismatchPenalty;

    const assignedDetection = new Set<number>();
    const assignedIdentity = new Set<HandIdentityId>();
    /** Identities placed by ignoring handedness, so the HUD can flag them. */
    const reconciled = new Set<HandIdentityId>();
    const matches = new Map<number, { identity: HandIdentityId; cost: number }>();

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

    // Pass 2: place leftovers by position alone. See the class comment.
    for (let d = 0; d < detections.length; d += 1) {
      if (assignedDetection.has(d)) continue;
      const detection = detections[d];
      if (!detection) continue;

      let best: { identity: HandIdentityId; distance: number } | null = null;
      for (const identity of IDENTITY_IDS) {
        if (assignedIdentity.has(identity)) continue;
        const state = this.states.get(identity);
        if (!state || !state.everSeen) continue;
        const distance =
          state.palmCenter === null
            ? this.maxMatchDistance
            : this.normalizedDistance(state.palmCenter, detection.palmCenter);
        if (best === null || distance < best.distance) best = { identity, distance };
      }
      if (best === null || best.distance > this.maxMatchDistance) continue;

      assignedDetection.add(d);
      assignedIdentity.add(best.identity);
      reconciled.add(best.identity);
      matches.set(d, { identity: best.identity, cost: best.distance });
      this.stats.reconciled += 1;
      this.stats.handednessConflicts += 1;
    }

    // Pass 3: give leftovers a slot — either re-occupying one that was lost, or
    // creating a new one. Both are gated by `anyInGrace` computed above.
    for (let d = 0; d < detections.length; d += 1) {
      if (assignedDetection.has(d)) continue;
      const detection = detections[d];
      if (!detection) continue;

      if (anyInGrace) {
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
      assignedIdentity.add(chosen);
      matches.set(d, { identity: chosen, cost: 0 });

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
