/**
 * Ownership of an in-flight detection (PLAN.md §7.3).
 *
 * The inference loop is asynchronous: `detectNow()` is awaited, and a lot can change while it is
 * outstanding. Two things make a completed detection irrelevant, and both used to be missed:
 *
 * 1. **The session was torn down** — the camera stopped, the model released. Applying the result
 *    would resurrect a hand from a session that no longer exists.
 * 2. **The source was switched** — pressing `1` or `2` calls `selectSource`, which stops the camera
 *    source but deliberately leaves the session and its frame clock alive so switching back is
 *    cheap. `detectNow` checks `started` *before* awaiting the backend, so a request already in
 *    flight still resolves successfully. Applying its gesture would fire a camera shot while the
 *    simulator is the active source — a shot from a source the player had left.
 *
 * Kept as a named predicate rather than an inline `if` so the deferred-result case can be tested
 * directly: the race is invisible to any test that cannot finish a detection *after* a switch.
 *
 * Typed on `object` rather than the concrete session and source types to avoid importing the
 * bootstrap module, which would be a cycle. Identity comparison is all this needs.
 */

export interface DetectionOwnership {
  /** The session the detection was started against. */
  readonly startedForSession: object;
  /** The live camera session at completion time, or `null` if it was torn down. */
  readonly liveSession: object | null;
  /** The source that was active when the detection started. */
  readonly startedForSource: object;
  /** The source that is active now. */
  readonly liveSource: object;
}

/**
 * True when a completed detection still belongs to the live camera session and the active source.
 *
 * `false` means drop the result: it describes a hand from a session or a source that is no longer
 * in charge.
 */
export function shouldApplyDetection(ownership: DetectionOwnership): boolean {
  return (
    ownership.liveSession === ownership.startedForSession &&
    ownership.liveSource === ownership.startedForSource
  );
}
