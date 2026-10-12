# COST_LOG.md

Measurement record for the Web Slinger experiment (PLAN.md §14).

This project doubles as a real, unsubsidized measurement of agentic software
development cost using DeepSeek Harness (DSH) and the DeepSeek API. The
measurement is deliberately lightweight: **one row per milestone**, appended at
completion, using only what DSH already exposes. There is no telemetry
infrastructure, no log parsing, and no dashboards (PLAN.md §14.2).

## Rules

- **Do not invent numbers.** If DSH does not expose a field, write `unavailable`
  and note why or how it could be obtained.
- **One row per milestone**, appended at completion. Do not backfill.
- **Never attribute cost to the game runtime.** These are development costs.

## Fields

| Field | Source |
|---|---|
| Milestone | manual |
| Model | DSH |
| DSH version | `dsh --version` |
| Input tokens, cache miss | DSH usage report, if exposed |
| Input tokens, cache hit | DSH usage report, if exposed |
| Output tokens | DSH usage report, if exposed |
| Reasoning tokens | DSH usage report, if exposed |
| Actual API dollars spent | DSH usage report, if exposed |
| Agent turns | DSH session log |
| Retries / corrective prompts | DSH session log |
| Tests run / passed | local test runner output |
| Manual device tests remaining | `docs/TEST_MATRIX.md` |
| Notes | manual |

### Where the DSH numbers come from

DSH 0.2.0-rc.2 exposes a cumulative session token record at:

```
$DSH_HOME/storages/session_projcache/sessions/<session-id>.json
```

under `record.rows.tokenUsage.val.totals`, with the fields
`uncachedInputTokens`, `cacheReadTokens`, `cacheWriteTokens` and `outputTokens`.
These are **whole-session cumulative totals**, not per-milestone deltas, because
DSH keeps only the running total. The `Notes` column therefore states which
session a row covers.

DSH does **not** expose a reasoning-token count (only the configured
`reasoningEffort`) or a dollar figure, so those rows read `unavailable`.

## Log

Model identity is as configured in `$DSH_HOME/profiles/web/cordis.patch.yml`
(`agent-default-model`): provider `deepseek-official`, model alias
`deepseek-flash`, `reasoningEffort: high`. The concrete model id behind the alias
was not verified and is not claimed here.

| Milestone | Model | DSH version | Input tokens, cache miss | Input tokens, cache hit | Output tokens | Reasoning tokens | Actual API dollars spent | Agent turns | Retries / corrective prompts | Tests run / passed | Manual device tests remaining | Notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| M0 — dev harness, replay, interactive mouse/touch hand simulator | `deepseek-flash` (`reasoningEffort: high`) | `0.2.0-rc.2` | 50,201 | 8,277,760 | 124,557 | unavailable — DSH exposes only the `reasoningEffort` setting, not a token count | unavailable — DSH exposes no cost or pricing field; derivable only by applying published DeepSeek pricing to the token counts in this row | 1 user turn / 85 counter steps | 0 code rework rounds. Two self-corrected mistakes during the milestone: a typecheck failure from an `as const`-narrowed toggle plus lost control-flow narrowing, and a backwards mirroring assertion in an integration test. Both were caught by the project's own typecheck/tests, not by a human. | 105 / 105 (`vitest run`, 7 files) | 0 — M0 has no `[H]` acceptance items (PLAN.md §13) | Whole-session cumulative totals, read from the DSH session store immediately before the M0 commit. The session also contains repository bootstrap (git init, first push) and plan review, so M0's own code cost is a subset. DSH stores only running totals, so a per-milestone delta is not obtainable. `cacheWriteTokens` was 0. |
| M1 — camera, real tracking, identity, worker decision | `deepseek-flash` (`reasoningEffort: high`) | `0.2.0-rc.2` | 108,242 | 54,923,008 | 320,172 | unavailable — DSH exposes only the `reasoningEffort` setting, not a token count | unavailable — DSH exposes no cost or pricing field; derivable only by applying published DeepSeek pricing to the token counts in this row | 3 user turns / 131 counter steps | 0 code-rework rounds. Three mistakes were caught and fixed by the repository's own tooling rather than by a human: identity adoption letting detection array order pick a slot when there was no position history; a duplicate identifier and an unused parameter in `handTracker.ts`; and ESLint findings (an unnecessary assertion, four `require-await` test factories). One genuine corrective round: `npm install` without `-D` placed MediaPipe in `dependencies`, which is correct, but it invalidated the README's "zero runtime dependencies" claim and had to be reconciled. | 210 / 210 (`vitest run`, 13 files); lint and typecheck clean | 4 `[H]` rows pending on the Pixel 10 Pro XL — M1 is agent-complete, NOT accepted | Session-cumulative totals, read from the DSH session store at the final M1 commit, so this row INCLUDES the M0 figures above and cannot be subtracted from them. DSH retains only running totals, so an M1-specific figure is not obtainable; the M0 row records the same session at an earlier point. M1 also used a web-research subagent whose token use DSH does not attribute separately. |

### Notes on the M1 row

- **Cache accounting is exact, not estimated.** DSH reports `uncachedInputTokens`
  (cache miss), `cacheReadTokens` (cache hit), `cacheWriteTokens` and
  `outputTokens` for the session. The M1 row is that record read directly and the
  M0 row is the same record read earlier, so the two are consistent snapshots of
  one running total rather than independent measurements.
- **Reasoning tokens and dollars remain `unavailable`**, for the same reasons as
  M0: DSH exposes neither. Nothing has been inferred from the token counts, because
  §14.2 forbids inventing numbers and the applicable pricing is not knowable from
  the session record.
- **No dollar figure is implied anywhere in this file.** Deriving one requires
  published DeepSeek pricing applied to the token columns above, which is the
  reader's calculation to make, not a measurement this project took.
- **Delegation is counted, not hidden.** The two identity fixtures and their
  generator were produced by a subagent working from a written specification, then
  verified here by the full test suite and a file-level review in the M1 PR.
  Subagent token use is inside the session totals above but is not separable.


### Notes on the fields that are not plain numbers

- **Agent turns.** DSH's session record exposes `last.turn` (1) and a monotonic
  `step` counter (85), not a human-meaningful turn count. Both are reported as
  read, and neither is converted into an invented "turns" figure.
- **Retries / corrective prompts.** Counted as rework rounds on the code: zero.
  The two entries above were tool-caught mistakes inside a single planning pass,
  not repeated instructions.
- **Manual device tests remaining.** Zero for M0 by classification, because M0's
  acceptance criteria are `[A]` only: the milestone involves no camera, no hand
  and no device interaction. See `docs/TEST_MATRIX.md`. This does not mean M0 was
  verified on a device — it means no *device-specific* verification is required.

