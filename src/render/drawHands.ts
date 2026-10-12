/**
 * Debug landmark overlay: a dot at every landmark (PLAN.md §21.8).
 *
 * This is the M0 visual output, and from M1 it is the tool that proves the whole
 * pipeline (PLAN.md §8 Rule F): if a dot does not sit on the real hand, the bug
 * is in the pipeline — never patched with a fudge factor here.
 *
 * Every dot is converted through `toCanvas()`. There is no other transform in
 * this file and no mirroring logic — a second place that could mirror is exactly
 * the bug PLAN.md §8 warns about.
 */

import { RENDER } from '../config';
import type { RawHandFrame } from '../tracking/landmarkTypes';
import { toCanvas } from './stage';

/**
 * The narrow slice of `CanvasRenderingContext2D` this module needs.
 *
 * Declared structurally so the real 2D context satisfies it unchanged, while
 * tests can pass a recording stub with no DOM. `fillStyle` is widened to the DOM
 * union so `CanvasRenderingContext2D` remains assignable.
 */
export interface LandmarkDrawSurface {
  fillStyle: string | CanvasGradient | CanvasPattern;
  beginPath(): void;
  arc(
    x: number,
    y: number,
    radius: number,
    startAngle: number,
    endAngle: number,
  ): void;
  fill(): void;
}

export interface DrawHandsOptions {
  radiusPx?: number;
  leftColor?: string;
  rightColor?: string;
}

/** Dot colour for a hand, keyed on the model's handedness label. */
export function colorForHand(
  hand: RawHandFrame,
  options: DrawHandsOptions = {},
): string {
  const left = options.leftColor ?? RENDER.leftColor;
  const right = options.rightColor ?? RENDER.rightColor;
  return hand.handedness.label === 'Left' ? left : right;
}

/**
 * Draw every landmark of every hand. Returns the number of dots drawn, which
 * callers surface in the HUD so that "the hands are being drawn" is observable
 * rather than assumed.
 *
 * The detected array order is not meaningful (PLAN.md §10), so nothing here keys
 * on index beyond iteration; stable identity is M1 work.
 */
export function drawHands(
  surface: LandmarkDrawSurface,
  hands: readonly RawHandFrame[],
  canvasWidth: number,
  canvasHeight: number,
  options: DrawHandsOptions = {},
): number {
  if (!(canvasWidth > 0) || !(canvasHeight > 0)) {
    // A zero-sized backing store means Rule A was not honoured, and every dot
    // would silently pile up at the origin.
    throw new RangeError(
      `canvas dimensions must be positive, got ${canvasWidth}x${canvasHeight}`,
    );
  }

  const radiusPx = options.radiusPx ?? RENDER.landmarkRadiusPx;
  if (!(radiusPx > 0)) {
    throw new RangeError(`radiusPx must be positive, got ${radiusPx}`);
  }

  let dots = 0;
  for (const hand of hands) {
    // One path per hand: all 21 dots share a colour, so they batch into a
    // single fill instead of 21.
    surface.fillStyle = colorForHand(hand, options);
    surface.beginPath();
    for (const landmark of hand.landmarks) {
      const point = toCanvas(landmark, canvasWidth, canvasHeight);
      surface.arc(point.x, point.y, radiusPx, 0, Math.PI * 2);
      dots += 1;
    }
    surface.fill();
  }
  return dots;
}
