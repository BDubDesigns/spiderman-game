/**
 * Ownership of an in-flight detection (PLAN.md §7.3).
 *
 * The inference loop is asynchronous: `detectNow()` is awaited, and a lot can change while it is
 * outstanding. Two things make a completed detection irrelevant, and both used to be missed:
 *
 * 1. **The session was torn down** — the camera stopped, the model released. Applying the result
 *    would resurrect a hand from a session that no longer exists.
 * 2. **The source selection changed** — pressing `1` or `2` calls `selectSource`, which stops the
 *    camera source but deliberately leaves the session and its frame clock alive so switching back
 *    is cheap. `detectNow` checks `started` *before* awaiting the backend, so a request already in
 *    flight still resolves successfully. Applying its gesture would fire a camera shot while the
 *    simulator is the active source.
 *
 * ---- Why a generation token and not object identity ----
 *
 * Comparing **source object identity** is not sufficient, because a switch can return to the same
 * object: `selectSource('camera')` resolves to `camera?.source`, so `camera → mouse → camera`
 * (A → B → A) ends with `liveSource === startedForSource` and a pre-switch inference would be
 * applied as though nothing had happened.
 *
 * A monotonic **selection generation**, bumped on every actual source change, closes that: the
 * A → B → A sequence moves the generation 1 → 2 → 3, so a detection started at generation 1 is
 * dropped no matter which object is live now.
 *
 * Kept as a named predicate rather than an inline `if` so the deferred-result cases can be tested
 * directly — a race that only exists when a detection completes *after* a switch is invisible to
 * any test that runs the two in order.
 *
 * Typed on `object` and `number` rather than the concrete session type to avoid importing the
 * bootstrap module, which would be a cycle. Identity comparison is all the session needs.
 */

export interface DetectionOwnership {
  /** The session the detection was started against. */
  readonly startedForSession: object;
  /** The live camera session at completion time, or `null` if it was torn down. */
  readonly liveSession: object | null;
  /** The source selection generation when the detection started. */
  readonly startedForSourceGeneration: number;
  /** The source selection generation now. */
  readonly liveSourceGeneration: number;
}

/**
 * True when a completed detection still belongs to the live camera session and an unchanged source
 * selection.
 *
 * `false` means drop the result: it describes a hand from a session or a selection that is no longer
 * in charge.
 */
export function shouldApplyDetection(ownership: DetectionOwnership): boolean {
  return (
    ownership.liveSession === ownership.startedForSession &&
    ownership.liveSourceGeneration === ownership.startedForSourceGeneration
  );
}
