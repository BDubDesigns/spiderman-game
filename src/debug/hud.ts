/**
 * Debug HUD.
 *
 * A deliberately minimal early slice of the M2 debug HUD (PLAN.md §13 M2). It
 * exists at M0 because PLAN.md §19.6 requires every tunable and every measured
 * value to be visible, and because a frame-rate readout is the cheapest proof
 * that the render loop is alive.
 *
 * ---- What is NOT here, and why ----
 *
 * PLAN.md §7.2 and §6.2 are explicit that only real measurements may be shown.
 * At M0 there is no detector, so this HUD shows **no** inference Hz, **no**
 * latency, **no** `gestureScore` and **no** per-hand state. Reporting any of them
 * would mean inventing a number, so they are omitted rather than stubbed.
 * `formatHudLines()` is unit-tested to keep it that way.
 *
 * ---- Mirroring (PLAN.md §8 Rule B) ----
 *
 * HUD text must read correctly, so it is drawn unmirrored. `drawHud()` defensively
 * resets the transform as a safety net against a forgotten reset in the mirrored
 * video pass — that is a guard, not a licence to leave a transform in place.
 */

import { RENDER } from '../config';
import type { FrameProvenance } from '../tracking/landmarkTypes';

/** Everything the M0 HUD is allowed to report. */
export interface HudStats {
  sourceId: string;
  provenance: FrameProvenance;
  /** Measured render rate (PLAN.md §7.1: the success condition is render FPS). */
  fps: number;
  /** Wall time of the last rendered frame, in ms. */
  lastFrameMs: number;
  /** Time discarded by stall clamping or the catch-up cap, in ms. */
  droppedMs: number;
  updateSteps: number;
  alpha: number;
  handCount: number;
  /** Dots actually drawn, so "hands are rendering" is observed, not assumed. */
  dotsDrawn: number;
}

/**
 * The HUD's text, separated from drawing so it can be tested without a canvas.
 *
 * Keep this free of any value the codebase cannot actually measure yet.
 */
export function formatHudLines(stats: HudStats): string[] {
  return [
    `source ${stats.sourceId} (${stats.provenance})`,
    `render ${stats.fps.toFixed(1)} fps   frame ${stats.lastFrameMs.toFixed(1)} ms   dropped ${stats.droppedMs.toFixed(0)} ms`,
    `hands ${stats.handCount}   dots ${stats.dotsDrawn}   updates ${stats.updateSteps}   alpha ${stats.alpha.toFixed(2)}`,
  ];
}

/**
 * Draw the HUD, unmirrored, in the top-left corner.
 *
 * `extraLines` is where a caller adds source-specific state (for example the
 * simulator's handedness and curl) without this module having to know about it.
 */
export function drawHud(
  ctx: CanvasRenderingContext2D,
  stats: HudStats,
  extraLines: readonly string[] = [],
): void {
  const lines = [...formatHudLines(stats), ...extraLines];

  ctx.save();
  // Rule B: whatever the video pass left behind, the HUD reads left-to-right.
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = RENDER.hudFont;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  let maxWidth = 0;
  for (const line of lines) {
    maxWidth = Math.max(maxWidth, ctx.measureText(line).width);
  }

  const padding = RENDER.hudPaddingPx;
  const boxWidth = maxWidth + padding * 2;
  const boxHeight = lines.length * RENDER.hudLineHeightPx + padding * 2;

  ctx.fillStyle = RENDER.hudBackdropColor;
  ctx.fillRect(0, 0, boxWidth, boxHeight);

  ctx.fillStyle = RENDER.hudColor;
  lines.forEach((line, index) => {
    ctx.fillText(line, padding, padding + index * RENDER.hudLineHeightPx);
  });

  ctx.restore();
}
