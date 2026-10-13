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
import { TargetField, type Target } from './targets';
import { isWebFinished, resolveWeb, type Web, type WebState } from './webs';

export interface FireOutcome {
  web: Web;
  /** The target this fire webbed, if it hit one. */
  hit: Target | null;
  /** Whether a target was available to aim at at all. */
  hadTarget: boolean;
}

export interface GameStateOptions {
  aspect?: number;
  targetCount?: number;
  seed?: number;
}

export class GameState {
  readonly targets: TargetField;
  private webs: Web[] = [];
  private nextWebId = 1;
  private readonly aspect: number;
  /** Fires that hit a target, for the HUD. */
  hits = 0;
  /** Fires that hit nothing, for the HUD. */
  misses = 0;

  constructor(options: GameStateOptions = {}) {
    this.aspect = options.aspect ?? 4 / 3;
    this.targets = new TargetField({
      aspect: this.aspect,
      ...(options.targetCount === undefined ? {} : { count: options.targetCount }),
      ...(options.seed === undefined ? {} : { seed: options.seed }),
    });
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
   * `scored` records whether this hand was eligible to score, which M4 will decide;
   * M3 always webs the target it hits, because the webbing is the M3 requirement
   * and gating it on M4's rule would leave M3 unable to demonstrate anything.
   */
  fire(hand: AimHand, origin: 'left' | 'right', nowMs: number, scored = true): FireOutcome {
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
      targetId: aim?.target.id ?? null,
      firedAtMs: nowMs,
      scored,
    };
    this.nextWebId += 1;
    this.webs.push(web);

    const hit = aim === null ? null : this.targets.web(aim.target.id, web.id, nowMs);
    if (hit === null) this.misses += 1;
    else this.hits += 1;

    // Retire finished webs, and never hold more than the cap.
    this.prune(nowMs);
    if (this.webs.length > WEB.maxLive) {
      this.webs = this.webs.slice(this.webs.length - WEB.maxLive);
    }

    return { web, hit, hadTarget: aim !== null };
  }

  /** Respawn a fresh field, e.g. on replay. */
  respawn(seed = 0): void {
    this.targets.spawn(seed);
    this.webs = [];
    this.hits = 0;
    this.misses = 0;
  }
}
