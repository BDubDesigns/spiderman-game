/**
 * Integration test for M3's central claim: **the simulator can fire at targets**.
 *
 * The M3 requirement is that simulator mode can demonstrably hit targets, so this
 * drives the real modules in sequence — `MouseSource` -> identity -> gesture
 * pipeline -> a `FIRE` event -> auto-aim -> `GameState.fire()` -> a webbed target —
 * rather than testing the aim rule against hand-built inputs.
 *
 * The simulator is the only path that can be exercised without a camera, which is
 * why M0 required it to expose the same interface a real tracker does.
 */

import { describe, expect, it } from 'vitest';

import { TARGETS } from '../config';
import { GameState } from './gameState';
import { GestureController } from '../gesture/gestureController';
import { MouseSource } from '../sim/mouseSource';
import { HandIdentityTracker } from '../tracking/handIdentity';
import type { NormalizedPoint } from '../tracking/landmarkTypes';

const WIDTH = 640;
const HEIGHT = 480;
const ASPECT = WIDTH / HEIGHT;

/** Everything a simulated session needs, wired the same way `main.ts` wires it. */
function session(seed = 1) {
  const source = new MouseSource({ sourceWidthPx: WIDTH, sourceHeightPx: HEIGHT });
  const identity = new HandIdentityTracker({ sourceWidth: WIDTH, sourceHeight: HEIGHT });
  const gestures = new GestureController();
  const game = new GameState({ aspect: ASPECT, seed });
  source.start(0);

  let t = 0;
  const hand = (): { aim: { palmCenter: NormalizedPoint; wrist: NormalizedPoint; indexTip: NormalizedPoint } } | null => {
    const frame = source.frameAt(t);
    const raw = frame?.hands[0];
    if (!raw) return null;
    // `MouseSource` emits the gesture pose at curl 1; the palm and wrist come
    // straight from the landmarks the same way `handIdentity` computes them.
    return {
      aim: {
        palmCenter: raw.landmarks[9]!,
        wrist: raw.landmarks[0]!,
        indexTip: raw.landmarks[8]!,
      },
    };
  };

  /** Advance one frame; returns the fire outcome if a gesture fired. */
  const step = (frames: number): ReturnType<GameState['fire']> | null => {
    let outcome: ReturnType<GameState['fire']> | null = null;
    for (let i = 0; i < frames; i += 1) {
      t += 16;
      const raw = source.frameAt(t)?.hands ?? [];
      const tracked = identity.update(raw, t).hands;
      const gestureFrame = gestures.update(tracked, t);
      const current = hand();
      for (const event of gestureFrame.events) {
        if (current === null) continue;
        outcome = game.fire(current.aim, event.identity, t, true);
      }
    }
    return outcome;
  };

  return { source, game, step, at: () => t };
}

describe('the simulator can fire at targets (M3)', () => {
  it('webs a target after a pose-hold-release cycle', () => {
    const s = session(1);
    // Open hand to settle.
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);

    // Pose and hold long enough to fire.
    s.source.setPressed(true);
    const outcome = s.step(50);

    expect(outcome).not.toBeNull();
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

    // Give it the travel plus splat duration, then one more frame.
    s.source.setPressed(false);
    s.step(60);
    expect(s.game.liveWebs(s.at()).length).toBe(0);
  });

  it('can clear the whole field with repeated pose-release cycles', () => {
    const s = session(3);
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);

    for (let cycle = 0; cycle < TARGETS.perRound; cycle += 1) {
      s.source.setPressed(true);
      s.step(50);
      s.source.setPressed(false);
      s.step(40);
    }

    expect(s.game.targets.cleared).toBe(true);
    expect(s.game.targets.remaining).toBe(0);
    expect(s.game.hits).toBe(TARGETS.perRound);
  });

  it('records a miss rather than throwing when nothing is left to hit', () => {
    const s = session(2);
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);

    // Clear everything first.
    for (let cycle = 0; cycle < TARGETS.perRound; cycle += 1) {
      s.source.setPressed(true);
      s.step(50);
      s.source.setPressed(false);
      s.step(40);
    }
    expect(s.game.targets.cleared).toBe(true);

    // One more fire: no active target remains.
    s.source.setPressed(true);
    const outcome = s.step(50);

    expect(outcome).not.toBeNull();
    expect(outcome!.hadTarget).toBe(false);
    expect(outcome!.hit).toBeNull();
    expect(s.game.misses).toBe(1);
    // A miss still creates a web — a child firing at nothing sees a web.
    expect(outcome!.web.targetId).toBeNull();
  });

  it('never webs the same target twice', () => {
    const s = session(4);
    s.source.setPointer({ x: 0.5, y: 0.5 }, false);
    s.step(30);

    for (let cycle = 0; cycle < TARGETS.perRound + 4; cycle += 1) {
      s.source.setPressed(true);
      s.step(50);
      s.source.setPressed(false);
      s.step(40);
    }

    const webbed = s.game.targets.webbed();
    expect(webbed).toHaveLength(TARGETS.perRound);
    expect(s.game.hits).toBe(TARGETS.perRound);
    expect(s.game.targets.cleared).toBe(true);
  });

  it('can clear the field for every seed, with no unreachable last target', () => {
    // Regression: `minDistanceFraction` used to be a hard filter, so a final target
    // sitting near the palm could never be aimed at — the round could not be
    // finished. It is a preference now, and this sweep is what caught that.
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const s = session(seed);
      s.source.setPointer({ x: 0.5, y: 0.5 }, false);
      s.step(30);

      for (let cycle = 0; cycle < TARGETS.perRound; cycle += 1) {
        s.source.setPressed(true);
        s.step(50);
        s.source.setPressed(false);
        s.step(40);
      }

      expect({ seed, remaining: s.game.targets.remaining }).toEqual({ seed, remaining: 0 });
      expect({ seed, misses: s.game.misses }).toEqual({ seed, misses: 0 });
    }
  });
});

describe('GameState aim and web bookkeeping', () => {
  it('respawn resets targets, webs and counters', () => {
    const game = new GameState({ aspect: ASPECT, seed: 5 });
    const hand = {
      palmCenter: { x: 0.5, y: 0.5 },
      wrist: { x: 0.4, y: 0.5 },
      indexTip: { x: 0.7, y: 0.5 },
    };
    game.fire(hand, 'right', 0, true);
    expect(game.targets.webbed().length + game.misses).toBeGreaterThan(0);

    game.respawn(5);
    expect(game.liveWebs(0)).toHaveLength(0);
    expect(game.hits).toBe(0);
    expect(game.misses).toBe(0);
    expect(game.targets.remaining).toBe(TARGETS.perRound);
  });

  it('reports the aimed target for the reticle, and null with no hand', () => {
    const game = new GameState({ aspect: ASPECT, seed: 6 });
    expect(game.aimedTarget(null)).toBeNull();

    const hand = {
      palmCenter: { x: 0.5, y: 0.5 },
      wrist: { x: 0.4, y: 0.5 },
      indexTip: { x: 0.7, y: 0.5 },
    };
    // With targets on the field, something should be in range.
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
    for (let i = 0; i < 60; i += 1) game.fire(hand, 'right', 0, true);

    expect(game.liveWebs(0).length).toBeLessThanOrEqual(12);
  });
});
