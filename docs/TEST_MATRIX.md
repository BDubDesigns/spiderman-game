# TEST_MATRIX.md

Every acceptance test from PLAN.md §13, with its classification and status.

- **[A]** agent-testable
- **[H]** human/device required
- **[A+H]** both required

**A milestone is not fully accepted until all of its `[H]` rows are checked by a
human** (PLAN.md §14.3, §16.5). An agent updates `[A]` rows only. If a required
device or hand test is unavailable, the row is marked `pending` and explicit human
approval is required before starting the next milestone. **Pending is never
reported as passed.**

Status key: `[x]` verified · `[ ]` not started · `pending` awaiting human

**Current state: M0 — agent-complete. M1 not started.**

---

## M0 — Dev harness, replay, and interactive mouse/touch hand simulator

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M0.1 | `npm run dev` shows synthetic landmarks animating on screen, driven by the mouse or a replay file | [A] | [x] | Automated: `src/pipeline.test.ts` drives the real fixed-step loop, pulls frames from `MouseSource` and `ReplaySource`, and asserts 21 dots drawn per hand per frame (20 frames → 420 dots) at the transformed positions. Dev server also smoke-checked. **Residual:** whether it *looks* right is a visual judgement; a 10-second human glance at `npm run dev` would close it, though the plan classifies M0 with no `[H]` rows. |
| M0.2 | No camera involved. No game systems yet | [A] | [x] | No `getUserMedia`, no MediaPipe dependency, no camera import anywhere. `package.json` has no runtime dependencies at all. No targets/webs/scoring modules exist; `src/game/loop.ts`'s `update` is intentionally empty. |
| M0.3 | Unit tests exist for the coordinate transform `toCanvas` and pass | [A] | [x] | `src/render/stage.test.ts` — 21 tests covering origin, horizontal mirror, edge values, non-square aspect ratios and the Rule E inverse. Whole suite: **105/105 passing** across 7 files. |

Additional M0 verification beyond the stated criteria:

| Check | Class | Status | Evidence |
|---|---|---|---|
| TypeScript strict mode clean | [A] | [x] | `npm run typecheck` → 0 errors, with `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noUnusedLocals`, `verbatimModuleSyntax`. |
| Production build succeeds | [A] | [x] | `npm run build` → 13 modules, 25.66 kB JS (9.56 kB gzip), 0.84 kB CSS. |
| No known dependency vulnerabilities | [A] | [x] | `npm audit` → 0 vulnerabilities (Vite 7.3.7, Vitest 5.0.4, TypeScript 5.9.3, all exactly pinned). |
| Mirroring round-trips exactly once | [A] | [x] | `src/pipeline.test.ts` asserts a pointer at a deliberately off-centre canvas point produces a palm centroid at that same point, i.e. canvas → normalized → hand → canvas is the identity. |
| Replay fixture is well-formed and honest about being synthetic | [A] | [x] | `src/sim/replaySource.test.ts` parses the committed fixture and asserts 24 complete hands, no per-hand confidence fields, `provenance: "simulated"`, and that the middle/ring fingers actually fold mid-clip. |
| The HUD reports no unmeasurable value | [A] | [x] | `src/debug/hud.test.ts` asserts the HUD text contains no `Hz`, `inference`, `confidence`, `gestureScore`, `latency` or `staleness` string (PLAN.md §5.1, §6.2, §7.2). |

---

## M1 — Camera, real tracking, identity, and the worker decision

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M1.1 | Mirrored video and landmarks both align with the real hands on screen; HUD text reads correctly (unmirrored) | [H] | [ ] | Full-pipeline gate (PLAN.md §8 Rule F). Not tested at M0 — requires a camera. |
| M1.2 | Handedness label verified empirically and corrected if needed | [H] | [ ] | Requires a person to raise a known hand. |
| M1.3 | Identity association survives a hand crossing and a hand leaving/re-entering frame without swapping | [H] | [ ] | Requires real hands. Partially supported later by fixture-driven `[A]` tests. |
| M1.4 | Camera denied → simulator offered and usable, no dead end | [H] | [ ] | Requires denying a real permission prompt. The M0 simulator is the intended fallback and is already functional. |
| M1.5 | Worker decision recorded in `docs/` with measured numbers (or explicit deferral with rationale) | [A] | [ ] | M1 work. |
| M1.6 | Identity association unit tests pass against recorded landmark sequences | [A] | [ ] | M1 work; the M0 replay harness and fixtures are the intended input mechanism. |

## M2 — Gesture detection and tuning

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M2.1 | Unit tests for `classifyGesture` against a fixture set covering folded/extended/ambiguous poses | [A] | [ ] | M2 work. |
| M2.2 | Unit tests for the state machine: release-to-rearm, no-fire-while-held, rearm-block-on-reacquisition | [A] | [ ] | M2 work. |
| M2.3 | Gesture fires reliably when performed deliberately by an **adult** hand | [H] | [ ] | M2 work. |
| M2.4 | Gesture fires reliably by a **child's** hand (if the child is unavailable this is recorded as deferred and the milestone is **not** fully accepted) | [H] | [ ] | M2 work. Availability to be confirmed by the human. |
| M2.5 | Ordinary hand movement does **not** fire | [H] | [ ] | M2 work. |
| M2.6 | Gesture tested at the five orientations in §11.5; failures documented | [H] | [ ] | M2 work. |
| M2.7 | Tuned thresholds committed to `config.ts` with a comment recording device and hand used | [A+H] | [ ] | M2 work. |

## M3 — Webs and targets

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M3.1 | Hit detection and target state unit tests pass | [A] | [ ] | M3 work. |
| M3.2 | On the primary device, performing the gesture at a target produces a correct-looking web originating from the hand and splatting on the target | [H] | [ ] | M3 work. |

## M4 — Full round

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M4.1 | Scoring and alternation state machine unit tests pass, including the wrong-hand no-op rule (§12.4) | [A] | [ ] | M4 work. |
| M4.2 | A complete playable round start to finish on the primary device | [H] | [ ] | M4 work. |

## M5 — Polish

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M5.1 | Runs at ≥30 FPS sustained on the Pixel 10 Pro XL at the chosen quality tier; feels good in playtest | [H] | [ ] | M5 work. |

## M6 — Hardening and cross-browser

| # | Acceptance test | Class | Status | Evidence / notes |
|---|---|---|---|---|
| M6.1 | Every failure path produces a clear message and a playable alternative where possible | [H] | [ ] | M6 work. |

---

## Manual checklist coverage (PLAN.md §17)

The §17 manual checklist applies from M1 onward. Every item on it is `[H]`, so
none can be checked at M0. Items that M0 does *not* touch at all — camera,
handedness label, crossings, gesture firing, scoring, round completion, device
rotation on real video, 5-minute device play — are deliberately left for the
milestones that introduce the relevant subsystem.
