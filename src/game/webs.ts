/**
 * Webs (PLAN.md §12.2).
 *
 * A web is a quadratic Bézier from the palm to an impact point, with a control
 * point sagging downward in proportion to the distance. Its tip travels along that
 * curve over `WEB.travelMs`; on arrival it splats, and the target it hit becomes
 * inert.
 *
 * Pure state and geometry here; the canvas drawing is in `render/drawWebs.ts`. The
 * split means travel and splat timing are unit-tested without a canvas, and the
 * renderer is a thin translation of already-decided positions.
 */

import { WEB } from '../config';
import type { NormalizedPoint } from '../tracking/landmarkTypes';

/** Where a web is in its life. */
export type WebPhase = 'travelling' | 'splatting' | 'done';

/** A web, from palm to impact. */
export interface Web {
  id: number;
  /** Which hand fired it. */
  origin: 'left' | 'right';
  /** Palm center at the moment of firing — the origin is frozen (§12.2). */
  from: NormalizedPoint;
  /** Impact point: the target it hit, or where it was aimed if it hit nothing. */
  to: NormalizedPoint;
  /** Target id when the web hit one. */
  targetId: number | null;
  /** When it was fired, on the caller's clock. */
  firedAtMs: number;
  /** True when the player's own gesture, not the aim rule, decided the hand. */
  scored: boolean;
}

/** A web's resolved state at a given time. */
export interface WebState {
  phase: WebPhase;
  /** Progress of the tip along the curve, `[0,1]`. */
  travel: number;
  /** Progress of the splat, `[0,1]`. 0 while travelling. */
  splat: number;
  /** Where the tip is right now. */
  tip: NormalizedPoint;
}

/**
 * The Bézier control point: the chord's midpoint, pushed down by `sagFraction` of
 * the chord length.
 *
 * "Sagging downward proportional to distance" (§12.2) — so a long web droops more,
 * which is what makes a heavy web read as heavy.
 */
export function webControlPoint(
  from: NormalizedPoint,
  to: NormalizedPoint,
  aspect: number,
): NormalizedPoint {
  const chord = Math.hypot((to.x - from.x) * aspect, to.y - from.y);
  return {
    x: (from.x + to.x) / 2,
    // Downward is +y in video space.
    y: (from.y + to.y) / 2 + chord * WEB.sagFraction,
  };
}

/** Point on a quadratic Bézier at `t`. */
export function quadraticPoint(
  from: NormalizedPoint,
  control: NormalizedPoint,
  to: NormalizedPoint,
  t: number,
): NormalizedPoint {
  const u = 1 - t;
  return {
    x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
    y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
  };
}

/** Ease-out, so the web decelerates into the target rather than stopping dead. */
function easeOut(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return 1 - (1 - clamped) * (1 - clamped);
}

/** Resolve a web's phase, travel and tip position at `nowMs`. */
export function resolveWeb(web: Web, nowMs: number, aspect = 4 / 3): WebState {
  const elapsed = Math.max(0, nowMs - web.firedAtMs);
  const control = webControlPoint(web.from, web.to, aspect);

  if (elapsed < WEB.travelMs) {
    const travel = easeOut(elapsed / WEB.travelMs);
    return {
      phase: 'travelling',
      travel,
      splat: 0,
      tip: quadraticPoint(web.from, control, web.to, travel),
    };
  }

  const splatElapsed = elapsed - WEB.travelMs;
  const splat = Math.min(1, splatElapsed / WEB.splatMs);
  return {
    phase: splat >= 1 ? 'done' : 'splatting',
    travel: 1,
    splat,
    tip: { ...web.to },
  };
}

/** True once a web has finished splatting and can be retired. */
export function isWebFinished(web: Web, nowMs: number, aspect = 4 / 3): boolean {
  return resolveWeb(web, nowMs, aspect).phase === 'done';
}
