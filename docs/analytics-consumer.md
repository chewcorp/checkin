# Analytics consumer hookup

Operational guide for importing checkin analytics extracts from R2 (issue #14, slice **E2**). The extract layout and data contract live in [`analytics-extract.md`](analytics-extract.md); this document covers **consumer access only**.

## Bucket and prefixes

| Resource | Value |
| --- | --- |
| R2 bucket | `checkin-analytics` |
| Prompt import prefix | `raw/cloudflare/checkins/checkin_prompt/` |
| Response import prefix | `raw/cloudflare/checkins/checkin_response/` |
| Manifest prefix (monitoring) | `raw/cloudflare/checkins/manifests/` |

Each daily export writes three objects under a shared `extraction_date=YYYY-MM-DD/HHMMSS` partition key. Two slots run **12 hours apart**: **03:00 UTC** (`030000`) and **15:00 UTC** (`150000`).

## Read-only R2 token (N2)

Create a Cloudflare **R2 API token** scoped for the analytics platform:

1. Cloudflare dashboard → **R2** → **Manage R2 API tokens** → **Create API token**.
2. Permissions: **Object Read** only (no Object Write, no Admin Read/Write).
3. Scope: bucket `checkin-analytics` only. Optionally restrict to prefix `raw/` if your token UI supports prefix conditions.
4. Store the token in the analytics platform's secret store — **not** in this repo or Worker secrets.

The Worker continues to write through its R2 binding (`EXTRACT_BUCKET`); no new Worker secrets are added for consumer access.

### Verify read-only scope

With the consumer credentials and [R2's S3-compatible endpoint](https://developers.cloudflare.com/r2/api/s3/api/):

```bash
export AWS_ACCESS_KEY_ID="<token-access-key>"
export AWS_SECRET_ACCESS_KEY="<token-secret>"
export AWS_ENDPOINT_URL="https://<account_id>.r2.cloudflarestorage.com"

# Should succeed
aws s3 ls "s3://checkin-analytics/raw/cloudflare/checkins/manifests/"

# Should fail (AccessDenied) — confirms write is blocked
aws s3 cp /etc/hosts "s3://checkin-analytics/raw/_write_probe" || echo "write correctly denied"
```

Replace `<account_id>` with your Cloudflare account ID (`CLOUDFLARE_ACCOUNT_ID`).

## Import-source configuration (F2)

Point the analytics platform's **S3-compatible import** at two table prefixes (one import job or mapping per prefix):

| Import name | S3 URI prefix | Format |
| --- | --- | --- |
| `checkin_prompt` | `s3://checkin-analytics/raw/cloudflare/checkins/checkin_prompt/` | gzipped JSONL, Hive partition `extraction_date` |
| `checkin_response` | `s3://checkin-analytics/raw/cloudflare/checkins/checkin_response/` | gzipped JSONL, Hive partition `extraction_date` |

Column names match D1 exactly, except `response_token` and `notification_id` are **never** present in prompt exports (F4). Select the **latest** file per table (or latest `extraction_date` / slot timestamp partition) when loading current state — snapshots are complete point-in-time copies, not deltas. Expect **two snapshot pairs per calendar day** (`030000` and `150000`).

## Tie-back verification (F6)

After an export lands, confirm three numbers per table agree — manifest
`row_count`, gunzipped JSONL line count, and manifest `source_row_count` —
and that `source_count_mismatch` is false. The worker writes on a source-count
disagreement (fail open) and records the mismatch in the manifest; a complete
landing zone is not by itself a clean extract. `scripts/verify-analytics-extract.sh`
fails on any numeric mismatch.

```bash
# List manifests (consumer read-only token or operator wrangler auth)
aws s3 ls "s3://checkin-analytics/raw/cloudflare/checkins/manifests/" --recursive

# Operator tie-back (uses wrangler + jq)
bash scripts/verify-analytics-extract.sh \
  raw/cloudflare/checkins/manifests/extraction_date=YYYY-MM-DD/030000.json
```

Expected output: `tie-back ok (source=manifest=jsonl): prompt=N response=M manifest=...`

## Absence detection (N3)

Alarm when a calendar day is missing **either** expected manifest (`030000` or `150000`) under `raw/cloudflare/checkins/manifests/extraction_date=YYYY-MM-DD/`. Example checks (run after each slot window closes):

```bash
DATE=$(date -u +%F)
for SLOT in 030000 150000; do
  aws s3 ls "s3://checkin-analytics/raw/cloudflare/checkins/manifests/extraction_date=${DATE}/${SLOT}.json" \
    || echo "missing export for ${DATE} slot ${SLOT}"
done
```

Export failures are also logged server-side as `analytics_extract_failed` and,
since CCP-648, recorded durably in the bucket at
`raw/cloudflare/checkins/_status/extraction_date=YYYY-MM-DD/<HHMMSS>-<attempt_id>.json`
— the marker carries the slot, attempt id, error and timestamp, and survives a
clean re-run of the same slot. `scripts/verify-analytics-extract.sh` lists a
slot's markers and flags row-vs-manifest `attempt_id` mismatches (a partial
re-run at unchanged row counts); the listing uses `CLOUDFLARE_API_TOKEN` +
`CLOUDFLARE_ACCOUNT_ID` against the R2 objects API, so the token needs R2
object-read — a wrong-scope token fails loudly, unset variables skip the
listing only.

## Live validation gate

The pre-committed production gate (7 consecutive days, row counts matching D1 on inspection) is tracked on [#14](https://github.com/xchewtoyx/checkin/issues/14). Complete E2 hookup before starting that clock.
