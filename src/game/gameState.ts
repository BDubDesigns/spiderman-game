/**
 * M3 game state: targets and live webs (PLAN.md §12.1–§12.3).
 *
 * Owns the sequence a fire runs through — aim, create the web, resolve the hit,
 * web the target — so it can be unit-tested without a canvas or a camera, and so
 * `main.ts` stays a wire-up rather than a game.
 *
 * **No scoring.** Alternating hands, `lastScoringHand` and win state are M4
 * (§12.4). Everything here is targets, webs and the webbed/inert state, and the
 * `scored` field on a web is recorded but not acted on.
 *
 * Webs are retired once their splat finishes, with a hard cap so a long session
 * cannot accumulate unbounded state.
 */

import { WEB } from '../config';
import { chooseTarget, type AimHand } from './autoAim';
import { Round, type FireVerdict } from './round';
import { TargetField, type Target } from './targets';
import { isWebFinished, resolveWeb, type Web, type WebState } from './webs';

import type { HandIdentityId } from '../tracking/handIdentity';

export interface FireOutcome {
  web: Web;
  /** The target this fire webbed, if it hit one. */
  hit: Target | null;
  /** Whether a target was available to aim at at all. */
  hadTarget: boolean;
  /** §12.4: whether this fire scored, was the wrong hand, or missed. */
  verdict: FireVerdict;
}

export interface FireContext {
  /** The identity the web is drawn from, i.e. the tracker's slot. */
  origin: HandIdentityId;
  /**
   * The hand the §12.4 alternation rule counts.
   *
   * Usually the same as `origin`. It differs for the interactive simulator, where
   * `H` flips the reported handedness at the *same* position: the identity tracker
   * reconciles that by position, because §10.1 makes position the primary continuous
   * signal, so both labels land in the one slot that exists. A slot therefore cannot
   * express "the player switched hands", while the reported label can — and §10.1
   * names the handedness label as the primary signal. So the round keys on it.
   */
  scoringHand: HandIdentityId;
}

export interface GameStateOptions {
  aspect?: number;
  targetCount?: number;
  seed?: number;
}

export class GameState {
  readonly targets: TargetField;
  /** Scoring and the alternating-hand rule (§12.4). */
  readonly round: Round;
  private webs: Web[] = [];
  private nextWebId = 1;
  private readonly aspect: number;
  /** Fires that webbed a target, for the HUD. */
  hits = 0;
  /** Eligible fires that hit nothing, for the HUD. */
  misses = 0;

  constructor(options: GameStateOptions = {}) {
    this.aspect = options.aspect ?? 4 / 3;
    this.targets = new TargetField({
      aspect: this.aspect,
      ...(options.targetCount === undefined ? {} : { count: options.targetCount }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
    this.round = new Round({ targetCount: this.targets.all().length });
  }

  /** Live webs at `nowMs`, oldest first. Retires anything that has finished. */
  liveWebs(nowMs: number): readonly Web[] {
    this.prune(nowMs);
    return this.webs;
  }

  /**
   * Drop finished webs.
   *
   * Called on every read as well as on every fire: pruning only inside `fire()`
   * meant a web stayed on screen indefinitely when the player stopped gesturing,
   * which is exactly when a finished splat is most visible.
   */
  private prune(nowMs: number): void {
    this.webs = this.webs.filter((web) => !isWebFinished(web, nowMs, this.aspect));
  }

  /** Resolved state for every live web, for the renderer. */
  webStates(nowMs: number): { web: Web; state: WebState }[] {
    this.prune(nowMs);
    return this.webs.map((web) => ({ web, state: resolveWeb(web, nowMs, this.aspect) }));
  }

  /** The target auto-aim would choose right now, for the reticle (§12.1). */
  aimedTarget(hand: AimHand | null): Target | null {
    if (hand === null) return null;
    return chooseTarget(hand, this.targets.all(), { aspect: this.aspect })?.target ?? null;
  }

  /**
   * Resolve a fire.
   *
   * The §12.4 gate is applied *here*, before any webbing, so a wrong-hand fire
   * physically cannot consume a target: it still produces a web (harmless feedback)
   * and the hand's state machine still ran, but `TargetField.web()` is never called
   * for it and the round is not advanced.
   */
  fire(hand: AimHand, context: FireContext, nowMs: number): FireOutcome {
    const { origin, scoringHand } = context;
    const eligible = this.round.canScore(scoringHand);
    const aim = chooseTarget(hand, this.targets.all(), { aspect: this.aspect });
    // A miss aims where the hand is looking, which is the palm's outward direction:
    // a web fired at nothing must still visibly leave the hand.
    const fallbackTo = {
      x: hand.palmCenter.x + (hand.palmCenter.x - hand.wrist.x) * 1.5,
      y: hand.palmCenter.y + (hand.palmCenter.y - hand.wrist.y) * 1.5,
    };
    const to = aim === null ? fallbackTo : { ...aim.target.center };

    const web: Web = {
      id: this.nextWebId,
      origin,
      from: { ...hand.palmCenter },
      to,
      targetId: eligible ? (aim?.target.id ?? null) : null,
      firedAtMs: nowMs,
      scored: eligible,
    };
    this.nextWebId += 1;
    this.webs.push(web);

    let hit: Target | null = null;
    if (eligible && aim !== null) {
      hit = this.targets.web(aim.target.id, web.id, nowMs);
    }

    const verdict = this.round.resolve(scoringHand, hit, this.targets.remaining);
    if (verdict.verdict === 'scored') this.hits += 1;
    else if (verdict.verdict === 'no-target') this.misses += 1;
    // A wrong-hand fire is counted by the round, not as a miss: it was not an
    // attempt that failed, it was a shot that was not allowed to count.

    // Retire finished webs, and never hold more than the cap.
    this.prune(nowMs);
    if (this.webs.length > WEB.maxLive) {
      this.webs = this.webs.slice(this.webs.length - WEB.maxLive);
    }

    return { web, hit, hadTarget: aim !== null, verdict: verdict.verdict };
  }

  /** Respawn a fresh field and start a new round (§12.3 replay). */
  respawn(seed = 0): void {
    this.targets.spawn(seed);
    this.webs = [];
    this.hits = 0;
    this.misses = 0;
    this.round.replay();
  }
}
