/**
 * Unit tests for the per-identity gesture state machine (PLAN.md §11.7, §11.8).
 *
 * Covers the M2 `[A]` criterion: "Unit tests for the state machine:
 * release-to-rearm, no-fire-while-held, rearm-block-on-reacquisition".
 *
 * The invariant under test is that **a FIRE requires a fresh arming edge**.
 */

import { describe, expect, it } from 'vitest';

import { GESTURE } from '../config';
import { GestureStateMachine } from './gestureStateMachine';

const HOLD = GESTURE.holdMs;
const COOLDOWN = GESTURE.cooldownMs;
const REARM = GESTURE.rearmMs;
const GOOD = GESTURE.minGestureScore + 0.3;
const WEAK = GESTURE.minGestureScore - 0.1;

/** Count how many `fired` edges occur across a timeline of (held, score, t) steps. */
function firesOver(
  machine: GestureStateMachine,
  steps: readonly [boolean, number, number][],
): number {
  let fires = 0;
  for (const [held, score, t] of steps) {
    if (machine.update(held, score, t).fired) fires += 1;
  }
  return fires;
}

describe('GestureStateMachine arming and firing (§11.7)', () => {
  it('fires once the gesture is held for HOLD_MS', () => {
    const m = new GestureStateMachine();
    expect(m.update(true, GOOD, 0).state).toBe('armed');
    expect(m.update(true, GOOD, HOLD - 1).fired).toBe(false);
    const fired = m.update(true, GOOD, HOLD);
    expect(fired.fired).toBe(true);
    expect(fired.state).toBe('cooldown');
  });

  it('does not arm on a pose that is not the gesture', () => {
    const m = new GestureStateMachine();
    expect(m.update(false, GOOD, 0).state).toBe('idle');
    expect(m.update(false, GOOD, HOLD + 100).fired).toBe(false);
  });

  it('does not arm when the score is below the minimum', () => {
    const m = new GestureStateMachine();
    expect(m.update(true, WEAK, 0).state).toBe('idle');
    expect(m.update(true, WEAK, HOLD + 100).fired).toBe(false);
  });

  it('returns to idle without firing if the pose is lost before HOLD_MS', () => {
    const m = new GestureStateMachine();
    m.update(true, GOOD, 0);
    expect(m.update(false, GOOD, HOLD - 1).state).toBe('idle');
    // Re-arming must start the hold again from scratch.
    expect(m.update(true, GOOD, HOLD + 1).state).toBe('armed');
    expect(m.update(true, GOOD, HOLD + 1 + HOLD - 1).fired).toBe(false);
  });
});

describe('GestureStateMachine release-to-rearm (§11.7 invariant)', () => {
  it('never re-fires while the gesture stays held', () => {
    const m = new GestureStateMachine();
    // 20 seconds of continuously holding the pose, sampled every 20 ms.
    const steps: [boolean, number, number][] = [];
    for (let t = 0; t <= 20_000; t += 20) steps.push([true, GOOD, t]);

    expect(firesOver(m, steps)).toBe(1);
  });

  it('enters HELD once the cooldown expires while still held, and stays there', () => {
    const m = new GestureStateMachine();
    m.update(true, GOOD, 0);
    m.update(true, GOOD, HOLD);
    expect(m.update(true, GOOD, HOLD + COOLDOWN).state).toBe('held');
    expect(m.update(true, GOOD, HOLD + COOLDOWN * 4).state).toBe('held');
    expect(m.update(true, GOOD, HOLD + COOLDOWN * 4).suppressedByHold).toBe(true);
  });

  it('fires again after a release and a fresh arming edge', () => {
    const m = new GestureStateMachine();
    m.update(true, GOOD, 0);
    m.update(true, GOOD, HOLD);

    // Release, then re-pose. This is the only route back to firing.
    const releaseAt = HOLD + COOLDOWN + 10;
    m.update(false, GOOD, releaseAt);
    expect(m.update(true, GOOD, releaseAt + 20).state).toBe('armed');
    expect(m.update(true, GOOD, releaseAt + 20 + HOLD).fired).toBe(true);
  });

  it('counts exactly two fires for two deliberate pose-release cycles', () => {
    const m = new GestureStateMachine();
    const steps: [boolean, number, number][] = [];
    let t = 0;
    for (let cycle = 0; cycle < 2; cycle += 1) {
      // Hold long enough to fire and to reach HELD.
      for (let i = 0; i < 60; i += 1) steps.push([true, GOOD, (t += 20)]);
      // Release long enough to return to idle, clearing the cooldown too.
      for (let i = 0; i < 60; i += 1) steps.push([false, GOOD, (t += 20)]);
    }
    expect(firesOver(m, steps)).toBe(2);
  });
});

describe('GestureStateMachine cooldown', () => {
  it('does not allow an immediate re-fire inside the cooldown window', () => {
    const m = new GestureStateMachine();
    m.update(true, GOOD, 0);
    m.update(true, GOOD, HOLD);

    // Release and re-pose immediately — well inside COOLDOWN_MS.
    m.update(false, GOOD, HOLD + 10);
    const early = m.update(true, GOOD, HOLD + 20);
    expect(early.state).toBe('idle');
    expect(m.update(true, GOOD, HOLD + 20 + HOLD + 10).fired).toBe(false);
  });

  it('allows a re-fire once the cooldown has elapsed', () => {
    const m = new GestureStateMachine();
    m.update(true, GOOD, 0);
    m.update(true, GOOD, HOLD);

    const afterCooldown = HOLD + COOLDOWN + 5;
    m.update(false, GOOD, afterCooldown - 5);
    expect(m.update(true, GOOD, afterCooldown).state).toBe('armed');
    expect(m.update(true, GOOD, afterCooldown + HOLD).fired).toBe(true);
  });

  it('reports the remaining cooldown time for the HUD', () => {
    const m = new GestureStateMachine();
    m.update(true, GOOD, 0);
    const fired = m.update(true, GOOD, HOLD);
    expect(fired.cooldownRemainingMs).toBeCloseTo(COOLDOWN, 6);
    expect(m.update(false, GOOD, HOLD + COOLDOWN / 2).cooldownRemainingMs).toBeCloseTo(
      COOLDOWN / 2,
      6,
    );
  });
});

describe('GestureStateMachine reacquisition protection (§11.8)', () => {
  it('does not fire while the rearm block is in force, even in pose', () => {
    const m = new GestureStateMachine();
    m.blockRearm();

    const steps: [boolean, number, number][] = [];
    for (let t = 0; t <= 3_000; t += 20) steps.push([true, GOOD, t]);

    expect(firesOver(m, steps)).toBe(0);
    expect(m.currentState).toBe('idle');
  });

  it('arms once the hand has been observed released for REARM_MS', () => {
    const m = new GestureStateMachine();
    m.blockRearm();

    expect(m.update(false, GOOD, 0).rearmBlocked).toBe(true);
    expect(m.update(false, GOOD, REARM - 1).rearmBlocked).toBe(true);
    // The block lifts exactly at REARM_MS of continuous release.
    expect(m.update(false, GOOD, REARM).rearmBlocked).toBe(false);

    // Only now can a fresh arming edge begin.
    expect(m.update(true, GOOD, REARM + 20).state).toBe('armed');
    expect(m.update(true, GOOD, REARM + 20 + HOLD).fired).toBe(true);
  });

  it('restarts the release window if the pose appears mid-block', () => {
    const m = new GestureStateMachine();
    m.blockRearm();

    m.update(false, GOOD, 0);
    m.update(false, GOOD, REARM - 1);
    // Pose reappears, so the "observed released" window is not satisfied.
    expect(m.update(true, GOOD, REARM).rearmBlocked).toBe(true);

    // A continuous release from REARM onwards does satisfy it.
    m.update(false, GOOD, REARM + 10);
    expect(m.update(false, GOOD, REARM + 10 + REARM).rearmBlocked).toBe(false);
  });

  it('reset() on identity loss clears the machine and the rearm block', () => {
    const m = new GestureStateMachine();
    m.update(true, GOOD, 0);
    m.blockRearm();
    expect(m.isRearmBlocked).toBe(true);

    m.reset();
    expect(m.isRearmBlocked).toBe(false);
    expect(m.currentState).toBe('idle');
  });

  it('does not carry a held pose across a loss', () => {
    const m = new GestureStateMachine();
    // Fire, then lose the identity mid-hold and reacquire in pose.
    m.update(true, GOOD, 0);
    m.update(true, GOOD, HOLD);
    m.reset();
    m.blockRearm();

    const steps: [boolean, number, number][] = [];
    for (let t = HOLD; t <= HOLD + 3_000; t += 20) steps.push([true, GOOD, t]);
    expect(firesOver(m, steps)).toBe(0);
  });
});
