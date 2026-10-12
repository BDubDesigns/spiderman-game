/**
 * Debug HUD.
 *
 * PLAN.md §19.6 requires every tunable and every measured value to be visible, and
 * §7.2 requires the labels to be exact about what is being measured:
 *
 * > Label the HUD clearly: `render FPS`, `inference Hz (measured)`, `interpolated
 * > frames drawn since last detection`. If the last detection is older than
 * > `maxInterpolationAgeMs`, stop advancing the hand and mark it stale.
 *
 * ---- What is deliberately absent ----
 *
 * No model confidence of any kind. The model exposes none (§5.1), so the HUD can
 * only show what this project measures or computes, and every computed value is
 * named as such: `identityMatchScore` and `staleness` are game-computed heuristics
 * (§6.2, §10.4), never presented as model outputs.
 *
 * ---- Mirroring (PLAN.md §8 Rule B) ----
 *
 * HUD text must read correctly, so it is drawn unmirrored. `drawHud()` resets the
 * transform defensively as a safety net against a forgotten reset in the mirrored
 * video pass — a guard, not a licence to leave a transform set.
 */

import { RENDER } from '../config';
import type { FrameProvenance } from '../tracking/landmarkTypes';

/** Measured inference scheduling state (§7.1). Absent when no detector runs. */
export interface HudInferenceStats {
  /** **Measured** achieved rate, from real run timestamps. */
  hz: number;
  /** Duration of the most recent synchronous call. */
  lastCostMs: number;
  /** Moving-average prediction the scheduler actually used. */
  predictedCostMs: number;
  /** Observed frame budget the prediction was compared against. */
  frameBudgetMs: number;
  runs: number;
  skipsOverBudget: number;
  forcedRuns: number;
}

/** Where the current frame's hands came from, and how fresh they are (§7.2). */
export interface HudSourceStats {
  /** Renders drawn since the last successful detection. */
  framesSinceDetection: number;
  /** Game-computed ms since the last observation. `Infinity` before the first. */
  msSinceDetection: number;
  isStale: boolean;
  /**
   * True when the positions shown were advanced between detections for rendering
   * only. M1 does not extrapolate, so this is always false today and the HUD says
   * so explicitly rather than leaving the reader to assume it.
   */
  interpolated: boolean;
  /** Identity diagnostics, camera source only (§10). */
  crossings?: number;
  losses?: number;
  reacquisitions?: number;
  handednessConflicts?: number;
  inCrossing?: boolean;
  /** Which API is clocking inference, when a frame clock exists. */
  frameClock?: 'video-frame' | 'animation-frame';
  /**
   * Consecutive failed detections. Surfaced because the failure policy only gives
   * up once the streak *and* its duration cross a threshold, so a stalled detector
   * would otherwise be invisible until it either recovers or dies.
   */
  consecutiveDetectFailures?: number;
  /**
   * Long animation frames, as reported by Chrome itself.
   *
   * Shown because it is the direct answer to "is inference blocking rendering?" and
   * because it is the one number that would justify building a worker.
   */
  longFrames?: { count: number; maxBlockingMs: number };
  /** Whether long-frame reporting is even available in this browser. */
  frameClockKind?: 'long-animation-frame' | 'unsupported';
}

/** Everything the HUD is allowed to report. */
export interface HudStats {
  sourceId: string;
  provenance: FrameProvenance;
  /** Measured render rate — the success condition, per §7.1. */
  fps: number;
  lastFrameMs: number;
  droppedMs: number;
  updateSteps: number;
  alpha: number;
  handCount: number;
  dotsDrawn: number;
  inference?: HudInferenceStats;
  source?: HudSourceStats;
}

/** Format a millisecond count without pretending to more precision than it has. */
function ms(value: number): string {
  if (!Number.isFinite(value)) return 'none';
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

/**
 * The HUD's text, separated from drawing so it can be tested without a canvas.
 *
 * Keep this free of any value the codebase cannot actually measure.
 */
export function formatHudLines(stats: HudStats): string[] {
  const lines: string[] = [
    `source ${stats.sourceId} (${stats.provenance})`,
    `render ${stats.fps.toFixed(1)} fps   frame ${ms(stats.lastFrameMs)} ms   dropped ${ms(stats.droppedMs)} ms`,
    `hands ${stats.handCount}   dots ${stats.dotsDrawn}   updates ${stats.updateSteps}   alpha ${stats.alpha.toFixed(2)}`,
  ];

  if (stats.inference) {
    const i = stats.inference;
    lines.push(
      `inference ${i.hz.toFixed(1)} Hz (measured)   call ${ms(i.lastCostMs)} ms   predicted ${ms(i.predictedCostMs)} ms of ${ms(i.frameBudgetMs)} ms budget`,
    );
    lines.push(
      `inference runs ${i.runs}   skipped-over-budget ${i.skipsOverBudget}   forced-by-floor ${i.forcedRuns}`,
    );
  } else {
    lines.push('inference not running (no detector for this source)');
  }

  if (stats.source) {
    const s = stats.source;
    const freshness = s.isStale ? 'STALE' : 'current';
    lines.push(
      `detection age ${ms(s.msSinceDetection)} ms (${freshness})   renders since detection ${s.framesSinceDetection}   interpolated frames ${s.interpolated ? 'yes' : 'none'}`,
    );
    if (s.frameClock) lines.push(`frame clock ${s.frameClock}`);
    if (s.longFrames) {
      lines.push(
        s.longFrames.count === 0
          ? `long frames none${s.frameClockKind === 'unsupported' ? ' (not reported by this browser)' : ''}`
          : `long frames ${s.longFrames.count}   worst blocking ${ms(s.longFrames.maxBlockingMs)} ms`,
      );
    }
    if (s.consecutiveDetectFailures) {
      lines.push(
        `detector failures ${s.consecutiveDetectFailures} consecutive (retrying; gives up only if it persists)`,
      );
    }
    if (s.crossings !== undefined) {
      lines.push(
        `identity crossings ${s.crossings}${s.inCrossing ? ' (crossing now)' : ''}   losses ${s.losses ?? 0}   reacquired ${s.reacquisitions ?? 0}   handedness conflicts ${s.handednessConflicts ?? 0}`,
      );
    }
  }

  return lines;
}

/**
 * Draw the HUD, unmirrored, in the top-left corner.
 *
 * `extraLines` is where a caller adds source-specific state without this module
 * having to know about it.
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
