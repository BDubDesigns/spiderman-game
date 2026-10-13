/**
 * Unit tests for target and web rendering (PLAN.md §12.2).
 *
 * Following the project's established pattern for renderers (`drawHands.test.ts`,
 * `drawVideo.test.ts`): rendering is verified **without a browser** by driving a
 * recording stub and asserting on the draw calls and their geometry.
 *
 * What this does *not* establish is the visual result — whether a web actually
 * looks like a web. That stays a human check. What it does establish is that the
 * right primitives are issued at the right mirrored positions, which is where a
 * mirroring or coordinate bug would show up.
 */

import { describe, expect, it } from 'vitest';

import { RENDER, WEB } from '../config';
import type { Target } from '../game/targets';
import { resolveWeb, webControlPoint, type Web } from '../game/webs';
import { toCanvas } from './stage';
import {
  drawReticle,
  drawSplat,
  drawTarget,
  drawTargetsAndWebs,
  drawWeb,
  targetRadiusPx,
} from './drawWebs';
import type { NormalizedPoint } from '../tracking/landmarkTypes';

const W = 640;
const H = 480;
const ASPECT = W / H;

/** Records every canvas operation without a DOM. */
class RecordingSurface {
  fillStyle: string = '';
  strokeStyle: string = '';
  lineWidth = 0;
  lineCap: string = '';
  globalAlpha = 1;

  readonly arcs: Array<{ x: number; y: number; radius: number }> = [];
  readonly moves: Array<{ x: number; y: number }> = [];
  readonly lines: Array<{ x: number; y: number }> = [];
  readonly quads: Array<{ cx: number; cy: number; x: number; y: number }> = [];
  readonly fills: string[] = [];
  readonly strokes: string[] = [];
  readonly alphasUsed: number[] = [];
  saveCalls = 0;
  restoreCalls = 0;

  save(): void {
    this.saveCalls += 1;
  }
  restore(): void {
    this.restoreCalls += 1;
    this.globalAlpha = 1;
  }
  beginPath(): void {}
  arc(x: number, y: number, radius: number): void {
    this.arcs.push({ x, y, radius });
  }
  moveTo(x: number, y: number): void {
    this.moves.push({ x, y });
  }
  lineTo(x: number, y: number): void {
    this.lines.push({ x, y });
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.quads.push({ cx, cy, x, y });
  }
  fill(): void {
    this.fills.push(this.fillStyle);
  }
  stroke(): void {
    this.strokes.push(this.strokeStyle);
    this.alphasUsed.push(this.globalAlpha);
  }
}

// The renderers take a real `CanvasRenderingContext2D`; the recording stub is
// structurally compatible for the calls they make.
const asCtx = (s: RecordingSurface): CanvasRenderingContext2D =>
  s as unknown as CanvasRenderingContext2D;

function targetAt(x: number, y: number, state: 'active' | 'webbed' = 'active'): Target {
  return {
    id: 1,
    center: { x, y },
    radius: 0.075,
    state,
    webbedBy: state === 'webbed' ? 2 : null,
    webbedAtMs: state === 'webbed' ? 10 : null,
  };
}

function webFromTo(from: NormalizedPoint, to: NormalizedPoint, firedAtMs = 0): Web {
  return {
    id: 1,
    origin: 'right',
    from,
    to,
    targetId: 7,
    firedAtMs,
    scored: true,
  };
}

describe('targetRadiusPx', () => {
  it('scales with the shorter side, so a target is resolution-independent', () => {
    const target = targetAt(0.5, 0.5);
    expect(targetRadiusPx(target, 640, 480)).toBeCloseTo(0.075 * 480, 12);
    expect(targetRadiusPx(target, 1280, 720)).toBeCloseTo(0.075 * 720, 12);
  });
});

describe('drawTarget', () => {
  it('draws an active target as a ring and a core', () => {
    const s = new RecordingSurface();
    drawTarget(asCtx(s), targetAt(0.5, 0.5), W, H, 0);

    // Outline arc + core arc.
    expect(s.arcs.length).toBeGreaterThanOrEqual(2);
    expect(s.strokes).toContain(RENDER.targetRingColor);
    expect(s.fills).toContain(RENDER.targetColor);
    expect(s.saveCalls).toBe(1);
    expect(s.restoreCalls).toBe(1);
  });

  it('places the target through toCanvas, i.e. horizontally mirrored', () => {
    const s = new RecordingSurface();
    drawTarget(asCtx(s), targetAt(0.25, 0.40), W, H, 0);

    const expected = toCanvas({ x: 0.25, y: 0.40 }, W, H);
    expect(s.arcs[0]!.x).toBeCloseTo(expected.x, 9);
    // §8 Rule B: video (0.25) must land on the RIGHT half of the canvas.
    expect(s.arcs[0]!.x).toBeGreaterThan(W / 2);
    expect(s.arcs[0]!.y).toBeCloseTo(expected.y, 9);
  });

  it('draws a webbed target dimmer and with a web overlay', () => {
    const active = new RecordingSurface();
    const webbed = new RecordingSurface();
    drawTarget(asCtx(active), targetAt(0.5, 0.5, 'active'), W, H, 0);
    drawTarget(asCtx(webbed), targetAt(0.5, 0.5, 'webbed'), W, H, 0);

    expect(webbed.fills).toContain(RENDER.webbedTargetColor);
    expect(active.fills).not.toContain(RENDER.webbedTargetColor);
    // The overlay chords.
    expect(webbed.strokes).toContain(RENDER.webCoreColor);
    expect(webbed.lines.length).toBeGreaterThan(active.lines.length);
    // Dimmed via globalAlpha rather than a second colour.
    expect(webbed.alphasUsed.some((a) => a < 1)).toBe(true);
  });

  it('restores canvas state even for a webbed target', () => {
    const s = new RecordingSurface();
    drawTarget(asCtx(s), targetAt(0.5, 0.5, 'webbed'), W, H, 0);
    expect(s.saveCalls).toBe(s.restoreCalls);
    expect(s.globalAlpha).toBe(1);
  });
});

describe('drawReticle', () => {
  it('draws bracket strokes around the target, mirrored', () => {
    const s = new RecordingSurface();
    drawReticle(asCtx(s), { x: 0.30, y: 0.50 }, 20, W, H);

    expect(s.strokes.length).toBeGreaterThan(0);
    expect(s.strokes[0]).toBe(RENDER.reticleColor);
    const expected = toCanvas({ x: 0.30, y: 0.50 }, W, H);
    expect(s.moves[0]!.x).toBeGreaterThan(expected.x);
    expect(s.saveCalls).toBe(s.restoreCalls);
  });
});

describe('drawWeb', () => {
  it('draws the curve from palm to tip along the sagged Bézier', () => {
    const web = webFromTo({ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 });
    const state = resolveWeb(web, 0, ASPECT);
    const s = new RecordingSurface();
    drawWeb(asCtx(s), web, state, W, H, ASPECT);

    const from = toCanvas(web.from, W, H);
    const control = toCanvas(webControlPoint(web.from, web.to, ASPECT), W, H);
    // Two quadratics: the web line and its brighter core.
    expect(s.quads).toHaveLength(2);
    expect(s.moves[0]).toEqual(from);
    expect(s.quads[0]!.cx).toBeCloseTo(control.x, 9);
    expect(s.quads[0]!.cy).toBeCloseTo(control.y, 9);
    expect(s.strokes).toContain(RENDER.webColor);
    expect(s.strokes).toContain(RENDER.webCoreColor);
  });

  it('ends the travelling curve at the moving tip, not at the target', () => {
    const web = webFromTo({ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 });
    const early = resolveWeb(web, 1, ASPECT);
    const s = new RecordingSurface();
    drawWeb(asCtx(s), web, early, W, H, ASPECT);

    const tip = toCanvas(early.tip, W, H);
    const target = toCanvas(web.to, W, H);
    expect(s.quads[0]!.x).toBeCloseTo(tip.x, 9);
    expect(s.quads[0]!.x).not.toBeCloseTo(target.x, 3);
  });

  it('adds the splat rays only once it has landed', () => {
    const web = webFromTo({ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 });

    const travelling = new RecordingSurface();
    drawWeb(asCtx(travelling), web, resolveWeb(web, 0, ASPECT), W, H, ASPECT);

    const landed = new RecordingSurface();
    drawWeb(asCtx(landed), web, resolveWeb(web, WEB.travelMs + 10, ASPECT), W, H, ASPECT);

    // The splat is the extra moveTo/lineTo pairs beyond the two curves.
    expect(landed.lines.length).toBeGreaterThan(travelling.lines.length);
    expect(landed.moves.length).toBeGreaterThan(travelling.moves.length);
  });

  it('restores canvas state', () => {
    const web = webFromTo({ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.8 });
    const s = new RecordingSurface();
    drawWeb(asCtx(s), web, resolveWeb(web, 0, ASPECT), W, H, ASPECT);
    expect(s.saveCalls).toBe(s.restoreCalls);
  });
});

describe('drawSplat', () => {
  it('draws the configured number of rays', () => {
    const s = new RecordingSurface();
    drawSplat(asCtx(s), 100, 100, 0.2, 4);
    expect(s.moves).toHaveLength(WEB.splatRays);
    expect(s.lines).toHaveLength(WEB.splatRays);
  });

  it('reaches further as it progresses', () => {
    const early = new RecordingSurface();
    const late = new RecordingSurface();
    drawSplat(asCtx(early), 100, 100, 0.1, 4);
    drawSplat(asCtx(late), 100, 100, 0.9, 4);

    const reach = (s: RecordingSurface): number =>
      Math.hypot(s.lines[0]!.x - 100, s.lines[0]!.y - 100);
    expect(reach(late)).toBeGreaterThan(reach(early));
  });

  it('fades out as it progresses', () => {
    const early = new RecordingSurface();
    const late = new RecordingSurface();
    drawSplat(asCtx(early), 100, 100, 0.1, 4);
    drawSplat(asCtx(late), 100, 100, 0.9, 4);

    expect(late.alphasUsed[0]!).toBeLessThan(early.alphasUsed[0]!);
  });

  it('clamps progress outside [0,1] rather than drawing backwards', () => {
    const s = new RecordingSurface();
    drawSplat(asCtx(s), 100, 100, 5, 4);
    expect(s.alphasUsed[0]!).toBeCloseTo(0, 9);
    expect(Number.isFinite(s.lines[0]!.x)).toBe(true);
  });
});

describe('drawTargetsAndWebs', () => {
  it('draws every target and every web', () => {
    const s = new RecordingSurface();
    const targets = [targetAt(0.2, 0.2), targetAt(0.8, 0.3), targetAt(0.5, 0.7)];
    const web = webFromTo({ x: 0.2, y: 0.2 }, { x: 0.8, y: 0.3 });
    drawTargetsAndWebs(
      asCtx(s),
      targets,
      [{ web, state: resolveWeb(web, 0, ASPECT) }],
      W,
      H,
      0,
      ASPECT,
    );

    // One outline arc per active target, at least.
    expect(s.arcs.length).toBeGreaterThanOrEqual(targets.length);
    expect(s.quads.length).toBeGreaterThanOrEqual(2);
  });

  it('draws nothing extra when there is nothing', () => {
    const s = new RecordingSurface();
    drawTargetsAndWebs(asCtx(s), [], [], W, H, 0, ASPECT);
    expect(s.arcs).toHaveLength(0);
    expect(s.quads).toHaveLength(0);
  });
});
