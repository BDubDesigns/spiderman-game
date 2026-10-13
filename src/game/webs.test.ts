/**
 * Unit tests for webs (PLAN.md §12.2).
 *
 * Travel, splat and the Bézier are all pure, so the animation timing is asserted
 * here rather than eyeballed on a canvas.
 */

import { describe, expect, it } from 'vitest';

import { WEB } from '../config';
import {
  isWebFinished,
  quadraticPoint,
  resolveWeb,
  webControlPoint,
  type Web,
} from './webs';

function web(overrides: Partial<Web> = {}): Web {
  return {
    id: 1,
    origin: 'right',
    from: { x: 0.20, y: 0.50 },
    to: { x: 0.80, y: 0.50 },
    targetId: 3,
    firedAtMs: 0,
    scored: true,
    ...overrides,
  };
}

describe('web geometry', () => {
  it('sags the control point downward, in proportion to the distance', () => {
    const short = webControlPoint({ x: 0.4, y: 0.5 }, { x: 0.6, y: 0.5 }, 4 / 3);
    const long = webControlPoint({ x: 0.0, y: 0.5 }, { x: 1.0, y: 0.5 }, 4 / 3);

    expect(short.y).toBeGreaterThan(0.5);
    expect(long.y).toBeGreaterThan(short.y);
  });

  it('starts the Bézier at `from` and ends it at `to`', () => {
    const from = { x: 0.2, y: 0.4 };
    const to = { x: 0.9, y: 0.7 };
    const control = webControlPoint(from, to, 4 / 3);

    expect(quadraticPoint(from, control, to, 0)).toEqual(from);
    const end = quadraticPoint(from, control, to, 1);
    expect(end.x).toBeCloseTo(to.x, 12);
    expect(end.y).toBeCloseTo(to.y, 12);
  });

  it('passes through the sagged control region at the midpoint', () => {
    const from = { x: 0.0, y: 0.5 };
    const to = { x: 1.0, y: 0.5 };
    const control = webControlPoint(from, to, 4 / 3);
    const mid = quadraticPoint(from, control, to, 0.5);

    expect(mid.x).toBeCloseTo(0.5, 12);
    expect(mid.y).toBeGreaterThan(0.5); // below the chord
  });
});

describe('resolveWeb — travel (§12.2)', () => {
  it('is travelling immediately after firing', () => {
    const state = resolveWeb(web(), 1);
    expect(state.phase).toBe('travelling');
    expect(state.travel).toBeGreaterThanOrEqual(0);
    expect(state.travel).toBeLessThan(1);
    expect(state.splat).toBe(0);
  });

  it('reaches the target exactly at travelMs', () => {
    const state = resolveWeb(web(), WEB.travelMs);
    expect(state.phase).toBe('splatting');
    expect(state.travel).toBe(1);
    expect(state.tip.x).toBeCloseTo(0.80, 12);
    expect(state.tip.y).toBeCloseTo(0.50, 12);
  });

  it('advances monotonically along the curve', () => {
    const w = web();
    let previous = -1;
    for (let t = 0; t <= WEB.travelMs; t += 10) {
      const travel = resolveWeb(w, t).travel;
      expect(travel).toBeGreaterThanOrEqual(previous);
      previous = travel;
    }
    expect(previous).toBeCloseTo(1, 6);
  });

  it('moves the tip from the palm towards the impact point', () => {
    const w = web();
    const early = resolveWeb(w, 10).tip;
    const late = resolveWeb(w, WEB.travelMs - 10).tip;
    expect(late.x).toBeGreaterThan(early.x);
  });

  it('does not overshoot past the impact point', () => {
    const w = web();
    for (let t = 0; t <= WEB.travelMs * 3; t += 5) {
      const tip = resolveWeb(w, t).tip;
      expect(tip.x).toBeLessThanOrEqual(0.80 + 1e-9);
    }
  });

  it('treats a negative elapsed time as not yet fired rather than extrapolating', () => {
    const state = resolveWeb(web(), -50);
    expect(state.travel).toBe(0);
    expect(state.tip.x).toBeCloseTo(0.20, 12);
  });
});

describe('resolveWeb — splat (§12.2)', () => {
  it('runs the splat up to 1 and then reports done', () => {
    const w = web();
    const early = resolveWeb(w, WEB.travelMs + 10);
    expect(early.phase).toBe('splatting');
    expect(early.splat).toBeGreaterThan(0);
    expect(early.splat).toBeLessThan(1);

    const done = resolveWeb(w, WEB.travelMs + WEB.splatMs);
    expect(done.phase).toBe('done');
    expect(done.splat).toBe(1);
  });

  it('advances the splat monotonically', () => {
    const w = web();
    let previous = -1;
    for (let t = WEB.travelMs; t <= WEB.travelMs + WEB.splatMs; t += 20) {
      const splat = resolveWeb(w, t).splat;
      expect(splat).toBeGreaterThanOrEqual(previous);
      previous = splat;
    }
  });

  it('pins the tip to the impact point for the whole splat', () => {
    const w = web();
    for (const t of [WEB.travelMs, WEB.travelMs + 100, WEB.travelMs + WEB.splatMs]) {
      const tip = resolveWeb(w, t).tip;
      expect(tip.x).toBeCloseTo(0.80, 12);
      expect(tip.y).toBeCloseTo(0.50, 12);
    }
  });

  it('isWebFinished only once the splat has completed', () => {
    const w = web();
    expect(isWebFinished(w, 0)).toBe(false);
    expect(isWebFinished(w, WEB.travelMs)).toBe(false);
    expect(isWebFinished(w, WEB.travelMs + WEB.splatMs - 1)).toBe(false);
    expect(isWebFinished(w, WEB.travelMs + WEB.splatMs)).toBe(true);
  });
});

describe('resolveWeb — a miss', () => {
  it('still resolves, because a web fired at nothing is an ordinary outcome', () => {
    const miss = web({ targetId: null, to: { x: 0.9, y: 0.1 }, scored: false });
    const done = resolveWeb(miss, WEB.travelMs);
    expect(done.phase).toBe('splatting');
    expect(done.tip.x).toBeCloseTo(0.9, 12);
    expect(done.tip.y).toBeCloseTo(0.1, 12);
  });
});
