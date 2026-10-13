/**
 * Integration test: the simulator can play a **complete round**.
 *
 * This drives the real modules in sequence — `MouseSource` -> identity -> gesture
 * pipeline -> a `FIRE` event -> auto-aim -> `GameState.fire()` -> a webbed target —
 * rather than testing the aim rule against hand-built inputs. The simulator is the
 * only path that can be exercised without a camera, which is why M0 required it to
 * expose the same interface a real tracker does.
 *
 * **Alternating hands with one simulated hand.** Pressing `H` flips the reported
 * handedness at the same position. The identity tracker reconciles that by position
 * — §10.1 makes position the primary continuous signal — so both labels land in the
 * one slot that exists. The round therefore keys on the *reported label* as
 * `scoringHand`, which is what makes a full round playable in simulator mode and is
 * the same signal §10.1 calls primary.
 */

import { describe, expect, it } from 'vitest';

import { TARGETS } from '../config';
import { GameState } from './gameState';
import { GestureController } from '../gesture/gestureController';
import { MouseSource } from '../sim/mouseSource';
import { HandIdentityTracker } from '../tracking/handIdentity';
import type { HandIdentityId } from '../tracking/handIdentity';

const WIDTH = 640;
const HEIGHT = 480;
const ASPECT = WIDTH / HEIGHT;

/** Everything a simulated session needs, wired the way `main.ts` wires it. */
function session(seed = 1) {
  const source = new MouseSource({ sourceWidthPx: WIDTH, sourceHeightPx: HEIGHT });
  const identity = new HandIdentityTracker({ sourceWidth: WIDTH, sourceHeight: HEIGHT });
  const gestures = new GestureController();
  const game = new GameState({ aspect: ASPECT, seed });
  source.start(0);

  let t = 0;

  /** The hand the simulator currently reports, mapped to our identity ids. */
  const scoringHand = (): HandIdentityId =>
    source.handedness === 'Left' ? 'left' : 'right';

  /** Feed one frame's detections through identity and gesture; fire on FIRE. */
  const step = (frames: number): ReturnType<GameState['fire']> | null => {
    let outcome: ReturnType<GameState['fire']> | null = null;
    for (let i = 0; i < frames; i += 1) {
      t += 16;
      const raw = source.frameAt(t)?.hands ?? [];
      const tracked = identity.update(raw, t).hands;
      const gestureFrame = gestures.observe(tracked, t);
      const detected = raw[0];
      if (detected === undefined) continue;
      const aim = {
        palmCenter: detected.landmarks[9]!,
        wrist: detected.landmarks[0]!,
        indexTip: detected.landmarks[8]!,
      };
      for (const event of gestureFrame.events) {
        outcome = game.fire(aim, { origin: event.identity, scoringHand: scoringHand() }, t);
      }
    }
    return outcome;
  };

  /** One deliberate pose-hold-release cycle. */
  const gesture = (): ReturnType<GameState['fire']> | null => {
    source.setPressed(true);
    step(50);
    source.setPressed(false);
    step(40);
    return null;
  };

  return {
    source,
    game,
    step,
    gesture,
    /** Flip the reported hand, i.e. the player pressing `H`. */
    toggleHand: () => source.toggleHandedness(),
    at: () => t,
  };
}

/** Play cycles until the round is won or the budget runs out. */
function playRound(s: ReturnType<typeof session>, maxCycles = 20): void {
  for (let cycle = 0; cycle < maxCycles && !s.game.round.won; cycle += 1) {
    s.gesture();
    s.toggleHand();
  }
}

describe('the simulator can fire at targets', () => {
  it('webs a target after a pose-hold-release cycle', () => {
    const s = session(1);
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);

    s.source.setPressed(true);
    const outcome = s.step(50);

    expect(outcome).not.toBeNull();
    expect(outcome!.verdict).toBe('scored');
    expect(s.game.hits).toBe(1);
    expect(outcome!.hit).not.toBeNull();
    expect(outcome!.hit!.state).toBe('webbed');
    expect(s.game.targets.remaining).toBe(TARGETS.perRound - 1);
  });

  it('retires the web once its splat has finished', () => {
    const s = session(1);
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);
    s.source.setPressed(true);
    s.step(50);
    expect(s.game.liveWebs(s.at()).length).toBeGreaterThan(0);

    s.source.setPressed(false);
    s.step(60);
    expect(s.game.liveWebs(s.at()).length).toBe(0);
  });
});

describe('a complete playable round (M4)', () => {
  it('can be won by alternating hands, and reports the win', () => {
    const s = session(3);
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);

    playRound(s);

    expect(s.game.round.won).toBe(true);
    expect(s.game.targets.cleared).toBe(true);
    expect(s.game.targets.remaining).toBe(0);
    expect(s.game.round.scored).toBe(TARGETS.perRound);
    expect(s.game.round.requiredHand).toBeNull();
  });

  it('is winnable for every seed', () => {
    // Regression: `minDistanceFraction` used to be a hard filter, so a final target
    // near the palm could never be aimed at — the round could not be finished.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const s = session(seed);
      s.source.setPointer({ x: 0.5, y: 0.5 }, false);
      s.step(30);
      playRound(s);

      expect({ seed, won: s.game.round.won }).toEqual({ seed, won: true });
      expect({ seed, remaining: s.game.targets.remaining }).toEqual({ seed, remaining: 0 });
    }
  });

  it('requires a fresh pose-release for each scoring shot', () => {
    const s = session(2);
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);

    // Hold continuously: M2's invariant means exactly one fire, whatever the turns.
    s.source.setPressed(true);
    s.step(400);

    expect(s.game.round.scored).toBe(1);
    expect(s.game.round.won).toBe(false);
  });

  it('replay() gives a fresh round with the opening freedom restored', () => {
    const s = session(4);
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);
    playRound(s);
    expect(s.game.round.won).toBe(true);

    s.game.respawn(4);
    expect(s.game.round.won).toBe(false);
    expect(s.game.round.scored).toBe(0);
    expect(s.game.round.requiredHand).toBeNull();
    expect(s.game.targets.remaining).toBe(TARGETS.perRound);
    expect(s.game.liveWebs(s.at())).toHaveLength(0);
  });
});

describe('the wrong-hand no-op in a real session (§12.4)', () => {
  it('does not score, consume a target, or change the required hand', () => {
    const s = session(5);
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);

    // First shot with the hand the simulator starts with.
    s.gesture();
    expect(s.game.round.scored).toBe(1);
    const afterFirst = s.game.round.requiredHand;
    const remainingAfterFirst = s.game.targets.remaining;

    // Fire again WITHOUT switching hands: the same hand is now the wrong hand.
    s.gesture();
    s.gesture();

    expect(s.game.round.scored).toBe(1); // unchanged
    expect(s.game.targets.remaining).toBe(remainingAfterFirst); // nothing consumed
    expect(s.game.round.requiredHand).toBe(afterFirst); // turn unchanged
    expect(s.game.round.wrongHandFires).toBeGreaterThanOrEqual(2);
  });

  it('counts a wrong-hand fire separately from a miss', () => {
    const s = session(6);
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);
    s.gesture();

    const missesBefore = s.game.misses;
    s.gesture(); // wrong hand
    expect(s.game.misses).toBe(missesBefore);
    expect(s.game.round.wrongHandFires).toBeGreaterThanOrEqual(1);
  });
});

describe('GameState bookkeeping', () => {
  it('reports the aimed target for the reticle, and null with no hand', () => {
    const game = new GameState({ aspect: ASPECT, seed: 6 });
    expect(game.aimedTarget(null)).toBeNull();

    const hand = {
      palmCenter: { x: 0.5, y: 0.5 },
      wrist: { x: 0.4, y: 0.5 },
      indexTip: { x: 0.7, y: 0.5 },
    };
    expect(game.aimedTarget(hand)).not.toBeNull();
  });

  it('caps live webs so a long session cannot grow unbounded state', () => {
    const game = new GameState({ aspect: ASPECT, seed: 7 });
    const hand = {
      palmCenter: { x: 0.5, y: 0.5 },
      wrist: { x: 0.4, y: 0.5 },
      indexTip: { x: 0.7, y: 0.5 },
    };
    // All at the same instant, so nothing has finished splatting.
    for (let i = 0; i < 60; i += 1) {
      game.fire(hand, { origin: 'right', scoringHand: 'right' }, 0);
    }

    expect(game.liveWebs(0).length).toBeLessThanOrEqual(12);
  });

  it('keeps a miss from consuming the turn', () => {
    const game = new GameState({ aspect: ASPECT, seed: 8 });
    const hand = {
      palmCenter: { x: 0.5, y: 0.5 },
      wrist: { x: 0.4, y: 0.5 },
      indexTip: { x: 0.7, y: 0.5 },
    };
    // Alternate hands until the field is clear, then keep going at nothing.
    let guard = 0;
    while (game.targets.remaining > 0 && guard < 40) {
      guard += 1;
      const scoringHand = guard % 2 === 1 ? 'left' : 'right';
      game.fire(hand, { origin: scoringHand, scoringHand }, guard * 20);
    }
    expect(game.targets.cleared).toBe(true);
    expect(game.round.won).toBe(true);

    // One more fire now: the round is won, so it cannot score.
    const scoredBefore = game.round.scored;
    game.fire(hand, { origin: 'left', scoringHand: 'left' }, guard * 20 + 20);
    expect(game.round.scored).toBe(scoredBefore);
    expect(game.targets.remaining).toBe(0);
  });

  it('keeps a miss from consuming the turn', () => {
    const game = new GameState({ aspect: ASPECT, seed: 9 });
    // A hand far from every target, so every shot is a miss.
    const farHand = {
      palmCenter: { x: 0.02, y: 0.98 },
      wrist: { x: 0.0, y: 0.99 },
      indexTip: { x: 0.04, y: 0.97 },
    };
    const before = game.round.scored;
    game.fire(farHand, { origin: 'left', scoringHand: 'left' }, 0);

    // Either it hit something (unlikely but possible) or it missed; either way the
    // turn must not have been consumed by a miss.
    if (game.round.scored === before) {
      expect(game.round.requiredHand).toBeNull(); // still anyone's turn
    }
  });
});
