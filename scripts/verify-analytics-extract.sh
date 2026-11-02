#!/usr/bin/env bash
set -euo pipefail

# Tie-back verification for a landed analytics extract manifest (issue #14, F6).
#
# Compares three numbers per table and fails on any disagreement:
#   1. manifest row_count        — rows the worker serialized
#   2. gunzipped JSONL lines     — rows that actually landed in R2
#   3. manifest source_row_count — an independent SELECT COUNT(*) taken by the
#                                  worker on a separate code path from the row
#                                  fetch, so a short read from the unpaged
#                                  export query is visible here
#
# (1) vs (2) alone is tautological for read errors: both derive from the same
# in-memory array, so it can only catch a corrupt or truncated upload. (3) is
# what ties the extract back to D1.
#
# The worker fails open on (1) != (3): it still writes the slot and sets
# `source_count_mismatch` in the manifest. This script is the consumer-side
# check of that flag — it fails on any of the three numbers disagreeing, so a
# flagged slot does not pass tie-back.
#
# manifest_version 1 artifacts (written before the source count existed) carry
# no source_row_count. Those are still verified (1) vs (2) and reported as
# such, rather than failing. A manifest that declares version 2 or later and
# omits the field fails: the version is the promise that the tie-back is there.
#
# Attempt-id check (option B, CCP-648): every object an extract attempt writes
# — each exported row and the manifest — carries the same attempt_id, so a
# rerun that overwrites a table object but dies before the response and
# manifest leaves rows naming an attempt the manifest does not certify. That
# is the partial rerun the count check cannot see at unchanged row counts.
# manifest_version 3 promises the field; earlier artifacts skip this check.
#
# _status/ listing (same ruling): a failed attempt leaves a durable marker at
# raw/cloudflare/checkins/_status/extraction_date=YYYY-MM-DD/<HHMMSS>-<attempt>.json.
# This script lists the slot's markers so a gate evaluator can count
# unexplained failures without Workers Observability. Listing uses the
# Cloudflare HTTP API — the wrangler CLI has no object-listing command — and
# reuses the --d1 credentials; without them the listing is skipped with a
# note. A marker carrying the manifest's own attempt id is an anomaly: the
# attempt that produced this manifest cannot also have failed.
#
# Usage:
#   bash scripts/verify-analytics-extract.sh <manifest-object-key> [--d1]
#
# Example (morning slot):
#   raw/cloudflare/checkins/manifests/extraction_date=2026-08-15/030000.json
# Example (afternoon slot):
#   raw/cloudflare/checkins/manifests/extraction_date=2026-08-15/150000.json
#
# --d1 additionally runs a live as-of count against D1, bounded by the
# manifest's extraction_timestamp, and compares it to the same three numbers.
# That makes this script usable on a historical slot, instead of the as-of
# count having to be run by hand. It is opt-in because it needs D1 credentials;
# the default path needs none.
#
# The as-of count is reconstructed from current table state, so it assumes no
# rows were deleted or edited since extraction — it cannot detect a row mutated
# in place afterwards.
#
# It can also report a false mismatch for an extract that was correct when it
# was taken. Two reasons, both issue #62: submitted_at/created_at are stamped at
# request start rather than at commit, so a submission in flight across the
# export can carry a timestamp inside the watermark while committing after the
# export read it; and checkin_response is exported unbounded (it has no
# immutable creation column — bounding on the mutable submitted_at would drop
# re-answered responses), so a response written mid-run lands in the slot while
# falling outside this as-of query. Check for both before treating a --d1
# mismatch of one or two rows as a real failure.
#
# Requires: wrangler (authenticated), jq, gunzip. Uses remote R2 unless --local is
# passed through WRANGLER_R2_FLAGS.
#
# --d1 additionally requires curl, CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID. It goes to the D1 HTTP API rather than
# `wrangler d1 execute` because the checked-in wrangler.toml carries a
# placeholder production database_id (substituted at deploy time), so wrangler
# cannot resolve the production database from a working copy. Set
# D1_DATABASE_ID to skip the name lookup; D1_DATABASE (default: checkin) names
# the database otherwise.
#
# The _status/ marker listing uses the same two variables against the R2 HTTP
# API (GET .../r2/buckets/<bucket>/objects?prefix=...) and runs whenever they
# are set, with or without --d1. The token therefore also needs read access to
# the R2 bucket — a D1-only token lists nothing and fails the run, loudly,
# rather than silently reporting no markers.

MANIFEST_KEY="${1:?Usage: verify-analytics-extract.sh <manifest-object-key> [--d1]}"
shift || true

CHECK_D1=0
for arg in "$@"; do
  case "$arg" in
    --d1) CHECK_D1=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

BUCKET="${ANALYTICS_R2_BUCKET:-checkin-analytics}"
WRANGLER_R2_FLAGS="${WRANGLER_R2_FLAGS:-}"
D1_DATABASE="${D1_DATABASE:-checkin}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

wrangler r2 object get "${BUCKET}/${MANIFEST_KEY}" --file "$TMP/manifest.json" ${WRANGLER_R2_FLAGS}

EXTRACTION_TIMESTAMP=$(jq -r '.extraction_timestamp' "$TMP/manifest.json")
# The manifest version is classified entirely in jq, and the shell only compares
# the resulting label. Every step of this has to happen before the value reaches
# bash:
#   - `.manifest_version // 1` would default an explicit null or false to 1, and
#     -r renders the string "1" identically to the number 1, so a malformed
#     manifest would look absent and take the legacy path.
#   - `[ "$v" -ge 2 ]` is bounded by the shell's signed integer range. An
#     all-digit version too large for it (9999999999999999999) makes both the
#     range test and the >= 2 test error out rather than fail; inside an `if`
#     condition that is not fatal even under `set -e`, so the version would fall
#     through to legacy and skip the source-count requirement.
# An absent version means 1. A present one must be an integer >= 1. Version 1 is
# legacy (manifest-to-JSONL only); every version from 2 up promises
# source_row_count and is required to carry it.
MANIFEST_VERSION_INFO=$(jq -r '
  if (has("manifest_version") | not) then "legacy 1"
  elif (.manifest_version | type) != "number" then "invalid " + (.manifest_version | type)
  elif (.manifest_version | floor) != .manifest_version then "invalid non-integer"
  elif .manifest_version < 1 then "invalid out-of-range"
  elif .manifest_version < 2 then "legacy " + (.manifest_version | tostring)
  else "strict " + (.manifest_version | tostring)
  end' "$TMP/manifest.json")

MANIFEST_VERSION_CLASS="${MANIFEST_VERSION_INFO%% *}"
MANIFEST_VERSION="${MANIFEST_VERSION_INFO#* }"

if [ "$MANIFEST_VERSION_CLASS" = "invalid" ]; then
  echo "unsupported manifest_version: ${MANIFEST_VERSION}" >&2
  exit 1
fi
PROMPT_KEY=$(jq -r '.tables.checkin_prompt.object_key' "$TMP/manifest.json")
RESPONSE_KEY=$(jq -r '.tables.checkin_response.object_key' "$TMP/manifest.json")

# attempt_id gets the same jq discipline as the version and counts: jq -r
# renders non-strings identically to strings, so the classification happens
# before the value reaches bash. "absent" is legal only below version 3;
# a declared version promises the field.
# The version-3-or-later question is decided in jq for the same reason as the
# version itself: bash `[ ... -ge 3 ]` on a huge declared version can overflow
# and skip the check silently. "absent_strict" means missing on a version that
# promised it; "absent" means a pre-3 artifact, which legitimately lacks it.
ATTEMPT_INFO=$(jq -r '
  if (has("attempt_id") | not) then
    (if ((.manifest_version // 1) >= 3) then "absent_strict" else "absent" end)
  elif (.attempt_id | type) != "string" then "invalid " + (.attempt_id | type)
  elif (.attempt_id | length) == 0 then "invalid empty"
  else "present " + .attempt_id
  end' "$TMP/manifest.json")
ATTEMPT_CLASS="${ATTEMPT_INFO%% *}"
MANIFEST_ATTEMPT="${ATTEMPT_INFO#* }"
if [ "$ATTEMPT_CLASS" = "invalid" ]; then
  echo "attempt_id is not a non-empty string: ${MANIFEST_ATTEMPT}" >&2
  exit 1
fi

# Counts are validated as JSON before they are read, for the same reason as the
# version: `jq -r` renders the string "1" identically to the number 1, so a
# manifest with string-encoded counts would sail through the three-way
# comparison. Missing is only legal for source_row_count, and is reported as
# "absent" rather than defaulted, so the version gate decides what it means.
count_field() {
  local table="$1" field="$2" allow_absent="$3"
  jq -r --arg table "$table" --arg field "$field" --arg absent "$allow_absent" '
    .tables[$table][$field] as $value
    | if $value == null then (if $absent == "yes" then "absent" else "invalid missing" end)
      elif ($value | type) != "number" then "invalid " + ($value | type)
      elif ($value | floor) != $value then "invalid non-integer"
      elif $value < 0 then "invalid negative"
      else ($value | tostring)
      end' "$TMP/manifest.json"
}

read_count() {
  local table="$1" field="$2" allow_absent="$3" value
  value=$(count_field "$table" "$field" "$allow_absent")
  case "$value" in
    invalid*)
      echo "${table}.${field} is not a non-negative integer: ${value#invalid }" >&2
      exit 1
      ;;
  esac
  echo "$value"
}

EXPECTED_PROMPT=$(read_count checkin_prompt row_count no)
EXPECTED_RESPONSE=$(read_count checkin_response row_count no)
SOURCE_PROMPT=$(read_count checkin_prompt source_row_count yes)
SOURCE_RESPONSE=$(read_count checkin_response source_row_count yes)

wrangler r2 object get "${BUCKET}/${PROMPT_KEY}" --file "$TMP/prompt.jsonl.gz" ${WRANGLER_R2_FLAGS}
wrangler r2 object get "${BUCKET}/${RESPONSE_KEY}" --file "$TMP/response.jsonl.gz" ${WRANGLER_R2_FLAGS}

# Decompress fully and check gzip's own exit status before counting. A gzip
# object truncated after its payload but before its trailer emits every row and
# *then* fails; piping straight into `grep -c '^' || true` discarded that status
# and returned the expected line count, so the verifier could certify exactly the
# corrupt upload this check exists to catch. `|| true` was there because grep -c
# exits 1 on a zero count, so the two failures have to be told apart rather than
# both swallowed.
# Decompress to a file, then count from that file. gunzip is the only authority
# on whether the object is intact, and the count comes from the bytes it wrote.
# Three traps this shape avoids, each of which certified a broken object:
#   - `gunzip -c ... | grep -c '^' || true` discards gzip's exit status, so an
#     object truncated after its payload but before its trailer emits every row,
#     fails, and is still reported as a clean count.
#   - `text=$(gunzip -c ...)` fixes that but strips every trailing newline, so a
#     malformed object ending in a blank line counts one row short and ties back
#     cleanly against a manifest that agrees with the short count.
#   - Short-circuiting a zero-byte *compressed* object to 0 skips gunzip
#     entirely. Zero bytes is never a valid gzip stream: the worker's empty
#     export is gzip of an empty string, which is a valid ~20-byte object. So a
#     zero-byte object is always a failed upload, and the emptiness test belongs
#     on the decompressed output rather than the object.
count_jsonl_lines() {
  local file="$1" decompressed="$2"
  if ! gunzip -c "$file" > "$decompressed"; then
    return 1
  fi
  if [ ! -s "$decompressed" ]; then
    echo 0
    return
  fi
  grep -c '^' "$decompressed"
}

if ! PROMPT_LINES=$(count_jsonl_lines "$TMP/prompt.jsonl.gz" "$TMP/prompt.jsonl"); then
  echo "checkin_prompt object failed to decompress (truncated or corrupt)" >&2
  exit 1
fi
if ! RESPONSE_LINES=$(count_jsonl_lines "$TMP/response.jsonl.gz" "$TMP/response.jsonl"); then
  echo "checkin_response object failed to decompress (truncated or corrupt)" >&2
  exit 1
fi

FAILED=0
LEGACY=0

report_fail() {
  echo "$1" >&2
  FAILED=1
}

check_table() {
  local table="$1" manifest_count="$2" jsonl_lines="$3" source_count="$4"

  if [ "$jsonl_lines" != "$manifest_count" ]; then
    report_fail "${table} count mismatch: manifest=${manifest_count} jsonl=${jsonl_lines}"
  fi

  if [ "$source_count" = "absent" ]; then
    # Only a version 1 manifest is allowed to lack the source count. A manifest
    # declaring version 2 or later promises the tie-back, so a missing field
    # there is a broken artifact, not a legacy one. The comparison was made in
    # jq; this is a string test, so no version can slip past on integer range.
    if [ "$MANIFEST_VERSION_CLASS" = "strict" ]; then
      report_fail "${table} manifest declares manifest_version ${MANIFEST_VERSION} but has no source_row_count"
      return
    fi
    echo "${table}: no source_row_count in manifest (manifest_version ${MANIFEST_VERSION}) — manifest-to-jsonl check only"
    LEGACY=1
    return
  fi

  if [ "$source_count" != "$manifest_count" ]; then
    report_fail "${table} source count mismatch: source=${source_count} manifest=${manifest_count}"
  fi

  if [ "$source_count" != "$jsonl_lines" ]; then
    report_fail "${table} source count mismatch: source=${source_count} jsonl=${jsonl_lines}"
  fi
}

check_table checkin_prompt "$EXPECTED_PROMPT" "$PROMPT_LINES" "$SOURCE_PROMPT"
check_table checkin_response "$EXPECTED_RESPONSE" "$RESPONSE_LINES" "$SOURCE_RESPONSE"

# Attempt-id comparison. Rows without the field and rows carrying a different
# id than the manifest both fail; an empty object carries no stamp and cannot
# contradict the manifest.
check_table_attempts() {
  local table="$1" jsonl_file="$2" id missing
  missing=$(jq -c 'select(.attempt_id == null)' "$jsonl_file" | wc -l)
  if [ "$missing" -gt 0 ]; then
    report_fail "${table}: ${missing} row(s) without attempt_id (manifest certifies ${MANIFEST_ATTEMPT})"
  fi
  while IFS= read -r id; do
    if [ "$id" != "$MANIFEST_ATTEMPT" ]; then
      report_fail "${table} attempt_id mismatch: object carries ${id}, manifest certifies ${MANIFEST_ATTEMPT}"
    fi
  done < <(jq -r 'select(.attempt_id != null) | .attempt_id' "$jsonl_file" | sort -u)
}

case "$ATTEMPT_CLASS" in
  absent_strict)
    report_fail "manifest declares manifest_version ${MANIFEST_VERSION} but has no attempt_id" ;;
  absent)
    echo "no attempt_id in manifest (manifest_version ${MANIFEST_VERSION}) — attempt-id check skipped" ;;
  *)
    check_table_attempts checkin_prompt "$TMP/prompt.jsonl"
    check_table_attempts checkin_response "$TMP/response.jsonl" ;;
esac

d1_api() {
  local path="$1"
  shift
  curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
    "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/d1/database${path}" "$@"
}

# Filter by name server-side rather than listing and matching locally: the list
# endpoint paginates, so on an account with more databases than fit on one page
# a local match would report "could not resolve" for a database that exists.
resolve_d1_database_id() {
  if [ -n "${D1_DATABASE_ID:-}" ]; then
    echo "$D1_DATABASE_ID"
    return
  fi
  d1_api "?name=${D1_DATABASE}" | jq -r --arg name "$D1_DATABASE" \
    '.result[]? | select(.name == $name) | .uuid' | head -n 1
}

# The watermark is bound as a query parameter, never interpolated into the SQL.
# It comes out of a manifest in R2 — data this script reads, not a value it
# controls — so a corrupted or separately writable manifest carrying something
# like `x' OR 1=1 --` would otherwise rewrite the predicate and have the as-of
# check certify a count for the whole table. The format is also validated, so a
# manifest with a mangled timestamp fails loudly instead of silently comparing
# against a value that sorts unexpectedly.
d1_count() {
  local database_id="$1" table="$2" column="$3"
  d1_api "/${database_id}/query" \
    -X POST -H "Content-Type: application/json" \
    --data "$(jq -n \
      --arg sql "SELECT COUNT(*) AS row_count FROM ${table} WHERE ${column} <= ?" \
      --arg watermark "$EXTRACTION_TIMESTAMP" \
      '{sql: $sql, params: [$watermark]}')" \
    | jq -r '.result[0].results[0].row_count // empty'
}

# Values are passed as separate quoted arguments rather than packed into one
# whitespace-separated string: d1_count yields an empty value when the API
# returns an error envelope, and word-splitting such a string would drop that
# field, shift every later one, and abort under `set -u` before the
# "count unavailable" branch below could report the real problem.
check_d1_table() {
  local table="$1" d1="$2" manifest_count="$3" jsonl_lines="$4" source_count="$5"

  if [ -z "$d1" ] || [ "$d1" = "null" ]; then
    report_fail "${table} d1 as-of count unavailable (check CLOUDFLARE_API_TOKEN and database access)"
    return
  fi

  if [ "$d1" != "$manifest_count" ] || [ "$d1" != "$jsonl_lines" ]; then
    report_fail "${table} d1 as-of mismatch: d1=${d1} manifest=${manifest_count} jsonl=${jsonl_lines}"
    return
  fi

  if [ "$source_count" != "absent" ] && [ "$d1" != "$source_count" ]; then
    report_fail "${table} d1 as-of mismatch: d1=${d1} source=${source_count}"
    return
  fi

  echo "${table}: d1 as-of=${d1} ok"
}

if [ "$CHECK_D1" = "1" ]; then
  : "${CLOUDFLARE_API_TOKEN:?--d1 requires CLOUDFLARE_API_TOKEN}"
  : "${CLOUDFLARE_ACCOUNT_ID:?--d1 requires CLOUDFLARE_ACCOUNT_ID}"

  # Canonical ISO-8601 UTC, as the worker writes it. Binding already stops the
  # value reaching SQL as code; this stops a mangled one being compared as data.
  # Shape alone is not enough: 9999-99-99T99:99:99.999Z matches any digit-wise
  # pattern, and compared lexicographically it sorts after every real timestamp,
  # so it would count the whole table and report a clean tie-back for an instant
  # that does not exist. The value is round-tripped through jq's strptime/mktime
  # so a calendar-invalid date normalises to something different and is caught
  # (2026-02-31 -> 2026-03-03, and 2026-02-29 fails while 2024-02-29 passes).
  # jq rather than `date -d`, which is GNU-only and absent on macOS.
  TIMESTAMP_CHECK=$(jq -rn --arg ts "$EXTRACTION_TIMESTAMP" '
    if ($ts | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$") | not)
    then "invalid-shape"
    else
      ($ts | sub("\\.[0-9]{3}Z$"; "Z")) as $secs
      | (try ($secs | strptime("%Y-%m-%dT%H:%M:%SZ") | mktime | strftime("%Y-%m-%dT%H:%M:%SZ"))
         catch "unparseable")
      | if . == $secs then "valid" else "invalid-calendar" end
    end')

  if [ "$TIMESTAMP_CHECK" != "valid" ]; then
    echo "manifest extraction_timestamp is not a valid ISO-8601 UTC instant (${TIMESTAMP_CHECK}): ${EXTRACTION_TIMESTAMP}" >&2
    exit 1
  fi

  DATABASE_ID=$(resolve_d1_database_id)
  if [ -z "$DATABASE_ID" ]; then
    echo "could not resolve D1 database '${D1_DATABASE}'" >&2
    exit 1
  fi

  echo "as-of D1 counts at ${EXTRACTION_TIMESTAMP} (assumes no deletes or in-place edits since)"
  D1_PROMPT=$(d1_count "$DATABASE_ID" checkin_prompt created_at)
  D1_RESPONSE=$(d1_count "$DATABASE_ID" checkin_response submitted_at)

  check_d1_table checkin_prompt "$D1_PROMPT" "$EXPECTED_PROMPT" "$PROMPT_LINES" "$SOURCE_PROMPT"
  check_d1_table checkin_response "$D1_RESPONSE" "$EXPECTED_RESPONSE" "$RESPONSE_LINES" "$SOURCE_RESPONSE"
fi

# _status/ marker listing for this slot. The manifest key carries the slot
# (extraction_date + HHMMSS); markers for it share the prefix
# _status/extraction_date=<date>/<HHMMSS>-<attempt>.json. Marker presence is
# reported, not failed — the gate counts *unexplained* failures, which is a
# human read of the markers. A marker naming the manifest's own attempt fails,
# though: the attempt that wrote this manifest cannot also have failed.
SLOT_DATE=$(printf '%s' "$MANIFEST_KEY" | sed -n 's|.*extraction_date=\([0-9-]\{10\}\)/.*|\1|p')
SLOT_TIME=$(printf '%s' "$MANIFEST_KEY" | sed -n 's|.*/\([0-9]\{6\}\)\.json$|\1|p')

if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  if [ -z "$SLOT_DATE" ] || [ -z "$SLOT_TIME" ]; then
    echo "could not parse slot from manifest key: ${MANIFEST_KEY}" >&2
    exit 1
  fi
  STATUS_PREFIX="raw/cloudflare/checkins/_status/extraction_date=${SLOT_DATE}/${SLOT_TIME}-"
  STATUS_CURSOR=""
  STATUS_FOUND=0
  while : ; do
    QUERY="prefix=${STATUS_PREFIX}"
    if [ -n "$STATUS_CURSOR" ]; then
      QUERY="${QUERY}&cursor=${STATUS_CURSOR}"
    fi
    STATUS_PAGE=$(curl -sS -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
      "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/r2/buckets/${BUCKET}/objects?${QUERY}")
    # An API error must fail loudly: silently reporting "no markers" would
    # recreate exactly the unevaluable-evidence gap this check exists to close.
    if [ "$(printf '%s' "$STATUS_PAGE" | jq -r '.success // false')" != "true" ]; then
      echo "R2 object listing failed for ${STATUS_PREFIX}: $(printf '%s' "$STATUS_PAGE" | jq -c '.errors // .')" >&2
      exit 1
    fi
    while IFS= read -r key; do
      [ -z "$key" ] && continue
      STATUS_FOUND=$((STATUS_FOUND + 1))
      key_attempt="${key#"${STATUS_PREFIX}"}"
      key_attempt="${key_attempt%.json}"
      if [ "$ATTEMPT_CLASS" = "present" ] && [ "$key_attempt" = "$MANIFEST_ATTEMPT" ]; then
        report_fail "_status marker ${key} carries this manifest's own attempt id"
      else
        echo "_status marker: ${key}"
      fi
    done < <(printf '%s' "$STATUS_PAGE" | jq -r '.result[]?.key // empty')
    if [ "$(printf '%s' "$STATUS_PAGE" | jq -r '.result_info.is_truncated // false')" != "true" ]; then
      break
    fi
    STATUS_CURSOR=$(printf '%s' "$STATUS_PAGE" | jq -r '.result_info.cursor // empty')
    # A truncated page with no cursor would re-fetch the same page forever.
    if [ -z "$STATUS_CURSOR" ]; then
      echo "R2 object listing truncated but returned no cursor" >&2
      exit 1
    fi
  done
  if [ "$STATUS_FOUND" = "0" ]; then
    echo "no _status/ markers for this slot"
  fi
else
  echo "_status/ marker listing skipped (set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to enable)"
fi

if [ "$FAILED" != "0" ]; then
  exit 1
fi

if [ "$LEGACY" = "1" ]; then
  echo "tie-back ok (manifest=jsonl only, no source count): prompt=${PROMPT_LINES} response=${RESPONSE_LINES} manifest=${MANIFEST_KEY}"
else
  echo "tie-back ok (source=manifest=jsonl): prompt=${PROMPT_LINES} response=${RESPONSE_LINES} manifest=${MANIFEST_KEY}"
fi
