# Deploy

Automated deploy to Cloudflare on every push to `main`. Routine releases do not require a local `wrangler deploy`.

## One-time setup

### 1. Cloudflare D1

Create the database once (Cloudflare dashboard or CLI with a personal token):

```bash
npx wrangler login   # local only for this one-time step
npx wrangler d1 create checkin
```

Copy the returned **database ID** into the GitHub repository variable `CLOUDFLARE_D1_DATABASE_ID`.

### 2. Analytics extract bucket (R2)

**Enable R2 on the account first** — Cloudflare dashboard → **R2** → follow the
onboarding prompt. Deploy fails with `Please enable R2 through the Cloudflare
Dashboard [code: 10042]` until this is done. Adding **Workers R2 Storage → Edit**
to the API token is not sufficient on its own.

Create the bucket once for daily D1 snapshots (issue #14):

```bash
npx wrangler r2 bucket create checkin-analytics
```

The Worker binds this bucket as `EXTRACT_BUCKET` in `wrangler.toml`. No new Worker secrets are required — the binding uses the deploy token's R2 permissions.

### 3. Pushover

Create a Pushover application at [pushover.net](https://pushover.net/) and note:

- Application API token → GitHub secret `PUSHOVER_TOKEN`
- User key → GitHub secret `PUSHOVER_USER`

### 4. Export bearer token

Generate a long random token for `/api/responses`, `/report`, and `/checkin`:

```bash
openssl rand -hex 32
```

Store as GitHub secret `EXPORT_BEARER_TOKEN`.

### 5. SLI bearer token

Generate a second value for `GET /api/sli`:

```bash
openssl rand -hex 32
```

Store it as GitHub secret `SLI_BEARER_TOKEN`.

`EXPORT_BEARER_TOKEN` does not open `/api/sli`. `SLI_BEARER_TOKEN` does not open `/api/responses`, `/report`, or `/checkin`.

### 6. Cloudflare API token

Create an API token with at least:

- Account → Cloudflare Workers Scripts → Edit
- Account → D1 → Edit
- Account → R2 → Edit
- Account → Account Settings → Read

Store as GitHub secret `CLOUDFLARE_API_TOKEN`. Store your account ID as `CLOUDFLARE_ACCOUNT_ID`.

### 7. Production URL

After the first successful deploy, set GitHub repository variable:

| Variable | Example |
|----------|---------|
| `BASE_URL` | `https://checkin.<your-subdomain>.workers.dev` |

Re-run the deploy workflow (or push to `main`) if the first deploy ran before `BASE_URL` was set.

## GitHub configuration summary

### Secrets (Settings → Secrets and variables → Actions → Secrets)

| Secret | Purpose |
|--------|---------|
| `CLOUDFLARE_API_TOKEN` | Wrangler deploy and D1 migrations in CI |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account identifier |
| `PUSHOVER_TOKEN` | Pushover application API token (Worker runtime) |
| `PUSHOVER_USER` | Pushover user key (Worker runtime) |
| `EXPORT_BEARER_TOKEN` | Token for `GET /api/responses` (Bearer), `GET /report` (Bearer or Basic password), and `GET/POST /checkin` (Bearer or Basic password). Does not open `GET /api/sli` |
| `SLI_BEARER_TOKEN` | Bearer token for `GET /api/sli` only. Does not open `/api/responses`, `/report`, or `/checkin` |

### Variables (Settings → Secrets and variables → Actions → Variables)

| Variable | Purpose |
|----------|---------|
| `CLOUDFLARE_D1_DATABASE_ID` | D1 database ID from `wrangler d1 create checkin` |
| `BASE_URL` | Public Worker URL (used for Pushover links and deploy smoke test) |

## What CI does on push to `main`

1. Run tests (`scripts/ci-local.sh`)
2. Patch `wrangler.toml` production D1 binding with `CLOUDFLARE_D1_DATABASE_ID`
3. Apply D1 migrations remotely
4. Sync Worker secrets from GitHub secrets
5. `wrangler deploy --env production` with `BASE_URL` var
6. Smoke test `GET $BASE_URL/health`
7. Smoke test `GET $BASE_URL/report` with `EXPORT_BEARER_TOKEN` (Bearer); records window, rate/band or Absent, and extract freshness without logging the token or HTML body
8. Smoke test `GET $BASE_URL/api/sli` with `SLI_BEARER_TOKEN` (Bearer). Confirm HTTP 200 and `application/json`. An empty 7-day lookback is `extract` kind `error` and reason `manifest_missing`, not Absent. A failed recent read stays `unreadable`. Then confirm `EXPORT_BEARER_TOKEN` receives 401. Do not log the token or the raw body.

## Manual smoke test (after first deploy)

```bash
curl "$BASE_URL/health"
# → {"status":"ok"}

curl -H "Authorization: Bearer $EXPORT_BEARER_TOKEN" \
  "$BASE_URL/api/responses"

curl -H "Authorization: Bearer $EXPORT_BEARER_TOKEN" \
  "$BASE_URL/report"
# browser: open /report or /checkin and use any username with EXPORT_BEARER_TOKEN as the password

curl -H "Authorization: Bearer $SLI_BEARER_TOKEN" \
  "$BASE_URL/api/sli"
# empty lookback: HTTP 200, extract {"kind":"error","reason":"manifest_missing"}
# /report still renders Absent and still walks older manifests
```

Confirm a Pushover notification arrives and a check-in completes end-to-end on your phone.

## Local development

Local dev does not use production secrets or deploy settings:

```bash
npm ci
npm run dev
```

Production configuration lives in the `production` Wrangler environment; local defaults use `local-checkin-db` and `http://127.0.0.1:8787`.

## Analytics extract (issue #14)

Daily D1 snapshots land in R2 bucket `checkin-analytics` (see [analytics-extract.md](analytics-extract.md)). After E1 deploy:

1. Ensure the bucket exists (`wrangler r2 bucket create checkin-analytics` — also attempted in deploy workflow).
2. Complete **consumer hookup** per [analytics-consumer.md](analytics-consumer.md): read-only R2 token, import-source prefixes, tie-back verification.
3. Run tie-back on the latest manifest:

```bash
bash scripts/verify-analytics-extract.sh \
  raw/cloudflare/checkins/manifests/extraction_date=YYYY-MM-DD/030000.json
```
