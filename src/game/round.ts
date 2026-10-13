/**
 * Round scoring and the alternating-hand rule (PLAN.md §12.4).
 *
 * `lastScoringHand` records the hand that most recently **scored**. A fire from the
 * other hand may score; a fire from the same hand is a **wrong-hand no-op**, which:
 *
 * - produces harmless feedback,
 * - does **not** score,
 * - does **not** consume or web a target,
 * - does **not** change `lastScoringHand`,
 * - does **not** change the required next hand.
 *
 * The M2 state machine has already run FIRE → COOLDOWN → HELD/IDLE for the wrong
 * hand, so the gesture still *feels* responsive; what changes is only whether the
 * shot counts. Cooldown expiry alone never enables scoring — the wrong hand must
 * release and rearm (§11.7), so it cannot spam fires hoping one eventually counts.
 *
 * Pure: it takes an identity, a target and a clock.
 */

import type { HandIdentityId } from '../tracking/handIdentity';
import type { Target } from './targets';

/** A round's lifecycle. `playing` → `won` is the only forward transition. */
export type RoundPhase = 'playing' | 'won';

/** Why a fire did or did not score, for the HUD and for tests. */
export type FireVerdict =
  /** Scored: webbed a target and the hand was eligible. */
  | 'scored'
  /** The other hand's turn: feedback only, no state change. */
  | 'wrong-hand'
  /** The right hand, but nothing to hit. */
  | 'no-target';

export interface ScoredFire {
  verdict: FireVerdict;
  /** The target scored against, or `null`. */
  target: Target | null;
  /** The hand now required for the next scoring fire, or `null` when won. */
  requiredHand: HandIdentityId | null;
}

export interface RoundOptions {
  /** Targets to clear. */
  targetCount: number;
}

export class Round {
  private phase: RoundPhase = 'playing';
  private lastScoringHand: HandIdentityId | null = null;
  private scoredCount = 0;
  private wrongHandAttempts = 0;
  private readonly targetCount: number;

  constructor(options: RoundOptions) {
    this.targetCount = options.targetCount;
  }

  get currentPhase(): RoundPhase {
    return this.phase;
  }

  /** The hand whose fire would score next, or `null` once the round is won. */
  get requiredHand(): HandIdentityId | null {
    if (this.phase === 'won') return null;
    if (this.lastScoringHand === null) return null; // either hand may open
    return this.lastScoringHand === 'left' ? 'right' : 'left';
  }

  /** The hand that most recently scored. `null` before the first score. */
  get lastScoringHandValue(): HandIdentityId | null {
    return this.lastScoringHand;
  }

  get scored(): number {
    return this.scoredCount;
  }

  get wrongHandFires(): number {
    return this.wrongHandAttempts;
  }

  /**
   * Whether a fire from `identity` may score.
   *
   * Before the first score either hand may open the round, which keeps the opening
   * forgiving: a child who starts with either hand is not told they were wrong.
   */
  canScore(identity: HandIdentityId): boolean {
    if (this.phase === 'won') return false;
    return this.requiredHand === null || identity === this.requiredHand;
  }

  /**
   * Resolve a fire.
   *
   * The caller must only call this for a *green* verdict after actually webbing the
   * target, so that a wrong-hand fire cannot consume one (§12.4). To make that
   * impossible to get wrong, `resolve` takes the already-webbed target and returns
   * the verdict rather than performing the webbing itself.
   */
  resolve(identity: HandIdentityId, target: Target | null, remainingAfter: number): ScoredFire {
    if (!this.canScore(identity)) {
      // Harmless feedback; no mutation at all.
      this.wrongHandAttempts += 1;
      return { verdict: 'wrong-hand', target: null, requiredHand: this.requiredHand };
    }

    if (target === null) {
      // Right hand, nothing to hit: not a wrong-hand fire, and not a score.
      return { verdict: 'no-target', target: null, requiredHand: this.requiredHand };
    }

    this.lastScoringHand = identity;
    this.scoredCount += 1;
    if (remainingAfter <= 0) {
      this.phase = 'won';
    }

    return {
      verdict: 'scored',
      target,
      requiredHand: this.phase === 'won' ? null : this.requiredHand,
    };
  }

  /** True once every target is webbed. */
  get won(): boolean {
    return this.phase === 'won';
  }

  /** Start a fresh round (§12.3 replay). */
  replay(): void {
    this.phase = 'playing';
    this.lastScoringHand = null;
    this.scoredCount = 0;
    this.wrongHandAttempts = 0;
  }

  /** Targets in the round, for the HUD's progress readout. */
  get total(): number {
    return this.targetCount;
  }
}
