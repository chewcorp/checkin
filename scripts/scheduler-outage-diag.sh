#!/usr/bin/env bash
# Read-only production diagnostics for the Oct 2026 scheduler gap.
# Never writes D1/KV/vars and never deploys. Never prints secret values
# or checkin_prompt.response_token.
set -euo pipefail

OUT="${DIAG_DIR:-/tmp/scheduler-outage-diag}"
mkdir -p "$OUT"
WARGS=(--env production)

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ] || [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required" >&2
  exit 1
fi

run_wrangler() {
  npx wrangler "$@"
}

echo "== wrangler deployments list =="
run_wrangler deployments list "${WARGS[@]}" --json | tee "$OUT/deployments.json"

echo "== wrangler deployments status =="
run_wrangler deployments status "${WARGS[@]}" | tee "$OUT/deployments-status.txt" || true

VERSION_ID=""
if command -v jq >/dev/null 2>&1; then
  VERSION_ID="$(jq -r '
    (if type == "array" then . else [.] end)
    | sort_by(.created_on)
    | last
    | .versions[0].version_id // .version_id // empty
  ' "$OUT/deployments.json" 2>/dev/null || true)"
fi
if [ -z "$VERSION_ID" ] || [ "$VERSION_ID" = "null" ]; then
  VERSION_ID="$(awk '/Version\\(s\\):/ {print $NF; exit}' "$OUT/deployments-status.txt")"
fi

echo "== current version id: ${VERSION_ID:-unknown} =="
if [ -n "${VERSION_ID:-}" ]; then
  echo "== wrangler versions view (bindings/vars; secrets are names only) =="
  run_wrangler versions view "$VERSION_ID" "${WARGS[@]}" --json | tee "$OUT/version.json" || \
    run_wrangler versions view "$VERSION_ID" "${WARGS[@]}" | tee "$OUT/version.txt"
else
  echo "Could not resolve version id; listing versions instead"
  run_wrangler versions list "${WARGS[@]}" --json | tee "$OUT/versions-list.json" || \
    run_wrangler versions list "${WARGS[@]}" | tee "$OUT/versions-list.txt"
fi

echo "== wrangler secret list (names only) =="
run_wrangler secret list "${WARGS[@]}" --format json | tee "$OUT/secret-names.json"

d1() {
  local name="$1"
  local sql="$2"
  echo "== D1: $name =="
  run_wrangler d1 execute checkin --remote "${WARGS[@]}" --json --command "$sql" | tee "$OUT/$name.json"
}

d1 sqlite-master \
  "SELECT name, type FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name"

d1 migrations \
  "SELECT name FROM d1_migrations ORDER BY name"

d1 prompt-status-counts \
  "SELECT status, COUNT(*) AS n FROM checkin_prompt GROUP BY status ORDER BY status"

d1 prompts-by-date \
  "SELECT substr(id, 8, 10) AS date_key, COUNT(*) AS n FROM checkin_prompt GROUP BY date_key ORDER BY date_key"

d1 prompts-from-oct \
  "SELECT id, scheduled_for, sent_at, expires_at, status, created_at
   FROM checkin_prompt
   WHERE id >= 'prompt-2026-10-01'
   ORDER BY id"

d1 latest-prompts \
  "SELECT id, scheduled_for, sent_at, status, created_at
   FROM checkin_prompt
   ORDER BY created_at DESC
   LIMIT 10"

d1 alert-state \
  "SELECT id, notified_status, evaluated_at, answered, sent, rate, window_from, window_to
   FROM checkin_alert_state"

d1 weekly-summary \
  "SELECT id, sent_at FROM weekly_summary ORDER BY id"

d1 responses-from-oct-ids \
  "SELECT id, prompt_id, observed_at, submitted_at
   FROM checkin_response
   WHERE observed_at >= '2026-10-08'
   ORDER BY submitted_at"

echo "== wrangler tail ~16 minutes (one cron interval); best-effort =="
# Do not pass --env production: wrangler 3.x then requests checkin-production
# (API 10007). The production Worker name is checkin.
set +e
timeout 960 npx wrangler tail checkin --format json > "$OUT/tail.jsonl"
TAIL_STATUS=$?
set -e
echo "tail_exit=$TAIL_STATUS" | tee "$OUT/tail-status.txt"
if [ "$TAIL_STATUS" -ne 0 ] && [ "$TAIL_STATUS" -ne 124 ]; then
  echo "wrangler tail failed with status $TAIL_STATUS (often missing observability scope; see checkin#61)"
fi
if [ -s "$OUT/tail.jsonl" ]; then
  echo "== tail event names (no payloads that might include tokens) =="
  if command -v jq >/dev/null 2>&1; then
    jq -r '(.logs // [])[]?.message? // empty, .outcome // empty' "$OUT/tail.jsonl" | head -n 200 || true
  else
    wc -l "$OUT/tail.jsonl"
  fi
fi

echo "== diag complete =="
find "$OUT" -type f | sort
