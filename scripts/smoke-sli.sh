#!/usr/bin/env bash
set -euo pipefail

if [ -z "${BASE_URL:-}" ]; then
  echo "BASE_URL is required" >&2
  exit 1
fi
if [ -z "${SLI_BEARER_TOKEN:-}" ]; then
  echo "SLI_BEARER_TOKEN is required" >&2
  exit 1
fi
if [ -z "${EXPORT_BEARER_TOKEN:-}" ]; then
  echo "EXPORT_BEARER_TOKEN is required" >&2
  exit 1
fi

tmp="$(mktemp)"
hdr="$(mktemp)"
trap 'rm -f "$tmp" "$hdr"' EXIT

status="$(
  curl -sS --retry 5 --retry-delay 3 \
    -D "$hdr" \
    -o "$tmp" -w '%{http_code}' \
    -H "Authorization: Bearer ${SLI_BEARER_TOKEN}" \
    "${BASE_URL%/}/api/sli"
)"

echo "http_status=${status}"
if [ "$status" != "200" ]; then
  echo "expected HTTP 200 from /api/sli" >&2
  exit 1
fi

content_type="$(grep -i '^content-type:' "$hdr" | tail -1 | tr -d '\r' || true)"
case "$(printf '%s' "$content_type" | tr '[:upper:]' '[:lower:]')" in
  *application/json*) ;;
  *)
    echo "expected application/json from /api/sli" >&2
    exit 1
    ;;
esac

python3 - "$tmp" <<'PY'
import json
import os
import sys
from pathlib import Path

body = Path(sys.argv[1]).read_text(encoding="utf-8")
token = os.environ["SLI_BEARER_TOKEN"]
if token and token in body:
    print("token_in_body=yes", file=sys.stderr)
    sys.exit("SLI_BEARER_TOKEN leaked into JSON")

for needle in ('"feeling"', '"note"', '"prompt_id"'):
    if needle in body:
        sys.exit(f"forbidden substring {needle}")

try:
    data = json.loads(body)
except json.JSONDecodeError:
    sys.exit("response body is not json")

coverage = data.get("coverage") if isinstance(data, dict) else None
if not isinstance(coverage, dict):
    sys.exit("coverage missing")
answer = coverage.get("answer")
window = coverage.get("window")
extract = data.get("extract")
if not isinstance(answer, dict) or not isinstance(window, dict) or not isinstance(extract, dict):
    sys.exit("sli shape missing")

answer_kind = answer.get("kind")
extract_kind = extract.get("kind")
day_count = window.get("dayCount")
failed = coverage.get("failed")
recency = data.get("recency")

print(f"answer_kind={answer_kind}")
print(f"failed_null={'yes' if failed is None else 'no'}")
print(f"recency_null={'yes' if recency is None else 'no'}")
print(f"extract_kind={extract_kind}")
print(f"window_day_count={day_count}")
print("token_in_body=no")

errors: list[str] = []
if answer_kind not in {"absent", "measured"}:
    errors.append("answer kind missing")
if extract_kind not in {"absent", "unreadable", "landed"}:
    errors.append("extract kind missing")
if day_count != 14:
    errors.append("window day count must be 14")
if "failed" not in coverage:
    errors.append("failed missing")
if "recency" not in data:
    errors.append("recency missing")
if errors:
    print("smoke_failed=", "; ".join(errors), file=sys.stderr)
    sys.exit(1)
PY

export_status="$(
  curl -sS --retry 5 --retry-delay 3 \
    -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer ${EXPORT_BEARER_TOKEN}" \
    "${BASE_URL%/}/api/sli"
)"
echo "export_bearer_status=${export_status}"
if [ "$export_status" != "401" ]; then
  echo "expected HTTP 401 from /api/sli with EXPORT_BEARER_TOKEN" >&2
  exit 1
fi
