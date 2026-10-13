/**
 * Aiming (PLAN.md §12.1).
 *
 * **Model A — auto-aim — is the default**, deliberately forgiving: the primary
 * audience is a young child and the design goal is delight and forgiveness rather
 * than difficulty. Model B (point-to-aim) is available behind `AIM.model` as the
 * difficulty toggle.
 *
 * Auto-aim chooses in this order:
 *
 * 1. the nearest *active* target inside a generous cone around the hand's outward
 *    direction, so a hand pointing roughly at a target wins over a nearer one
 *    behind it;
 * 2. failing that, the nearest active target on screen, so a wild gesture still
 *    does something rather than nothing.
 *
 * Targets nearer than `minDistanceFraction` are ignored: you cannot web your own
 * face, and without that rule the palm's own neighbourhood always wins.
 *
 * Pure geometry — no DOM, no canvas — so the aim policy is unit-tested.
 */

import { AIM } from '../config';
import type { NormalizedPoint } from '../tracking/landmarkTypes';
import { normalizedDistance, type Target } from './targets';

/** What the reticle should show. `null` means nothing is in range. */
export interface AimResult {
  target: Target;
  /** Which rule chose it, for the HUD and for diagnosing a surprising choice. */
  reason: 'cone' | 'nearest';
  /** Signed angle from the hand direction to the target, in degrees. */
  angleDeg: number;
}

/** The hand state aiming needs. Only real observations, never interpolated. */
export interface AimHand {
  /** Palm center in normalized video space — the web origin (§12.2). */
  palmCenter: NormalizedPoint;
  /** Wrist, for the outward direction. */
  wrist: NormalizedPoint;
  /** Index fingertip, used by Model B. */
  indexTip: NormalizedPoint;
}

function angleBetweenDeg(a: NormalizedPoint, b: NormalizedPoint, aspect: number): number {
  const ax = a.x * aspect;
  const ay = a.y;
  const bx = b.x * aspect;
  const by = b.y;
  const na = Math.hypot(ax, ay);
  const nb = Math.hypot(bx, by);
  if (na < 1e-9 || nb < 1e-9) return 0;
  const cosine = Math.min(1, Math.max(-1, (ax * bx + ay * by) / (na * nb)));
  return (Math.acos(cosine) * 180) / Math.PI;
}

/** Outward direction of the hand: wrist -> palm, which every hand has. */
function outwardDirection(hand: AimHand): NormalizedPoint {
  return {
    x: hand.palmCenter.x - hand.wrist.x,
    y: hand.palmCenter.y - hand.wrist.y,
  };
}

/**
 * Choose a target for a fire.
 *
 * Returns `null` when there is nothing to aim at, which the caller must render as
 * a harmless miss rather than as an error: §12.1 leaves "no target" as an ordinary
 * outcome, and a child firing at nothing should still see a web.
 */
export function chooseTarget(
  hand: AimHand,
  targets: readonly Target[],
  options: { aspect?: number; model?: 'auto' | 'point' } = {},
): AimResult | null {
  const aspect = options.aspect ?? 4 / 3;
  const model = options.model ?? AIM.model;
  const candidates = targets.filter((target) => target.state === 'active');
  // `minDistanceFraction` keeps the palm's own neighbourhood from always winning
  // ("you cannot web your own face"), but it must never make a target unreachable:
  // if the only targets left are close ones, they are still the player's only
  // option. So it is a *preference*, not a filter — which matters at the end of a
  // round, where a single nearby target would otherwise dead-end the player.
  const notTooClose = candidates.filter(
    (target) =>
      normalizedDistance(hand.palmCenter, target.center, aspect) >= AIM.minDistanceFraction,
  );
  const usable = notTooClose.length > 0 ? notTooClose : candidates;
  if (usable.length === 0) return null;

  if (model === 'point') {
    // Model B: the ray index -> wrist, with a small angular tolerance.
    const ray: NormalizedPoint = {
      x: hand.indexTip.x - hand.wrist.x,
      y: hand.indexTip.y - hand.wrist.y,
    };
    let best: AimResult | null = null;
    for (const target of usable) {
      const direction: NormalizedPoint = {
        x: target.center.x - hand.wrist.x,
        y: target.center.y - hand.wrist.y,
      };
      const angleDeg = angleBetweenDeg(ray, direction, aspect);
      if (angleDeg > AIM.pointModelToleranceDeg) continue;
      const distance = normalizedDistance(hand.palmCenter, target.center, aspect);
      if (best === null || distance < normalizedDistance(hand.palmCenter, best.target.center, aspect)) {
        best = { target, reason: 'cone', angleDeg };
      }
    }
    return best ?? autoAim(hand, usable, aspect);
  }

  return autoAim(hand, usable, aspect);
}

function autoAim(hand: AimHand, usable: readonly Target[], aspect: number): AimResult {
  const outward = outwardDirection(hand);
  const usableDirection = Math.hypot(outward.x * aspect, outward.y) > 1e-6;

  let bestInCone: AimResult | null = null;
  let bestAny: AimResult | null = null;

  for (const target of usable) {
    const direction: NormalizedPoint = {
      x: target.center.x - hand.palmCenter.x,
      y: target.center.y - hand.palmCenter.y,
    };
    const distance = normalizedDistance(hand.palmCenter, target.center, aspect);
    const angleDeg = usableDirection ? angleBetweenDeg(outward, direction, aspect) : 0;

    if (bestAny === null || distance < normalizedDistance(hand.palmCenter, bestAny.target.center, aspect)) {
      bestAny = { target, reason: 'nearest', angleDeg };
    }
    if (angleDeg <= AIM.coneHalfAngleDeg) {
      if (
        bestInCone === null ||
        distance < normalizedDistance(hand.palmCenter, bestInCone.target.center, aspect)
      ) {
        bestInCone = { target, reason: 'cone', angleDeg };
      }
    }
  }

  // Rule 1 first, then rule 2. A target behind the hand still counts as a miss-free
  // fallback, because "no target" should be rare for a small child.
  return bestInCone ?? bestAny!;
}
