/**
 * Per-identity gesture state machine (PLAN.md §11.7, §11.8).
 *
 * ```
 * IDLE ──(gesture && score>=MIN)──> ARMED
 * ARMED ──(held HOLD_MS)──> FIRE ──> COOLDOWN
 * ARMED ──(gesture lost)──> IDLE
 * COOLDOWN ──(gesture still held)──> HELD
 * HELD ──(gesture released)──> IDLE
 * HELD ──(COOLDOWN_MS elapsed && gesture still held)──> stays HELD   // no fire
 * ```
 *
 * **Invariant: a FIRE requires a fresh arming edge.** Holding the gesture never
 * re-fires — which is why `HELD` exists as a state that cannot fire, rather than
 * the machine simply returning to `IDLE` after the cooldown.
 *
 * One instance per identity. It never persists between identity losses: §11.8
 * requires a reset on loss and a rearm block on reacquisition, so a hand that
 * leaves and returns already in pose cannot fire on the way back in.
 *
 * Pure: it takes a boolean, a score and a clock.
 */

import { GESTURE } from '../config';

/** Observable states. `fire` is an instantaneous edge, reported via `fired`. */
export type GestureState = 'idle' | 'armed' | 'cooldown' | 'held';

/** What the machine decided this frame. */
export interface GestureStep {
  state: GestureState;
  /** A fresh arming edge completed and the gesture fired this frame. */
  fired: boolean;
  /** True while a held gesture is deliberately prevented from re-firing. */
  suppressedByHold: boolean;
  /** True while the §11.8 post-reacquisition block is still in force. */
  rearmBlocked: boolean;
  /** Milliseconds the current arming edge has been held, or 0 when not armed. */
  heldMs: number;
  /** Milliseconds remaining before the cooldown expires, or 0. */
  cooldownRemainingMs: number;
}

export interface GestureMachineOptions {
  holdMs?: number;
  cooldownMs?: number;
  rearmMs?: number;
  minGestureScore?: number;
}

export class GestureStateMachine {
  private state: GestureState = 'idle';
  /** When the current arming edge began, or `null` when not armed. */
  private armedAtMs: number | null = null;
  private cooldownUntilMs = 0;
  /**
   * §11.8: after reacquisition the hand must be observed released for `rearmMs`
   * before it may arm. `null` means "not currently released", which restarts the
   * window — the release must be continuous, not merely present at some point.
   */
  private releasedSinceMs: number | null = null;
  private rearmBlocked = false;

  private readonly holdMs: number;
  private readonly cooldownMs: number;
  private readonly rearmMs: number;
  private readonly minGestureScore: number;

  constructor(options: GestureMachineOptions = {}) {
    this.holdMs = options.holdMs ?? GESTURE.holdMs;
    this.cooldownMs = options.cooldownMs ?? GESTURE.cooldownMs;
    this.rearmMs = options.rearmMs ?? GESTURE.rearmMs;
    this.minGestureScore = options.minGestureScore ?? GESTURE.minGestureScore;
  }

  get currentState(): GestureState {
    return this.state;
  }

  get isRearmBlocked(): boolean {
    return this.rearmBlocked;
  }

  /**
   * §10.3 / §11.8: on identity loss, reset to `IDLE` and clear the armed latch.
   * A reacquired hand starts clean.
   */
  reset(): void {
    this.state = 'idle';
    this.armedAtMs = null;
    this.cooldownUntilMs = 0;
    this.releasedSinceMs = null;
    this.rearmBlocked = false;
  }

  /**
   * §11.8: enter the rearm block on reacquisition.
   *
   * The gesture-armed latch is cleared at the same time, so nothing carried over
   * from before the loss can fire.
   */
  blockRearm(): void {
    this.reset();
    this.rearmBlocked = true;
  }

  /**
   * Advance the machine.
   *
   * `held` is the hysteresis-classified pose (`index` and `pinky` extended,
   * `middle` and `ring` folded) and `score` its computed heuristic. Both come from
   * `classifyGesture`; neither is a model confidence (§11.4).
   */
  update(held: boolean, score: number, nowMs: number): GestureStep {
    // --- §11.8 rearm block -------------------------------------------------
    if (this.rearmBlocked) {
      if (held) {
        // Re-entering the pose restarts the release window: the requirement is
        // "observed released for REARM_MS", not "released at some point".
        this.releasedSinceMs = null;
      } else {
        this.releasedSinceMs ??= nowMs;
        if (nowMs - this.releasedSinceMs >= this.rearmMs) {
          this.rearmBlocked = false;
          this.releasedSinceMs = null;
        }
      }
      if (this.rearmBlocked) {
        this.state = 'idle';
        this.armedAtMs = null;
        return this.step(false, false, 0, nowMs);
      }
    }

    const armed = held && score >= this.minGestureScore;
    const coolingDown = nowMs < this.cooldownUntilMs;
    let fired = false;
    let suppressedByHold = false;

    switch (this.state) {
      case 'idle': {
        // A fresh arming edge. Gated on the cooldown so a quick release-and-repose
        // cannot beat the dead time; the invariant is about arming edges, and this
        // keeps the cooldown meaningful rather than decorative.
        if (armed && !coolingDown) {
          this.state = 'armed';
          this.armedAtMs = nowMs;
        }
        break;
      }
      case 'armed': {
        if (!held) {
          // Lost the pose before the hold elapsed: back to idle, no fire.
          this.state = 'idle';
          this.armedAtMs = null;
        } else if (this.armedAtMs !== null && nowMs - this.armedAtMs >= this.holdMs) {
          this.state = 'cooldown';
          this.cooldownUntilMs = nowMs + this.cooldownMs;
          this.armedAtMs = null;
          fired = true;
        }
        break;
      }
      case 'cooldown': {
        if (!held) {
          // Released during the dead time. Back to idle; `cooldownUntilMs` still
          // gates the next arm, so this cannot become an immediate re-fire.
          this.state = 'idle';
        } else if (!coolingDown) {
          // Still held when the dead time expires: HELD, which cannot fire.
          this.state = 'held';
          suppressedByHold = true;
        }
        break;
      }
      case 'held': {
        if (!held) {
          this.state = 'idle';
        } else {
          // Still holding past the cooldown. This is the case the invariant is
          // about: it must NOT fire. Release and re-pose is the only route back.
          suppressedByHold = true;
        }
        break;
      }
    }

    return this.step(fired, suppressedByHold, this.armedAtMs === null ? 0 : nowMs - this.armedAtMs, nowMs);
  }

  private step(
    fired: boolean,
    suppressedByHold: boolean,
    heldMs: number,
    nowMs: number,
  ): GestureStep {
    return {
      state: this.state,
      fired,
      suppressedByHold,
      rearmBlocked: this.rearmBlocked,
      heldMs,
      cooldownRemainingMs: Math.max(0, this.cooldownUntilMs - nowMs),
    };
  }
}
