/**
 * Unit tests for round scoring and the alternating-hand rule (PLAN.md §12.4).
 *
 * This is M4's `[A]` acceptance criterion: "scoring and alternation state machine
 * unit tests pass, including the wrong-hand no-op rule (§12.4)".
 *
 * §12.4 lists five things a wrong-hand fire must NOT do, and each has its own test.
 */

import { describe, expect, it } from 'vitest';

import { Round } from './round';
import type { Target } from './targets';

function target(id: number): Target {
  return { id, center: { x: 0.5, y: 0.5 }, radius: 0.075, state: 'active', webbedBy: null, webbedAtMs: null };
}

function round(targetCount = 3): Round {
  return new Round({ targetCount });
}

describe('Round — alternation (§12.4)', () => {
  it('lets either hand open the round, so a child is never told they started wrong', () => {
    const r = round();
    expect(r.requiredHand).toBeNull();
    expect(r.canScore('left')).toBe(true);
    expect(r.canScore('right')).toBe(true);
  });

  it('requires the other hand after a score', () => {
    const r = round();
    const first = r.resolve('right', target(1), 2);

    expect(first.verdict).toBe('scored');
    expect(first.requiredHand).toBe('left');
    expect(r.requiredHand).toBe('left');
    expect(r.canScore('left')).toBe(true);
    expect(r.canScore('right')).toBe(false);
  });

  it('alternates right → left → right across a round', () => {
    const r = round(3);
    expect(r.resolve('right', target(1), 2).verdict).toBe('scored');
    expect(r.resolve('left', target(2), 1).verdict).toBe('scored');
    expect(r.resolve('right', target(3), 0).verdict).toBe('scored');
    expect(r.scored).toBe(3);
    expect(r.won).toBe(true);
  });

  it('works starting from the left just as well', () => {
    const r = round(3);
    expect(r.resolve('left', target(1), 2).verdict).toBe('scored');
    expect(r.requiredHand).toBe('right');
    expect(r.resolve('right', target(2), 1).verdict).toBe('scored');
    expect(r.requiredHand).toBe('left');
  });
});

describe('Round — the wrong-hand no-op has all five properties (§12.4)', () => {
  it('produces feedback (a returned verdict) without scoring', () => {
    const r = round();
    r.resolve('right', target(1), 2);
    const verdict = r.resolve('right', target(2), 2);

    expect(verdict.verdict).toBe('wrong-hand');
    expect(verdict.target).toBeNull();
    expect(r.scored).toBe(1);
  });

  it('does not consume or web a target', () => {
    const r = round(2);
    r.resolve('right', target(1), 1);
    const attempted = target(2);
    r.resolve('right', attempted, 1);

    // The caller never handed it a webbed target, and `resolve` returned null, so
    // nothing downstream can have consumed it.
    expect(attempted.state).toBe('active');
    expect(r.scored).toBe(1);
  });

  it('does not change lastScoringHand', () => {
    const r = round();
    r.resolve('right', target(1), 2);
    expect(r.lastScoringHandValue).toBe('right');
    r.resolve('right', target(2), 2);
    expect(r.lastScoringHandValue).toBe('right');
  });

  it('does not change the required next hand', () => {
    const r = round();
    r.resolve('right', target(1), 2);
    expect(r.requiredHand).toBe('left');
    r.resolve('right', target(2), 2);
    r.resolve('right', target(3), 2);
    expect(r.requiredHand).toBe('left');
  });

  it('cannot make progress by spamming the wrong hand', () => {
    const r = round(3);
    r.resolve('right', target(1), 2);
    for (let i = 0; i < 50; i += 1) r.resolve('right', target(2), 2);

    expect(r.scored).toBe(1);
    expect(r.wrongHandFires).toBe(50);
    expect(r.won).toBe(false);
  });
});

describe('Round — win state (§12.3)', () => {
  it('is won when the last target is scored, and only then', () => {
    const r = round(2);
    expect(r.resolve('right', target(1), 1).verdict).toBe('scored');
    expect(r.won).toBe(false);
    expect(r.requiredHand).toBe('left');

    expect(r.resolve('left', target(2), 0).verdict).toBe('scored');
    expect(r.won).toBe(true);
    expect(r.currentPhase).toBe('won');
    expect(r.requiredHand).toBeNull();
  });

  it('offers no required hand once won, and cannot score further', () => {
    const r = round(1);
    r.resolve('right', target(1), 0);
    expect(r.won).toBe(true);
    expect(r.requiredHand).toBeNull();
    expect(r.canScore('left')).toBe(false);
    expect(r.canScore('right')).toBe(false);
  });

  it('rejects a fire after the win rather than scoring again', () => {
    const r = round(1);
    r.resolve('right', target(1), 0);
    expect(r.resolve('left', target(2), 0).verdict).toBe('wrong-hand');
    expect(r.scored).toBe(1);
  });

  it('replay() resets everything, including the opening freedom', () => {
    const r = round(2);
    r.resolve('right', target(1), 1);
    r.resolve('right', target(2), 1); // a wrong-hand attempt
    r.resolve('left', target(2), 0);
    expect(r.won).toBe(true);

    r.replay();
    expect(r.won).toBe(false);
    expect(r.scored).toBe(0);
    expect(r.wrongHandFires).toBe(0);
    expect(r.lastScoringHandValue).toBeNull();
    expect(r.requiredHand).toBeNull();
    expect(r.canScore('left')).toBe(true);
  });
});

describe('Round — a missed shot from the correct hand', () => {
  it('is not a score, and not a wrong-hand fire either', () => {
    const r = round(2);
    r.resolve('right', target(1), 1);
    // Left is required, and left fires but hits nothing.
    const verdict = r.resolve('left', null, 1);

    expect(verdict.verdict).toBe('no-target');
    expect(r.scored).toBe(1);
    expect(r.wrongHandFires).toBe(0);
    // Still left's turn: a miss must not hand the turn back.
    expect(r.requiredHand).toBe('left');
  });

  it('does not consume the turn when nothing is left to hit', () => {
    const r = round(1);
    r.resolve('right', null, 1);
    expect(r.scored).toBe(0);
    expect(r.requiredHand).toBeNull();
    expect(r.won).toBe(false);
  });
});
