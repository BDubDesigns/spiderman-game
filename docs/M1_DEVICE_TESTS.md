# M1 — device tests for the human

Everything here requires the **Pixel 10 Pro XL in Chrome** (the primary device from
`PLAN.md` §4.1), a real camera, and real hands. None of it can be verified from the
development environment, and none of it has been.

Results go into `docs/TEST_MATRIX.md` (M1 rows) and, for the measurement run,
`docs/M1_WORKER_DECISION.md`.

## If the camera will not start

A <kbd>Start camera</kbd> button now sits under the stage. It is a real button on
purpose: some playback refusals can only be resolved from inside a genuine user
activation, so the retry has to come from an actual click. The button relabels
itself:

| Label | Meaning | What clicking it does |
|---|---|---|
| `Start camera` | No camera session | Requests the camera and starts it |
| `Resume video` | The stream is **live** but the browser refused to play it | Retries playback from the click, without asking for permission again |
| `Camera running` | Working | Nothing (disabled) |

If playback is refused, the stream is deliberately **kept alive** so that
`Resume video` can work. The message tells you which failure it was, and the HUD
grows a `camera diagnostic:` line containing the browser's own error name and
message, verbatim.

### What to send me if the camera fails

The previous round lost this information, which is why the failure could not be
diagnosed from the report. Please copy:

1. **The full notice message** under the stage.
2. **The `camera diagnostic:` line** from the HUD — the error **name and message**
   exactly as Chrome wrote them, e.g. `NotAllowedError: play() failed because the
   user didn't interact with the document first`.
3. Which button label you saw, and whether `Resume video` changed anything.
4. Whether the same thing happens after a **reload** and a second attempt, and
   whether it happens in **Chrome desktop** as well as on the phone.
5. The `chrome://media-internals` entry for the tab, if you can open it — it
   records the actual playback pipeline state and any policy refusal.

With the real error name the cause is usually decisive: `NotAllowedError` is a
policy/activation refusal, `AbortError` means a competing load or play superseded
the request, `NotSupportedError` means the element never got a usable source, and
a timeout means the promise never settled at all.

## Setup

```bash
npm install
npm run dev -- --host        # --host so the phone can reach the server
```

Open the printed network URL on the phone. `localhost` and plain-HTTP LAN addresses
are **not** secure contexts, so `getUserMedia` will be blocked on an HTTP LAN URL —
the app will say so and offer the simulator. To exercise the camera you need
HTTPS. The simplest options:

- `npx vite --https` with a self-signed cert, and accept the warning on the phone; or
- a tunnel (`ngrok http 5173`, `cloudflared tunnel --url http://localhost:5173`); or
- `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with the LAN origin
  added, which is the least invasive for a one-off test.

**Record which method you used**, because an insecure-context failure is a
different result from a permission failure.

## 1. M1.1 — the full pipeline (PLAN.md §8 Rule F) — `[H]`

This is the gate. Do not proceed past it while it fails.

1. Press <kbd>C</kbd> — or click **Start camera** — and allow the camera. If the
   button says **Resume video**, click it; see "If the camera will not start".
2. Raise your **right** hand, palm toward the camera.
3. Check three things **together**, in one look:
   - the mirrored video looks like a mirror (raise your right hand, the image's
     hand on the same side as yours moves);
   - a dot sits **on every fingertip and knuckle** — not offset, not scaled;
   - the HUD text at the top-left reads normally, left-to-right, **unmirrored**.
4. Repeat with the left hand, then both.

| Result | Meaning |
|---|---|
| Video mirrored, dots aligned, HUD readable | ✅ pass |
| Video mirrored but dots offset | Rule B bug: a second transform crept in. Report it; do not fudge it. |
| Video and dots mirrored, HUD also mirrored | The HUD inherited the video transform. |
| Dots align but video is not mirrored | The video pass transform is wrong. |

## 2. M1.2 — handedness label — `[H]`

PLAN.md §8: **do not trust the label on first integration.**

1. Raise **only your right hand**. Wait for a stable detection.
2. Read the HUD's identity line: it reports `crossings`, `losses`, `reacquired`
   and `handedness conflicts`.
3. Then raise **only your left hand** and watch the same line.

How to read it, precisely:

| Observed | Interpretation | Action |
|---|---|---|
| Right hand → no conflicts, tracked stably | Label correct | Leave `swapHandedness: false` |
| Right hand → `handedness conflicts` climbing steadily | Label inverted | Set `MEDIAPIPE.swapHandedness = true` in `src/config.ts` and re-test |
| Both hands tracked, order swaps when you cross them | Identity bug, not a label bug | Report the crossing count and what happened |

`handedness conflicts` counts detections the tracker could only place by *ignoring*
the label. A steadily climbing counter means the label disagrees with where the
hands actually are.

## 3. M1.3 — crossing, occlusion, reacquisition — `[H]`

The automated tests cover these against synthetic sequences
(`src/tracking/handIdentity.test.ts`, and the fixtures
`fixtures/identity-crossing.json` / `fixtures/identity-reacquire.json`). This is the
real-hand version, which is what `[H]` means.

**Crossing.**
1. Raise both hands where both are clearly visible.
2. Slowly bring them together until they overlap, pass one over the other, and
   separate so they have swapped sides.
3. **Expected:** neither hand's dot set jumps to the other hand. The HUD's
   `crossings` counter increments and `(crossing now)` appears while they overlap.

**Leaving frame and returning.**
4. Take one hand out of frame entirely for about a second, then bring it back.
5. **Expected:** the hand's dots freeze where they were and the HUD shows
   `detection age … (STALE)` while it is gone — it must **not** drift or follow
   anything. `losses` increments if you stay out past the grace window (600 ms).
   On return, `reacquired` increments and the hand reappears on the correct side.

**Fast movement.**
6. Move one hand quickly across the frame.
7. **Expected:** tracking follows. A large jump may increment `handedness
   conflicts`, which is intended — position wins over a contradicting label, and it
   is reported rather than hidden.

## 4. M1.4 — camera denial is not a dead end — `[H]`

Run this **four** ways, reloading between each:

| # | How to provoke it | Expected |
|---|---|---|
| 1 | Deny the permission prompt | A message in plain language; the app switches to the simulator and is immediately usable with the mouse/touch |
| 2 | Allow, then revoke the camera for the site in Chrome settings, and reload | Same |
| 3 | Serve over plain HTTP on the LAN (no tunnel) | The "needs a secure (https) page" message, then the simulator |
| 4 | Block the camera device from another app (e.g. hold it in another video app), then start the camera | The "another app or tab is using the camera" message, then the simulator |
| 5 | Press <kbd>X</kbd> while the camera is running | The camera stops, the indicator goes out, and the message says so |

In every case **the game must remain playable**. `[H]` fails if any path leaves a
blank screen, a stuck spinner, or a console error the player can see.

## 5. Rotation — `[H]`

Rotate the device to landscape and back while the camera is running.

**Expected:** the canvas re-syncs to the video's new intrinsic size, the mirror is
still correct, the dots still sit on your hands, and the HUD is still readable.
This exercises §8 Rule D and `HandIdentityTracker.setSourceSize()`.

## 6. Five-minute reliability — `[H]`

Play continuously for 5 minutes with the camera active, and watch:

- `render … fps` should hold at ≥30, and should not decay over the session.
- `inference … Hz (measured)` is whatever the device sustains. **There is no target
  for this number** (§7.1).
- Frame time should stay stable; `dropped` should not grow continuously.
- No memory growth / crash / black frame.
- Watch for thermal throttling: note whether FPS drops in the last minute versus
  the first.

Then press <kbd>E</kbd> and keep the JSON — that is the worker-decision input.

## Recording results

| Row | Where |
|---|---|
| M1.1–M1.4 | `docs/TEST_MATRIX.md`, M1 section |
| §7.3 numbers | `docs/M1_WORKER_DECISION.md` |
| Any failure | Report it; do not edit thresholds in `src/config.ts` to make a test pass |

If a test cannot be run at the time, its row stays `pending`. Pending is never
reported as passed (PLAN.md §14.3, §16.5), and M2 must not start while these rows
are outstanding without explicit approval.
