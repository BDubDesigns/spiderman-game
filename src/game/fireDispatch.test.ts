/**
 * Tests for the event-to-shot seam (PLAN.md §12.1, §12.4).
 *
 * Requested by review on PR #12, and rightly so: the synthetic cadence test proves the
 * *controller* advances only on observations, but it says nothing about whether an event ever
 * reaches the game. It did not, for the camera — the only `game.fire()` call sat in the render
 * loop, and camera render frames carry no events by construction, so a camera gesture was
 * counted and then silently dropped. The camera could register a web gesture and never shoot.
 *
 * These tests exercise the dispatch itself, and the last group pins the *wiring*: that one
 * event produces exactly one shot, not zero and not two.
 */

import { describe, expect, it } from 'vitest';

import { Landmark } from '../tracking/landmarkTypes';
import type { TrackedHand } from '../tracking/handIdentity';
import type { GestureEvent } from '../gesture/gestureController';
import { GameState } from './gameState';
import { aimHandFrom, fireFromGesture, observedHandFor, scoringHandFor } from './fireDispatch';

const ASPECT = 640 / 480;

function landmarksAt(x: number, y: number): { x: number; y: number }[] {
  const points = Array.from({ length: 21 }, () => ({ x, y }));
  // A plausible hand: wrist below the palm, index tip above it.
  points[Landmark.WRIST] = { x, y: y + 0.2 };
  points[Landmark.INDEX_TIP] = { x, y: y - 0.15 };
  return points;
}

function hand(
  identity: 'left' | 'right',
  x: number,
  y: number,
  overrides: Partial<TrackedHand> = {},
): TrackedHand {
  return {
    identity,
    landmarks: landmarksAt(x, y),
    handedness: { label: identity === 'left' ? 'Left' : 'Right', score: 0.95 },
    palmCenter: { x, y },
    identityMatchScore: 1,
    stalenessMs: 0,
    isStale: false,
    handednessConflicted: false,
    reacquiredAtMs: null,
    ...overrides,
  };
}

function event(identity: 'left' | 'right' = 'right'): GestureEvent {
  return { identity, score: 1, atMs: 0, palmCenter: { x: 0.5, y: 0.5 } };
}

describe('observedHandFor', () => {
  it('finds the observed hand for an event', () => {
    const found = observedHandFor(event('right'), [hand('left', 0.2, 0.5), hand('right', 0.8, 0.5)]);
    expect(found?.identity).toBe('right');
  });

  it('returns null when the identity is absent, rather than throwing', () => {
    // A hand can be lost between the event and the read. That must be a no-shot, not a crash
    // and not a shot from a position nobody observed.
    expect(observedHandFor(event('right'), [hand('left', 0.2, 0.5)])).toBeNull();
    expect(observedHandFor(event('right'), [])).toBeNull();
  });

  it('refuses a coasting hand, which is not an observation (§7.2)', () => {
    const stale = hand('right', 0.8, 0.5, { isStale: true, stalenessMs: 40 });
    expect(observedHandFor(event('right'), [stale])).toBeNull();
  });
});

describe('scoringHandFor (§12.4)', () => {
  it('keys on the reported handedness label, not the tracker slot', () => {
    // The label is what §10.1 calls the primary signal, and it is the only thing that can
    // express "the player switched hands" when one slot is being reused.
    expect(scoringHandFor(hand('left', 0.2, 0.5))).toBe('left');
    expect(scoringHandFor(hand('right', 0.8, 0.5))).toBe('right');
  });

  it('reads the label independently of the slot', () => {
    const mismatched = { ...hand('left', 0.2, 0.5), handedness: { label: 'Right' as const, score: 0.9 } };
    expect(scoringHandFor(mismatched)).toBe('right');
  });
});

describe('aimHandFrom', () => {
  it('uses observed palm, wrist and index tip', () => {
    const aim = aimHandFrom(hand('right', 0.8, 0.5));
    expect(aim.palmCenter).toEqual({ x: 0.8, y: 0.5 });
    expect(aim.wrist).toEqual({ x: 0.8, y: 0.7 });
    expect(aim.indexTip).toEqual({ x: 0.8, y: 0.35 });
  });

  it('falls back to the palm when a landmark is missing, rather than aiming at NaN', () => {
    // An empty landmark list is the real "missing" case: index 0 is absent, so the `??`
    // fallback is what runs.
    const truncated = { ...hand('right', 0.8, 0.5), landmarks: [] };
    const aim = aimHandFrom(truncated);
    expect(aim.wrist).toEqual(aim.palmCenter);
    expect(aim.indexTip).toEqual(aim.palmCenter);
    expect(Number.isFinite(aim.wrist.x)).toBe(true);
  });
});

describe('fireFromGesture — exactly one shot per event', () => {
  /** A game with targets, so a fire can actually land. */
  function game(): GameState {
    return new GameState({ aspect: ASPECT, seed: 1 });
  }

  it('fires exactly once for one camera-originated event', () => {
    // The regression. Before the fix this returned no shot at all on the camera path.
    const g = game();
    const tracked = [hand('right', 0.5, 0.5)];
    const before = g.round.scored + g.round.wrongHandFires + g.misses;

    const outcome = fireFromGesture(event('right'), tracked, g, 0);
    expect(outcome).not.toBeNull();
    expect(g.round.scored + g.round.wrongHandFires + g.misses).toBe(before + 1);
  });

  it('does not fire twice for one event', () => {
    // The other half of "exactly one": the render loop used to have its own event block, so
    // handling events at both the observation site and the render site would double-fire.
    const g = game();
    const tracked = [hand('right', 0.5, 0.5)];
    fireFromGesture(event('right'), tracked, g, 0);

    // One fire recorded as either a score or a wrong-hand attempt — never both.
    expect(g.round.scored + g.round.wrongHandFires).toBe(1);
    expect(g.round.scored).toBeLessThanOrEqual(1);
    expect(g.round.wrongHandFires).toBeLessThanOrEqual(1);
  });

  it('produces no shot when the hand is not observed', () => {
    const g = game();
    const before = { scored: g.round.scored, wrong: g.round.wrongHandFires, misses: g.misses };
    expect(fireFromGesture(event('right'), [], g, 0)).toBeNull();
    expect({ scored: g.round.scored, wrong: g.round.wrongHandFires, misses: g.misses }).toEqual(before);
  });

  it('produces no shot from a coasting hand', () => {
    const g = game();
    const stale = [hand('right', 0.5, 0.5, { isStale: true, stalenessMs: 40 })];
    const before = { scored: g.round.scored, wrong: g.round.wrongHandFires, misses: g.misses };
    expect(fireFromGesture(event('right'), stale, g, 0)).toBeNull();
    expect({ scored: g.round.scored, wrong: g.round.wrongHandFires, misses: g.misses }).toEqual(before);
  });

  it('webs a target when the hand aims at one', () => {
    const g = game();
    const target = g.targets.active()[0]!;
    // Put the hand just behind the target, palm facing it.
    const { x, y } = target.center;
    const tracked = [hand('right', x, y + 0.3)];

    const outcome = fireFromGesture(event('right'), tracked, g, 0);
    expect(outcome?.hit).not.toBeUndefined();
    expect(g.targets.webbed().length + g.misses).toBeGreaterThan(0);
  });

  it('runs the §12.4 alternation rule through the dispatch, not around it', () => {
    const g = game();
    const right = [hand('right', 0.5, 0.5)];
    const left = [hand('left', 0.5, 0.5)];

    const first = fireFromGesture(event('right'), right, g, 0);
    expect(first?.verdict).toBe('scored');
    // The same hand again is a wrong-hand no-op, which must be unchanged by dispatching.
    const second = fireFromGesture(event('right'), right, g, 100);
    expect(second?.verdict).toBe('wrong-hand');
    // The other hand can then score.
    const third = fireFromGesture(event('left'), left, g, 200);
    expect(third?.verdict).toBe('scored');
  });

  it('tracks the hand the player is using when one slot is reused (simulator case)', () => {
    // Both events arrive on the same tracker slot, as the simulator's `H` toggle produces,
    // but the reported labels differ. Alternation must follow the labels.
    const g = game();
    const switched = {
      ...hand('right', 0.5, 0.5),
      handedness: { label: 'Left' as const, score: 0.95 },
    };

    expect(fireFromGesture(event('right'), [hand('right', 0.5, 0.5)], g, 0)?.verdict).toBe('scored');
    // Same slot, label now Left: the round must accept it as the other hand.
    expect(fireFromGesture(event('right'), [switched], g, 100)?.verdict).toBe('scored');
  });
});
