# G1 — Live validation gate report

Recorded 2026-09-11 against landed D1 and R2. Thresholds were pre-committed
on 2026-08-13 ([#1 day-0 comment](https://github.com/xchewtoyx/checkin/issues/1#issuecomment-5280674435));
the 50–74% middle band was defined 2026-08-28, before this rate was computed.
Thresholds are not revised after seeing the data.

Primary records: GitHub [#1](https://github.com/xchewtoyx/checkin/issues/1)
(MVP gate) and [#14](https://github.com/xchewtoyx/checkin/issues/14) (extract
gate). Delivery: GitHub [#25](https://github.com/xchewtoyx/checkin/issues/25)
and Linear [CCP-425](https://linear.app/chewcorp/issue/CCP-425). Recorded on
the feature-ask issues as
[#1 comment](https://github.com/xchewtoyx/checkin/issues/1#issuecomment-5641319697)
and
[#14 comment](https://github.com/xchewtoyx/checkin/issues/14#issuecomment-5641319807).

## Numbers (before the verdict)

### #1 §5 — 14-day answer rate (2026-08-13 → 2026-08-26)

Source: production D1 `checkin_prompt` (export columns only), evaluated
2026-09-11. Grain is one row per prompt. London calendar date is taken from
the prompt id (`prompt-YYYY-MM-DD-wN`), which is the scheduler's
Europe/London `dateKey`.

```sql
SELECT id, scheduled_for, sent_at, expires_at, status, created_at
FROM checkin_prompt
ORDER BY created_at ASC;
-- filter: id date in [2026-08-13, 2026-08-26]
```

Verdict metric: **answered / sent**, with expired in the denominator and
`failed` excluded (notification never delivered). In-flight `sent` would
count as non-response; none remain in this window.

| Status in gate window | Count |
| --- | ---: |
| answered | 35 |
| expired | 6 |
| sent | 0 |
| failed | 0 |
| scheduled | 0 |
| **sent prompts (denom)** | **41** |

**Answer rate = 35 / 41 = 85.4%.**

`failed` count = 0, so the including-failed rate is the same 85.4% and is
not shown separately as a distinct figure. Delivery-reliability figure:
**0 failed prompts** in the gate window (and 0 in the full D1 table at
evaluation time).

Per window per day (exactly one prompt per occupied slot; `rate` is
answered / sent for that slot):

| Date | w0 morning | w1 afternoon | w2 evening |
| --- | --- | --- | --- |
| 2026-08-13 | — (go-live after this window) | 1/1 | 1/1 |
| 2026-08-14 | 1/1 | 1/1 | 1/1 |
| 2026-08-15 | 1/1 | 1/1 | 1/1 |
| 2026-08-16 | 1/1 | 1/1 | 1/1 |
| 2026-08-17 | 1/1 | 1/1 | 1/1 |
| 2026-08-18 | 1/1 | 1/1 | 1/1 |
| 2026-08-19 | 1/1 | 1/1 | 1/1 |
| 2026-08-20 | 1/1 | 0/1 expired | 0/1 expired |
| 2026-08-21 | 0/1 expired | 0/1 expired | 1/1 |
| 2026-08-22 | 1/1 | 1/1 | 1/1 |
| 2026-08-23 | 1/1 | 1/1 | 1/1 |
| 2026-08-24 | 1/1 | 1/1 | 1/1 |
| 2026-08-25 | 0/1 expired | 1/1 | 1/1 |
| 2026-08-26 | 0/1 expired | 1/1 | 1/1 |

The six expiries cluster on 20–21 Aug (four consecutive misses after a
perfect first week) and two later morning misses (25 and 26). They are
non-response in the KPI, not noise (F5).

**Duplicate check (F2):** 0 `(window, day)` slots with more than one prompt.
The only unoccupied slot is 2026-08-13 w0, which is before the live clock
started (day-0 owner report is the 14:00 afternoon check-in). That is
absence of a morning sample on go-live day, not a duplicate.

**Drift check (F1, N3):** 0 prompts with `scheduled_for` or `sent_at` outside
08:00–20:00 Europe/London, and 0 outside the configured window of their id
suffix (`w0` 09:00–11:00, `w1` 13:00–15:00, `w2` 17:00–19:00). Send times
fall on the 15-minute cron tick at or after `scheduled_for`, still inside
the window.

### Star-model tie-back (checkin-analytics)

`fact_checkin_prompt` is designed so answer rate is
`SUM(answered_flag)/SUM(prompt_count)`. Rebuilt from the
`2026-08-26/150000` snapshot (extraction 2026-08-26T15:00:04.906Z):

| Snapshot | prompts | answered_flag sum | rate |
| --- | ---: | ---: | ---: |
| 2026-08-26/150000 (mid-gate-day) | 40 | 34 | 85.0% |

That snapshot is a point-in-time copy taken at 15:00 UTC / 16:00 London,
so it correctly omits 2026-08-26 w2 (not yet issued) and still has
2026-08-26 w1 as `sent` (answered later). The closed D1 state, and the next
snapshot `2026-08-27/030000`, both have the full 41-row gate universe at
35 answered / 6 expired = **85.4%**. The 15:00 UTC snapshot and the closed
state agree to rounding; they are not expected to be row-identical.

### #14 §6 — 7-day extract gate (2026-08-20 → 2026-08-26)

Required: both daily manifests (`030000`, `150000`) per table, zero
unexplained `analytics_extract_failed` events, analytics-side row counts
tying back to D1.

**Manifests:** 14/14 present under
`raw/cloudflare/checkins/manifests/extraction_date=YYYY-MM-DD/{030000,150000}.json`
for 2026-08-20 through 2026-08-26. Matching `checkin_prompt` and
`checkin_response` `.jsonl.gz` objects exist for every slot.

**Tie-back:** for all 14 slots, gunzipped JSONL line counts equal the
manifest `row_count` for both tables (28/28 table files). End-of-gate slot
`2026-08-26/150000`, extraction timestamp `2026-08-26T15:00:04.906Z`:

| Table | manifest | jsonl lines | D1 rows as of extraction_timestamp |
| --- | ---: | ---: | ---: |
| checkin_prompt | 40 | 40 | 40 |
| checkin_response | 34 | 34 | 34 |

The D1 column is a direct row count of each table, not an inference from
prompt status:

```sql
SELECT COUNT(*) FROM checkin_prompt   WHERE created_at   <= '2026-08-26T15:00:04.906Z';
SELECT COUNT(*) FROM checkin_response WHERE submitted_at <= '2026-08-26T15:00:04.906Z';
```

Both returned the figures above against production D1. The earlier
response-side figure in this report was "34 answered prompts at that
instant", which is not the same claim: the response upsert and the prompt
status update are separate writes, so prompt status cannot stand in for a
`checkin_response` count. It is now a count of that table.

This reconstruction assumes no deletes or edits to those rows since
extraction. It cannot detect a row that was mutated in place afterwards.

The 14 gate-window slots were written by an unbounded export — it read
whatever was in the table when each query ran, while the manifest reported a
timestamp captured earlier in the scheduled handler. The two agree here, but
that agreement was not guaranteed: a check-in submitted while the run was in
flight would have landed in the snapshot yet fallen outside the timestamp the
manifest claims.

The export now bounds `checkin_prompt` by that timestamp. `created_at` is never
rewritten, so the bound can only ever exclude rows that did not exist at the
watermark — and mid-run it excludes nothing, since the scheduler stamps
`created_at` from the same instant the watermark comes from.

`checkin_response` is deliberately left unbounded. Its only candidate column,
`submitted_at`, is mutable: re-answering upserts the row and moves
`submitted_at` forward, so bounding on it drops responses that existed long
before the watermark and makes them look **deleted** for that slot. Nothing
catches it, because the `COUNT(*)` carries the same predicate and therefore
agrees with the short JSONL. `observed_at` is no better — it derives from
`prompt.sent_at`, so it would admit responses that did not exist yet. A
response written mid-run therefore still lands in the slot while falling
outside the manifest's timestamp; over-including a row is the lesser harm
against appearing to delete one.

Three limits remain, all properties of how rows are written rather than of the
extract ([#62](https://github.com/xchewtoyx/checkin/issues/62)).
`submitted_at` and `created_at` are stamped when the request starts, not when
the write commits, so a submission in flight across an export can carry a
timestamp inside the watermark while committing after the read.
`checkin_prompt.status` is mutated in place and unversioned, and the prompt
query filters on the immutable `created_at`, so status is exported as it reads
at extraction time, not as of the watermark: a prompt answered just after the
watermark can appear `answered` in a slot whose response object does not yet
carry the answer. And `checkin_response` has no immutable creation column to
bound on at all, which is why it is not bounded. An exported prompt's status
should therefore be read as "status when the extract ran", and the as-of counts
above as reconstruction rather than proof.

**What each check proves.** The 28/28 result above is manifest-to-JSONL
agreement only. Both sides of that comparison derive from the same
in-memory array in `executeAnalyticsExtract`, so it can catch a corrupt or
truncated *upload* and nothing else — in particular it cannot see a short
read from D1. That matters because `listAllPromptsForExport` and
`listAllResponsesForExport` are unpaged full-table queries; silent
truncation under a D1 result limit is invisible at 40 rows and stays
invisible until it is not.

The extract now takes a separate `SELECT COUNT(*)` per table — a different
code path from the row fetch — and records it in the manifest as
`source_row_count` (`manifest_version` 2). On disagreement it **fails
open**: it still writes the JSONL objects and the manifest, sets
`source_count_mismatch` (top-level and per table), and logs
`analytics_extract_source_count_mismatch`. It does not throw. Fail-closed
would produce a landing-zone gap with no explanation of it, because the
only extract-failure event is an unqueryable Workers log line
([#61](https://github.com/xchewtoyx/checkin/issues/61)). Consequence
accepted: mismatched data lands, and every manifest consumer must check
the flag. `scripts/verify-analytics-extract.sh` compares all three numbers
per table and fails on any mismatch, so a flagged slot does not pass
tie-back. An opt-in `--d1` flag runs the as-of count live so a historical
slot can be checked without running the query by hand. The 14 gate-window
manifests predate the field (`manifest_version` 1) and are verified
two-way, as the script reports; a manifest that declares version 2 and
omits the field is a broken artifact and fails.

**Unexplained extract failures: not evaluated.** The pre-committed
condition was zero unexplained `analytics_extract_failed` events. That
event is only ever a structured log line — `src/index.ts` catches the
extract error, logs it, and lets the rest of the scheduled handler
continue — so the evidence lives solely in Workers Observability, whose
query API the deploy token is not authorised for (API 10000). The
condition was therefore never checked, in either direction. Tracked as
[#61](https://github.com/xchewtoyx/checkin/issues/61).

The substitute evidence is completeness of the landing zone (N3): the only
missing slot in the entire landing zone is `2026-08-15/030000`, outside
this 7-day window and explained on the day (E1 deployed after that morning
UTC slot). From 2026-08-16 `030000` through 2026-09-11 `150000` every
expected slot is present, so there is no unexplained gap in the gate
window.

That argument is stronger than a bare "no gaps": the export window is 15
minutes and matches the cron cadence, so a thrown handler is not retried
inside its own slot, and the manifest is written last, after both table
objects. On a slot's **first** run that makes it a commit marker — nothing
precedes it at that key, so a partial run leaves a detectable gap.

The commit-marker property does not survive a re-run, and the gate evidence
should not be read as if it did. Re-running an already-complete slot
overwrites the table objects in place while the previous manifest still sits
at its key, so a re-run that writes the prompt object and then fails leaves a
manifest standing over mixed old and new table snapshots, with no gap to
detect. The three-way count check catches that only when the row counts
changed; a re-run at an unchanged row count is invisible to it. Closing this
properly needs attempt-specific objects, or some other way to stop a stale
manifest certifying partially overwritten files — tracked with the rest of the
landing-zone self-description work in
[#61](https://github.com/xchewtoyx/checkin/issues/61).

So the evidence remains an argument from absence. It proves no gap remained;
it does not prove no failure occurred, it does not cover a manual re-run
inside the same 15-minute window, and for a re-run it does not even establish
that the objects under a manifest all came from the same run.

## Post-gate: the failure condition is now evaluable

Since this report was written, CCP-648 closed the evidence gap rather than
leaving the condition substituted. Every extract run now stamps one
`attempt_id` onto every exported row and into the manifest
(`manifest_version` 3), and a failed attempt writes a durable marker into the
same bucket before the handler logs:

```
raw/cloudflare/checkins/_status/extraction_date=YYYY-MM-DD/<HHMMSS>-<attempt_id>.json
```

The marker records the slot, the attempt id, the error, and a timestamp,
readable with the credentials that already operate the extract — no
Observability access needed. Zero unexplained `analytics_extract_failed`
events now means zero `_status/` markers without a recorded explanation,
which is an object listing, not an argument from absence. And because a
marker carries its attempt id, a clean re-run in the same slot leaves the
earlier failure visible rather than overwriting it.

The same change makes the stale-manifest hazard above checkable from the
bucket: every row names the attempt that wrote it, so a partially overwritten
slot has table rows naming an attempt the surviving manifest does not
certify. Both checks run in the existing verifier:

```
bash scripts/verify-analytics-extract.sh raw/cloudflare/checkins/manifests/extraction_date=YYYY-MM-DD/HHMMSS.json
```

It lists the slot's `_status/` markers (when `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` are set) and fails on any attempt-id mismatch between
rows and manifest — which is the re-run-at-unchanged-row-counts case the
count check above cannot see. The token must carry R2 object-read on the
bucket: a wrong-scope token fails the run loudly (the listing cannot masquerade
as "no markers"), while unset variables take the documented skip path.

## Verdict

Pre-committed bands: ≥ 75% pass; 50–74% pass-with-friction-review; < 50%
friction failure.

| Gate | Metric | Threshold | Result |
| --- | --- | --- | --- |
| #1 answer rate | 35/41 = **85.4%** | ≥ 75% pass | **PASS** |
| #1 duplicates | 0 | 0 | **PASS** |
| #1 schedule drift | 0 | 0 | **PASS** |
| #14 manifests | 14/14 slots | 7 days × 2 slots | **PASS** |
| #14 tie-back | 28/28 files match; D1 as-of 40/34 both tables | manifest = jsonl = D1 as-of | **PASS** |
| #14 unexplained failures | log unqueryable (API 10000) | 0 | **NOT EVALUATED** — substitute: landing-zone completeness ([#61](https://github.com/xchewtoyx/checkin/issues/61)) |

**#1 live validation gate: PASS.** Backlog order is unchanged. The check-in
UX slice ([#40](https://github.com/xchewtoyx/checkin/issues/40) /
CCP-428) is not pulled forward by this gate; it remains in its planned
place.

**#14 extract gate: QUALIFIED PASS.** Manifest completeness and the
two-table D1 tie-back both pass on their own evidence. The third
pre-committed condition — zero unexplained `analytics_extract_failed`
events — was not evaluated, because the credentials in use cannot query
the only place that event is recorded; landing-zone completeness stands in
for it, and is argument from absence rather than the committed check. The
threshold is not revised to fit that: the condition is recorded as
unevaluated, not as met.

Downstream analytics work
([checkin-analytics#1](https://github.com/xchewtoyx/checkin-analytics/issues/1),
[checkin-analytics#5](https://github.com/xchewtoyx/checkin-analytics/issues/5))
is not blocked by this gate. The telemetry gap is tracked as
[#61](https://github.com/xchewtoyx/checkin/issues/61) and should be closed
before the next gate window, so the condition is evaluable rather than
substituted for a second time.
