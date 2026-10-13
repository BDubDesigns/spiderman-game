/**
 * Unit tests for aiming (PLAN.md §12.1).
 *
 * The requirement is forgiveness: a deliberate gesture aimed roughly at a target
 * must hit it, and a wild gesture must still hit *something* rather than nothing.
 * That is what these assert.
 */

import { describe, expect, it } from 'vitest';

import { AIM } from '../config';
import { chooseTarget, type AimHand } from './autoAim';
import type { Target } from './targets';

let nextId = 1;

function target(x: number, y: number, state: 'active' | 'webbed' = 'active'): Target {
  return {
    id: nextId++,
    center: { x, y },
    radius: 0.075,
    state,
    webbedBy: null,
    webbedAtMs: null,
  };
}

/** A hand at `(x,y)` facing right along +x, which is how the simulator sits. */
function handAt(x: number, y: number, facingDx = 0.1, facingDy = 0): AimHand {
  return {
    palmCenter: { x, y },
    wrist: { x: x - facingDx, y: y - facingDy },
    indexTip: { x: x + facingDx * 2, y: y + facingDy * 2 },
  };
}

describe('chooseTarget — Model A auto-aim (the default)', () => {
  it('is the configured default model', () => {
    expect(AIM.model).toBe('auto');
  });

  it('picks the nearest target inside the cone', () => {
    const near = target(0.60, 0.50);
    const far = target(0.85, 0.50);
    const hand = handAt(0.30, 0.50); // facing +x, straight at both

    const aim = chooseTarget(hand, [far, near]);
    expect(aim?.target.id).toBe(near.id);
    expect(aim?.reason).toBe('cone');
  });

  it('prefers a target in the cone over a nearer one behind the hand', () => {
    // `behind` is closer to the palm but lies roughly opposite the hand's facing.
    const behind = target(0.36, 0.50);
    const ahead = target(0.70, 0.50);
    const hand = handAt(0.40, 0.50);

    expect(chooseTarget(hand, [behind, ahead])?.target.id).toBe(ahead.id);
  });

  it('falls back to the nearest target when nothing is in the cone', () => {
    // Facing left (away from both), but targets exist to the right.
    const hand = handAt(0.40, 0.50, -0.1, 0);
    const near = target(0.55, 0.50);
    const far = target(0.85, 0.50);

    const aim = chooseTarget(hand, [far, near]);
    expect(aim?.target.id).toBe(near.id);
    expect(aim?.reason).toBe('nearest');
  });

  it('ignores targets that are too close to the palm', () => {
    const onTopOfHand = target(0.31, 0.50);
    const reachable = target(0.70, 0.50);
    const hand = handAt(0.30, 0.50);

    expect(chooseTarget(hand, [onTopOfHand, reachable])?.target.id).toBe(reachable.id);
  });

  it('ignores webbed targets, so an inert target cannot be re-chosen', () => {
    const webbed = target(0.45, 0.50, 'webbed');
    const active = target(0.80, 0.50);
    const hand = handAt(0.30, 0.50);

    expect(chooseTarget(hand, [webbed, active])?.target.id).toBe(active.id);
  });

  it('returns null when every target is webbed', () => {
    const hand = handAt(0.30, 0.50);
    expect(chooseTarget(hand, [target(0.5, 0.5, 'webbed')])).toBeNull();
  });

  it('returns null when there are no targets at all', () => {
    expect(chooseTarget(handAt(0.3, 0.5), [])).toBeNull();
  });

  it('reports the angle it used to choose, for the HUD', () => {
    const hand = handAt(0.30, 0.50);
    const aim = chooseTarget(hand, [target(0.70, 0.50)]);
    expect(aim!.angleDeg).toBeGreaterThanOrEqual(0);
    expect(aim!.angleDeg).toBeLessThanOrEqual(AIM.coneHalfAngleDeg);
  });

  it('copes with a stationary hand that has no outward direction', () => {
    // Wrist and palm coincident: the cone is undefined, so it must not divide by
    // zero or throw; the nearest fallback applies.
    const hand: AimHand = {
      palmCenter: { x: 0.30, y: 0.50 },
      wrist: { x: 0.30, y: 0.50 },
      indexTip: { x: 0.32, y: 0.50 },
    };
    const aim = chooseTarget(hand, [target(0.70, 0.50)]);
    expect(aim?.target.id).toBeDefined();
  });
});

describe('chooseTarget — Model B point-to-aim (the difficulty toggle)', () => {
  it('hits a target the index finger points at', () => {
    const hand: AimHand = {
      palmCenter: { x: 0.30, y: 0.50 },
      wrist: { x: 0.20, y: 0.50 },
      indexTip: { x: 0.60, y: 0.50 }, // pointing straight right
    };

    const aim = chooseTarget(hand, [target(0.80, 0.50)], { model: 'point' });
    expect(aim?.target.id).toBeDefined();
  });

  it('still falls back to auto-aim when the finger points at nothing', () => {
    const hand: AimHand = {
      palmCenter: { x: 0.30, y: 0.50 },
      wrist: { x: 0.20, y: 0.20 },
      indexTip: { x: 0.20, y: 0.10 }, // pointing up and away
    };
    const only = target(0.80, 0.90);

    // A child should get a hit rather than a dead gesture.
    expect(chooseTarget(hand, [only], { model: 'point' })?.target.id).toBe(only.id);
  });
});
