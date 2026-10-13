/**
 * Unit tests for the target field (PLAN.md §12.3).
 *
 * M3's `[A]` criterion is that hit detection and target state have unit tests. The
 * field is deterministic from a seed precisely so these can place a target where
 * they expect one.
 */

import { describe, expect, it } from 'vitest';

import { TARGETS } from '../config';
import { TargetField, normalizedDistance } from './targets';

describe('TargetField spawning', () => {
  it('spawns the configured number of targets, all active', () => {
    const field = new TargetField({ seed: 1 });
    expect(field.all()).toHaveLength(TARGETS.perRound);
    expect(field.active()).toHaveLength(TARGETS.perRound);
    expect(field.webbed()).toHaveLength(0);
    expect(field.remaining).toBe(TARGETS.perRound);
    expect(field.cleared).toBe(false);
  });

  it('is deterministic for a given seed', () => {
    const a = new TargetField({ seed: 7 }).all().map((t) => t.center);
    const b = new TargetField({ seed: 7 }).all().map((t) => t.center);
    expect(a).toEqual(b);
  });

  it('produces a different field for a different seed', () => {
    const a = new TargetField({ seed: 1 }).all().map((t) => t.center);
    const b = new TargetField({ seed: 2 }).all().map((t) => t.center);
    expect(a).not.toEqual(b);
  });

  it('keeps every target fully on screen', () => {
    for (const seed of [0, 3, 11, 42, 99]) {
      for (const target of new TargetField({ seed }).all()) {
        expect(target.center.x).toBeGreaterThanOrEqual(TARGETS.marginFraction);
        expect(target.center.x).toBeLessThanOrEqual(1 - TARGETS.marginFraction);
        expect(target.center.y).toBeGreaterThanOrEqual(TARGETS.marginFraction);
        expect(target.center.y).toBeLessThanOrEqual(1 - TARGETS.marginFraction);
      }
    }
  });

  it('does not clump targets on top of each other', () => {
    const field = new TargetField({ seed: 5 });
    const all = field.all();
    for (let i = 0; i < all.length; i += 1) {
      for (let j = i + 1; j < all.length; j += 1) {
        const distance = normalizedDistance(all[i]!.center, all[j]!.center, 4 / 3);
        expect(distance).toBeGreaterThanOrEqual(TARGETS.minSeparationFraction);
      }
    }
  });

  it('assigns unique ids and respawns from a fresh id space', () => {
    const field = new TargetField({ seed: 4 });
    const ids = field.all().map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);

    field.spawn(4);
    expect(field.all().map((t) => t.id)).toEqual(ids);
    expect(field.active()).toHaveLength(TARGETS.perRound);
  });
});

describe('TargetField hit detection', () => {
  it('contains a point inside the radius and rejects one outside', () => {
    const field = new TargetField({ seed: 1 });
    const target = field.all()[0]!;

    expect(field.contains(target, { ...target.center })).toBe(true);
    expect(
      field.contains(target, { x: target.center.x + target.radius * 3, y: target.center.y }),
    ).toBe(false);
  });

  it('treats the radius as a fraction of the shorter source side', () => {
    const target = { id: 1, center: { x: 0.5, y: 0.5 }, radius: 0.1 } as const;
    // Just inside on the y axis (no aspect scaling) — inside.
    expect(
      TargetField.contains({ ...target, state: 'active', webbedBy: null, webbedAtMs: null },
        { x: 0.5, y: 0.5 + 0.09 }, 4 / 3),
    ).toBe(true);
    // Same offset on x, scaled by the aspect — 0.09 * 4/3 = 0.12, outside.
    expect(
      TargetField.contains({ ...target, state: 'active', webbedBy: null, webbedAtMs: null },
        { x: 0.5 + 0.09, y: 0.5 }, 4 / 3),
    ).toBe(false);
  });
});

describe('TargetField webbing', () => {
  it('webs an active target and marks it inert', () => {
    const field = new TargetField({ seed: 1 });
    const target = field.all()[0]!;

    const webbed = field.web(target.id, 99, 1234);
    expect(webbed).not.toBeNull();
    expect(webbed!.state).toBe('webbed');
    expect(webbed!.webbedBy).toBe(99);
    expect(webbed!.webbedAtMs).toBe(1234);
    expect(field.remaining).toBe(TARGETS.perRound - 1);
  });

  it('refuses to web an already-webbed target, so it cannot be consumed twice', () => {
    const field = new TargetField({ seed: 1 });
    const target = field.all()[0]!;

    expect(field.web(target.id, 1, 0)).not.toBeNull();
    expect(field.web(target.id, 2, 10)).toBeNull();
    // The first web still owns it.
    expect(field.find(target.id)!.webbedBy).toBe(1);
    expect(field.remaining).toBe(TARGETS.perRound - 1);
  });

  it('returns null for an unknown target id', () => {
    const field = new TargetField({ seed: 1 });
    expect(field.web(9999, 1, 0)).toBeNull();
  });

  it('reports cleared once every target is webbed, and never before', () => {
    const field = new TargetField({ seed: 2 });
    const all = field.all();
    all.forEach((target, index) => {
      if (index < all.length - 1) {
        field.web(target.id, index, 0);
        expect(field.cleared).toBe(false);
      }
    });
    const last = all[all.length - 1]!;
    field.web(last.id, 999, 0);
    expect(field.cleared).toBe(true);
    expect(field.remaining).toBe(0);
  });

  it('leaves webbed targets out of active(), so aim ignores them', () => {
    const field = new TargetField({ seed: 1 });
    const target = field.all()[0]!;
    field.web(target.id, 1, 0);

    expect(field.active().map((t) => t.id)).not.toContain(target.id);
    expect(field.webbed().map((t) => t.id)).toContain(target.id);
  });
});
