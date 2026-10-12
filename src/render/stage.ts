/**
 * The stage: canvas sizing and THE coordinate transform.
 *
 * PLAN.md §8 calls this the #1 bug source and requires it be handled explicitly.
 * This module is deliberately tiny and pure so it can be exhaustively unit
 * tested — it is the one place where a sign error silently detaches the web from
 * the player's hand.
 *
 * Three spaces exist (PLAN.md §8):
 *
 *   1. **Video space**     — normalized `[0,1]`, origin top-left, unmirrored.
 *                            What the model emits and what `sim/` produces.
 *   2. **Canvas space**    — canvas pixels, origin top-left. The game's space.
 *   3. **CSS/screen space** — how the canvas is laid out. CSS only; no JS math.
 *
 * There is no second coordinate system (Rule E). Aim vectors, target positions
 * and web origins will all live in canvas space.
 */

import type { NormalizedLandmark } from '../tracking/landmarkTypes';

/** A point in canvas space (or, where documented, in pixel space). */
export interface Vec2 {
  x: number;
  y: number;
}

/**
 * THE ONLY place normalized video space becomes canvas space (PLAN.md §8 Rule B).
 *
 * `1 - x` is the horizontal mirror. It is applied here, in code, and nowhere
 * else — specifically NOT with CSS `scaleX(-1)` on the canvas element, because a
 * CSS flip would also mirror HUD text and DOM UI layered above the canvas.
 *
 * `y` is not mirrored: video space and canvas space both grow downward.
 *
 * Do not mix this code flip with a CSS flip. Doing both produces a double mirror
 * for one layer and not the other.
 */
export function toCanvas(
  lm: NormalizedLandmark,
  canvasWidth: number,
  canvasHeight: number,
): Vec2 {
  return { x: (1 - lm.x) * canvasWidth, y: lm.y * canvasHeight };
}

/**
 * The exact inverse of {@link toCanvas}: canvas space back to normalized video
 * space.
 *
 * PLAN.md §8 Rule E permits this only where a subsystem genuinely needs
 * normalized space. At M0 there is one such caller: the mouse simulator needs
 * normalized coordinates for the palm anchor, because the pointer arrives in
 * canvas space, and the wire format for the simulator is normalized so that the
 * simulator stays free of any canvas knowledge. Routing the pointer through this
 * inverse and back out through {@link toCanvas} is what makes a hand drawn under
 * the cursor evidence that the transform round-trips.
 */
export function toNormalized(
  point: Vec2,
  canvasWidth: number,
  canvasHeight: number,
): Vec2 {
  return { x: 1 - point.x / canvasWidth, y: point.y / canvasHeight };
}

/**
 * The minimal canvas surface this module needs. Structural, so the real
 * `HTMLCanvasElement` satisfies it and tests do not need a DOM.
 */
export interface CanvasBackingStore {
  width: number;
  height: number;
}

/**
 * PLAN.md §8 Rule A: **the canvas backing store equals the source's intrinsic
 * dimensions.** Normalized -> canvas then stays a pure multiply, and there is no
 * letterboxing inside the canvas. Viewport fitting is CSS only (see
 * `styles.css`).
 *
 * Returns `true` when the store was resized.
 *
 * **Caller contract:** assigning `width`/`height` resets the 2D context (state,
 * transform, clip). Anything that established a transform — notably the mirrored
 * video pass described in Rule B — must re-establish it after this returns
 * `true`. That is also why the resize is detected rather than blindly applied
 * every frame.
 */
export function syncCanvasBackingStore(
  canvas: CanvasBackingStore,
  sourceWidth: number,
  sourceHeight: number,
): boolean {
  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight)) {
    throw new RangeError(
      `source dimensions must be finite, got ${sourceWidth}x${sourceHeight}`,
    );
  }
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new RangeError(
      `source dimensions must be positive, got ${sourceWidth}x${sourceHeight}`,
    );
  }
  const width = Math.round(sourceWidth);
  const height = Math.round(sourceHeight);
  if (canvas.width === width && canvas.height === height) {
    return false;
  }
  canvas.width = width;
  canvas.height = height;
  return true;
}

/** Clamp a value into `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
