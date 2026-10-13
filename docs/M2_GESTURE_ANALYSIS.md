# M2 — Iconic gesture: analysis of the real device captures

**Status: no classifier change is justified by this data. A follow-up recording is required.**

This is a measurement record, in the style of `docs/COST_LOG.md` and
`docs/M1_WORKER_DECISION.md`. Every number below was computed from the unaltered device
captures now committed as `fixtures/device-gesture-captures.json` (70 hand observations from a
Pixel 10 Pro XL). Nothing here is estimated.

## What was recorded

| Capture | Take | Player label | Ground truth used | Observations |
|---|---|---|---|---|
| 1 | 1 | `wrist-away-gesture` | positive | 7 |
| 2 | 1 | `unlabeled` | **positive** (player-confirmed iconic gesture) | 6 |
| 3 | 1–5 | `open` | negative | 31 |
| 3 | 6–8 | `wrist-away-gesture` | positive | 26 |

Capture 3 take #8 contains two detections at each of 7 timestamps — the MediaPipe duplicate
pair fixed in the M1 change. Both copies of the hand are counted here, which is why take #8
contributes 14 rows.

## The headline problem: the classes overlap, and in one case invert

Both shipped classifiers reject **all 70** observations. For the negatives that is correct. For
the 39 positives it is the failure.

Relaxing a threshold cannot fix it, because the labelled classes are not separable in any
feature measured. The clearest single illustration, from capture 3:

| Take | Label | middle PIP (°) | middle tip→palm / span | curl verdict |
|---|---|---|---|---|
| 5 | **open** | 146, 115, **20**, 33, **152**, 160, 121 | 0.55, 0.54, 0.62, 0.66, 0.57, 0.58 | **`curled`** on the 20° frame |
| 6 | **gesture** | 142, 167, 178, 176, 177, 160 | 0.63, … | `not curled` on all 6 |

Take 5 is a **negative** whose third observation measures as a fully curled middle and ring
(array frame 3: middle PIP 20°, ring PIP 3°, `curl` verdict `y` for both). Take 6 is a
**positive** whose six observations all measure as straight (142–178°). The labels and the
landmarks point in opposite directions.

Two further symptoms in the same data:

- **The measurements are not stable within a held pose.** Take 5's middle PIP swings
  146 → 115 → 20 → 33 → 152 → 160 across 1.3 s. A hand cannot flip between folded and
  extended five times while held still, so those readings are noise, not pose.
- **The hand is small in frame.** Hand span (wrist → middle MCP) is **0.08–0.13** in
  diagonal-normalized units for every observation in all three captures. That is roughly 50 px
  in a 480-tall frame. MediaPipe's landmark precision degrades sharply at that scale.

## Candidate discriminators, evaluated

For each candidate, the best achievable threshold over all 70 observations. `FP` = labelled
negatives that would fire; `FN` = labelled positives that would be rejected. Lower is better for
both.

| Candidate | best FP | best FN | FNs at a zero-FP operating point |
|---|---|---|---|
| middle+ring tip→palm (mean) | 0 | **21 / 39** | 38 / 39 |
| outer−inner chord contrast | 0 | 29 / 39 | 38 / 39 |
| middle arc / span | 0 | 32 / 39 | 38 / 39 |
| middle PIP angle, 2D | 1 | 39 / 39 | none exists |
| middle PIP angle, **3D using MediaPipe z** | 0 | 34 / 39 | 38 / 39 |
| outer−inner arc contrast | 1 | 39 / 39 | none exists |
| outer−inner tip→palm contrast | 1 | 39 / 39 | none exists |

**Every candidate fails.** The best rejects more than half the real gestures while catching every
negative; at a zero-false-positive operating point practically every candidate rejects 38 of 39
positives. There is no threshold that makes the gesture fire without also firing on the recorded
open hands.

**Estimated 3D (MediaPipe `z`) does not rescue it.** `M pip3` is no better than the 2D angle, and
the `arc3` contrast is worse. Consistent with §8 Rule C: `z` is an estimate, not a measurement,
and it does not carry the out-of-plane flexion information that the 2D projection loses.

## Why the iconic gesture was rejected, as far as the evidence goes

The gesture's defining feature is that the **middle and ring fingers are curled**, and that
feature is precisely the one the landmarks do not reliably report here:

1. **The curl is largely out of plane.** With the wrist turned away — the natural firing
   orientation, and the one the player used — flexion happens mostly *toward the palm*, which
   faces away from the camera. The 2D projection therefore shortens the visible finger and the
   PIP angle stops indicating flexion.
2. **The fingertip is the least reliable landmark on a flexed finger** (established in the
   previous slice). MediaPipe appears to reconstruct a flexed tip along an extended-curl prior,
   which is why the positives read as straight.
3. **The hand is small in frame**, which makes both effects worse.

Point 1 is a genuine physical limit, not a bug: if the flexion is not observable, no post-hoc
classifier can recover it from that frame.

## What was changed

**No gesture threshold, gate or classifier was changed.** The evidence does not support it, and
loosening a threshold against this data would produce false shots on the recorded open hands —
the one outcome the requirements forbid outright.

One diagnostic was added, because the next recording is uninterpretable without it: the capture
now records the **capture's pixel size**, so a normalized hand span can be read in pixels. The
current captures do not contain it, so it is not yet possible to tell whether `span ≈ 0.10` means
a normal hand on a large sensor or a hand too small to resolve.

A safety regression test pins the property that must never regress: **no recorded negative
produces a gesture verdict.** It deliberately does not assert a positive rate, because 0/39 is
the current honest figure and the test's job is to keep the negatives safe while the classifier
changes.

## The confound that must be removed before tuning

The negatives were recorded with the **palm facing the camera** ("open hand"), and the positives
with the **wrist turned away**. Orientation and pose therefore vary together, and the two cannot
be told apart from this data. Any threshold fitted here would be fitting orientation, not curl.

## What to record next

One short session, aimed at the confound rather than at more repetition. For each item, save 3–4
takes:

1. **Open hand, wrist away** — the same orientation as the firing pose, with the fingers extended.
   This is the missing control. Without it there is no way to know whether the classifier is
   responding to curl or to orientation.
2. **The iconic gesture, wrist away**, held steadily — the existing positive, repeated for
   volume.
3. **The iconic gesture, palm toward the camera** — the same pose in the easy orientation. If this
   one is recognised while the wrist-away one is not, the problem is observability, not
   thresholds, and that is confirmed rather than assumed.
4. **Open hand, palm toward the camera** — the existing negative, retained as the control that
   must never fire.

Also, so the next analysis is not blocked on the same question:

- **Hold the hand closer to the camera**, roughly filling a third of the frame rather than a
  tenth. The capture now reports the pixel size, so the next run can confirm the hand is large
  enough for the detector.
- **Hold each pose still for the full 2 s before tapping**, so a take contains one pose rather
  than a transition.

If items 1 and 3 both read the same as item 2 — i.e. if the gesture is unrecognisable in *both*
orientations while the open hand is separable — then the problem is not orientation at all and
the next step is a different signal (for example, temporal motion of the fingertips rather than a
per-frame pose). That is a design decision for the maintainer, not something to infer from these
recordings.
