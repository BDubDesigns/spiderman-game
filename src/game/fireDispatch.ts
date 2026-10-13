/**
 * Turning a gesture `FIRE` into a shot (PLAN.md §12.1, §12.4).
 *
 * Extracted so there is **one** event-to-shot path rather than one per input source.
 * That matters because there are genuinely two places a `FIRE` can arrive — the camera
 * observation callback and the simulator/replay render path — and duplicating the logic
 * between them produced a real bug the first time: the camera's events were consumed by
 * counters only, so the camera could register a gesture and never shoot a web.
 *
 * Having a single function also makes the seam testable without a DOM, which is the point
 * of the accompanying test file: the synthetic cadence test proves the *controller* is
 * driven correctly, but it says nothing about whether an event ever reaches the game.
 *
 * Only **observed** positions aim. §7.2 keeps interpolated and coasting positions out of
 * anything that decides gameplay, and aiming decides a hit.
 */

import { Landmark } from '../tracking/landmarkTypes';
import type { HandIdentityId, TrackedHand } from '../tracking/handIdentity';
import type { GestureEvent } from '../gesture/gestureController';
import type { AimHand } from './autoAim';
import type { FireOutcome, GameState } from './gameState';

/** The hand a `FIRE` came from, if it is a fresh observation. */
export function observedHandFor(
  event: GestureEvent,
  tracked: readonly TrackedHand[],
): TrackedHand | null {
  const source = tracked.find((candidate) => candidate.identity === event.identity);
  if (source === undefined || source.isStale) return null;
  return source;
}

/**
 * The hand the §12.4 alternation rule should count for this event.
 *
 * Keyed on the reported handedness label rather than the tracker slot. §10.1 names the
 * label the primary signal, and the slot is position-driven — so the simulator's `H`
 * toggle reconciles into a single slot and could not express "the player switched hands".
 */
export function scoringHandFor(source: TrackedHand): HandIdentityId {
  return source.handedness.label === 'Left' ? 'left' : 'right';
}

/** Aim inputs taken from an observed hand. */
export function aimHandFrom(source: TrackedHand): AimHand {
  return {
    palmCenter: source.palmCenter,
    wrist: source.landmarks[Landmark.WRIST] ?? source.palmCenter,
    indexTip: source.landmarks[Landmark.INDEX_TIP] ?? source.palmCenter,
  };
}

/**
 * Resolve one `FIRE` into at most one shot.
 *
 * Returns `null` when there is no fresh observation for the event's identity — which can
 * legitimately happen when a hand is lost between the event and the read, and must not
 * throw or shoot from a stale position.
 */
export function fireFromGesture(
  event: GestureEvent,
  tracked: readonly TrackedHand[],
  game: GameState,
  nowMs: number,
): FireOutcome | null {
  const source = observedHandFor(event, tracked);
  if (source === null) return null;

  return game.fire(
    aimHandFrom(source),
    { origin: event.identity, scoringHand: scoringHandFor(source) },
    nowMs,
  );
}
