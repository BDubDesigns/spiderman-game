/**
 * Canvas 2D rendering for targets and webs (PLAN.md §12.2).
 *
 * Split from `game/targets.ts` and `game/webs.ts` so timing and hit rules are
 * unit-tested without a canvas, and so this file stays a thin translation of
 * already-decided positions. No game rules live here.
 *
 * All positions arrive in **normalized video space** and are converted through
 * `toCanvas()`. §8 Rule B: mirroring happens in exactly one place, and a renderer
 * must not add a second flip.
 */

import { RENDER, TARGETS, WEB } from '../config';
import type { Web, WebState } from '../game/webs';
import { webControlPoint } from '../game/webs';
import type { Target } from '../game/targets';
import { toCanvas } from './stage';
import type { NormalizedPoint } from '../tracking/landmarkTypes';

/** Radius of a target in canvas pixels, from its normalized fraction. */
export function targetRadiusPx(target: Target, width: number, height: number): number {
  // A fraction of the shorter side, so a target covers the same visual area at any
  // capture resolution (§TARGETS.radiusFraction).
  return target.radius * Math.min(width, height);
}

/**
 * Draw one target.
 *
 * Active targets are a filled ring with a bright center; webbed targets are inert
 * — dimmer, with the web overlay lines that mark them as done (§12.2).
 */
export function drawTarget(
  ctx: CanvasRenderingContext2D,
  target: Target,
  width: number,
  height: number,
  nowMs: number,
): void {
  const center = toCanvas(target.center, width, height);
  const radius = targetRadiusPx(target, width, height);
  const webbed = target.state === 'webbed';

  ctx.save();
  if (webbed) {
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = RENDER.webbedTargetColor;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    ctx.fill();

    // The web overlay: chords across the disc, which read as "wrapped" at a glance.
    ctx.strokeStyle = RENDER.webCoreColor;
    ctx.lineWidth = 1;
    for (let i = 0; i < 5; i += 1) {
      const angle = (i / 5) * Math.PI * 2 + 0.4;
      ctx.beginPath();
      ctx.moveTo(center.x - Math.cos(angle) * radius, center.y - Math.sin(angle) * radius);
      ctx.lineTo(center.x + Math.cos(angle) * radius, center.y + Math.sin(angle) * radius);
      ctx.stroke();
    }
  } else {
    // A slow pulse, so an active target reads as "alive" without being distractingly
    // busy. Derived from the clock, not from any measured value.
    const pulse = 1 + 0.06 * Math.sin(nowMs / 320);
    ctx.fillStyle = RENDER.targetColor;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius * pulse, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = RENDER.targetRingColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius * pulse, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle = RENDER.targetCoreColor;
    ctx.beginPath();
    ctx.arc(center.x, center.y, radius * 0.32, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draw the reticle on the target auto-aim has chosen (§12.1).
 *
 * Snapping the reticle to the chosen target is what makes auto-aim honest: the
 * player can see what they are about to hit.
 */
export function drawReticle(
  ctx: CanvasRenderingContext2D,
  center: NormalizedPoint,
  radiusPx: number,
  width: number,
  height: number,
): void {
  const point = toCanvas(center, width, height);
  const r = radiusPx * 1.35;

  ctx.save();
  ctx.strokeStyle = RENDER.reticleColor;
  ctx.lineWidth = 2;
  // Four corner brackets, which read as a targeting reticle without occluding it.
  for (let i = 0; i < 4; i += 1) {
    const base = (i * Math.PI) / 2 + Math.PI / 4;
    for (const side of [-1, 1]) {
      const angle = base + side * 0.28;
      ctx.beginPath();
      ctx.moveTo(point.x + Math.cos(angle) * r, point.y + Math.sin(angle) * r);
      ctx.lineTo(point.x + Math.cos(angle) * (r + 7), point.y + Math.sin(angle) * (r + 7));
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * Draw a web: the curve from palm to tip plus the splat once it lands.
 *
 * `state` is the resolved web state, so this function does no timing of its own.
 */
export function drawWeb(
  ctx: CanvasRenderingContext2D,
  web: Web,
  state: WebState,
  width: number,
  height: number,
  aspect: number,
): void {
  const from = toCanvas(web.from, width, height);
  const to = toCanvas(web.to, width, height);
  const controlNorm = webControlPoint(web.from, web.to, aspect);
  const control = toCanvas(controlNorm, width, height);

  const chordPx = Math.hypot(to.x - from.x, to.y - from.y);
  const distanceShare = Math.min(1, chordPx / Math.max(width, height));
  const width_px = WEB.baseLineWidthPx + WEB.distanceLineWidthPx * distanceShare;

  ctx.save();
  ctx.lineCap = 'round';

  // The drawn portion: from the palm to wherever the tip is right now.
  const tip = toCanvas(state.tip, width, height);

  // A shallow quadratic from `from` to `tip` reusing the same control point keeps
  // the travelling segment on the final curve rather than bowing separately.
  ctx.strokeStyle = RENDER.webColor;
  ctx.lineWidth = state.phase === 'travelling' ? Math.max(1, width_px * 0.7) : width_px;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(control.x, control.y, tip.x, tip.y);
  ctx.stroke();

  // The bright core, for the comic-book look (§12.2).
  ctx.strokeStyle = RENDER.webCoreColor;
  ctx.lineWidth = WEB.coreLineWidthPx;
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(control.x, control.y, tip.x, tip.y);
  ctx.stroke();

  if (state.phase !== 'travelling') {
    drawSplat(ctx, tip.x, tip.y, state.splat, width_px);
  }

  ctx.restore();
}

/** Short radiating lines that scale up then fade (§12.2). */
export function drawSplat(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  progress: number,
  lineWidthPx: number,
): void {
  const clamped = Math.min(1, Math.max(0, progress));
  const reach = 6 + 22 * clamped;
  const alpha = 1 - clamped;

  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.lineWidth = lineWidthPx;
  ctx.lineCap = 'round';
  ctx.strokeStyle = RENDER.splatColor;
  for (let i = 0; i < WEB.splatRays; i += 1) {
    const angle = (i / WEB.splatRays) * Math.PI * 2 + 0.3;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(angle) * 3, y + Math.sin(angle) * 3);
    ctx.lineTo(x + Math.cos(angle) * reach, y + Math.sin(angle) * reach);
    ctx.stroke();
  }
  ctx.restore();
}

/** Draw every target, then every web on top. */
export function drawTargetsAndWebs(
  ctx: CanvasRenderingContext2D,
  targets: readonly Target[],
  webs: readonly { web: Web; state: WebState }[],
  width: number,
  height: number,
  nowMs: number,
  aspect: number,
): void {
  for (const target of targets) drawTarget(ctx, target, width, height, nowMs);
  for (const { web, state } of webs) drawWeb(ctx, web, state, width, height, aspect);
}

/**
 * The default target radius in pixels.
 *
 * Kept next to the renderer so a caller that needs a radius without a `Target`
 * (the reticle, for instance) does not reach into `TARGETS` directly.
 */
export function defaultTargetRadiusPx(width: number, height: number): number {
  return TARGETS.radiusFraction * Math.min(width, height);
}
