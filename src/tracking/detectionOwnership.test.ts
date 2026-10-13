/**
 * Unit tests for detection ownership (PLAN.md §7.3).
 *
 * Requested by review on PR #12. The race only exists when a detection **completes after** the
 * source changed, which no test that runs the two in order can reproduce — so the predicate is
 * named and these simulate the deferral explicitly.
 *
 * The third-pass review added a sharper case: comparing source **object identity** is not enough,
 * because `selectSource('camera')` resolves to the *same* `camera.source` instance, so a
 * camera → mouse → camera switch (A → B → A) looks unchanged to a detection started before it. The
 * tests below model that with a real generation counter rather than substituting a different
 * object, which is what the earlier version did — and which therefore never reproduced the bug.
 */

import { describe, expect, it } from 'vitest';

import { shouldApplyDetection } from './detectionOwnership';

/** Stand-ins with identity, which is what the session comparison uses. */
const cameraSession = { id: 'camera-session' };
const cameraSource = { id: 'camera-source' };

/**
 * A minimal model of `selectSource`'s bookkeeping.
 *
 * It exists so the A → B → A case can be expressed honestly: selecting the camera again returns the
 * *same* source object while still bumping the generation, exactly as `main.ts` does.
 */
class Selection {
  generation = 0;
  active: object;

  constructor(initial: object) {
    this.active = initial;
  }

  /** Mirrors `selectSource`: a no-op when the source is already active, otherwise a bump. */
  select(next: object): void {
    if (next === this.active) return;
    this.active = next;
    this.generation += 1;
  }
}

const mouse = { id: 'mouse-source' };
const replay = { id: 'replay-source' };

describe('shouldApplyDetection', () => {
  it('applies a detection that belongs to the live session and an unchanged selection', () => {
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSourceGeneration: 0,
        liveSourceGeneration: 0,
      }),
    ).toBe(true);
  });

  it('drops a detection whose session was torn down', () => {
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: null,
        startedForSourceGeneration: 0,
        liveSourceGeneration: 0,
      }),
    ).toBe(false);
  });

  it('drops a detection whose session was replaced by a new one', () => {
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: { id: 'camera-session-2' },
        startedForSourceGeneration: 0,
        liveSourceGeneration: 0,
      }),
    ).toBe(false);
  });

  it('drops a deferred result when the player switched to the simulator', () => {
    const selection = new Selection(cameraSource);
    const startedForSourceGeneration = selection.generation;
    selection.select(mouse);

    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSourceGeneration,
        liveSourceGeneration: selection.generation,
      }),
    ).toBe(false);
  });

  it('drops a deferred result when the player switched to replay', () => {
    const selection = new Selection(cameraSource);
    const startedForSourceGeneration = selection.generation;
    selection.select(replay);

    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSourceGeneration,
        liveSourceGeneration: selection.generation,
      }),
    ).toBe(false);
  });

  it('drops a deferred result across an A → B → A switch back to the camera', () => {
    // The third-pass finding, and the case object identity cannot see: selecting the camera again
    // resolves to the **same** `camera.source` instance, so a detection started before the switch
    // would find `liveSource === startedForSource` and be applied.
    const selection = new Selection(cameraSource);
    const startedForSourceGeneration = selection.generation;

    selection.select(mouse);
    selection.select(cameraSource); // back to the very same object

    expect(selection.active).toBe(cameraSource);
    expect(selection.generation).toBe(2);
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSourceGeneration,
        liveSourceGeneration: selection.generation,
      }),
    ).toBe(false);
  });

  it('drops it even after several round trips', () => {
    const selection = new Selection(cameraSource);
    const startedForSourceGeneration = selection.generation;
    selection.select(mouse);
    selection.select(cameraSource);
    selection.select(replay);
    selection.select(mouse);
    selection.select(cameraSource);

    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSourceGeneration,
        liveSourceGeneration: selection.generation,
      }),
    ).toBe(false);
  });

  it('does not bump the generation when the same source is re-selected', () => {
    // `selectSource` returns early when the next source is already active, so an idle re-press must
    // not invalidate a detection — otherwise pressing `1` twice would silently drop a live result.
    const selection = new Selection(mouse);
    const before = selection.generation;
    selection.select(mouse);
    expect(selection.generation).toBe(before);

    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSourceGeneration: before,
        liveSourceGeneration: selection.generation,
      }),
    ).toBe(true);
  });

  it('models the un-raced sequence, which must still apply', () => {
    // The guard must not break the ordinary case: nothing changed while the detection ran.
    expect(
      shouldApplyDetection({
        startedForSession: cameraSession,
        liveSession: cameraSession,
        startedForSourceGeneration: 7,
        liveSourceGeneration: 7,
      }),
    ).toBe(true);
  });
});
