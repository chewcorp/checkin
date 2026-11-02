import { runAnswerRateAlert } from "./answer-rate-alert";
import {
  renderCheckinPage,
  renderDeclinedPage,
  renderManualCheckinPage,
  renderRecordedPage,
} from "./checkin-page";
import {
  AnalyticsExtractError,
  runAnalyticsExtract,
  writeExtractFailureMarker,
} from "./analytics-extract";
import {
  authorizeExport,
  authorizeReport,
  REPORT_AUTH_CHALLENGE,
  parseExportQuery,
  serializeResponses,
} from "./export";
import { loadHealthFacts } from "./health-facts";
import { assessHealth, renderHealthStrip } from "./health-strip";
import { log } from "./logger";
import { NoopNotifier, Notifier, PushoverNotifier } from "./notifier";
import { recordDecline, recordManualResponse, recordResponse } from "./record-response";
import { runScheduler, SchedulerEnv } from "./scheduler";
import { getPromptByToken, listResponses } from "./store";
import { runWeeklySummary } from "./weekly-summary";

export interface Env extends SchedulerEnv {
  PUSHOVER_TOKEN?: string;
  PUSHOVER_USER?: string;
  EXPORT_BEARER_TOKEN?: string;
  EXTRACT_BUCKET?: R2Bucket;
}

function buildNotifier(env: Env): Notifier {
  if (env.PUSHOVER_TOKEN && env.PUSHOVER_USER) {
    return new PushoverNotifier(env.PUSHOVER_TOKEN, env.PUSHOVER_USER);
  }
  return new NoopNotifier();
}

async function handleExportResponses(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!authorizeExport(request, env.EXPORT_BEARER_TOKEN)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const query = parseExportQuery(url);
  if ("error" in query) {
    return new Response(query.error, { status: 400 });
  }

  const rows = await listResponses(env.DB, query.from, query.to);
  log("info", "responses_exported", { count: rows.length });
  return new Response(serializeResponses(rows), {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

async function handleCheckinToken(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const prompt = await getPromptByToken(env.DB, token);
  if (!prompt) {
    return new Response("Not found", { status: 404 });
  }

  const now = new Date();

  if (request.method === "GET") {
    return new Response(renderCheckinPage(prompt, now), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const payload = (await request.json()) as {
    decline?: boolean;
    feeling?: string;
    intensity?: number;
    note?: string;
    confidence?: string | null;
    vocab_era?: string | null;
  };

  if (payload.decline === true) {
    const declined = await recordDecline(env.DB, { token, now });
    if (!declined.ok) {
      const status = declined.reason === "not_found" ? 404 : 400;
      return new Response("Unavailable", { status });
    }
    return new Response(renderDeclinedPage(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (!payload.feeling || payload.intensity === undefined) {
    return new Response("Invalid request", { status: 400 });
  }

  const result = await recordResponse(env.DB, {
    token,
    feeling: payload.feeling,
    intensity: Number(payload.intensity),
    note: payload.note,
    confidence: payload.confidence,
    vocabEra: payload.vocab_era,
    now,
  });

  if (!result.ok) {
    const status = result.reason === "not_found" ? 404 : 400;
    return new Response("Unavailable", { status });
  }

  return new Response(renderRecordedPage(), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

function redirectToHttpsIfNeeded(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.protocol === "http:" && !LOCAL_HOSTNAMES.has(url.hostname)) {
    url.protocol = "https:";
    return Response.redirect(url.toString(), 308);
  }
  return null;
}

const AUTHENTICATED_HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
};

async function handleManualCheckin(request: Request, env: Env): Promise<Response> {
  const redirected = redirectToHttpsIfNeeded(request);
  if (redirected) {
    return redirected;
  }

  if (!authorizeReport(request, env.EXPORT_BEARER_TOKEN)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": REPORT_AUTH_CHALLENGE },
    });
  }

  const now = new Date();

  if (request.method === "GET") {
    return new Response(renderManualCheckinPage(now), {
      headers: AUTHENTICATED_HTML_HEADERS,
    });
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let payload: {
    feeling?: string;
    intensity?: number;
    note?: string;
    confidence?: string | null;
    vocab_era?: string | null;
    observed_at?: string;
  };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return new Response("Invalid request", { status: 400 });
  }

  if (!payload.feeling || payload.intensity === undefined || !payload.observed_at) {
    return new Response("Invalid request", { status: 400 });
  }

  const result = await recordManualResponse(env.DB, {
    feeling: payload.feeling,
    intensity: Number(payload.intensity),
    note: payload.note,
    confidence: payload.confidence,
    vocabEra: payload.vocab_era,
    observedAt: String(payload.observed_at),
    now,
  });

  if (!result.ok) {
    const message =
      result.reason === "out_of_range" ? "observed_at out of range" : "Invalid request";
    return new Response(message, { status: 400 });
  }

  return new Response(renderRecordedPage(), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

async function handleReport(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const redirected = redirectToHttpsIfNeeded(request);
  if (redirected) {
    return redirected;
  }

  if (!authorizeReport(request, env.EXPORT_BEARER_TOKEN)) {
    return new Response("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": REPORT_AUTH_CHALLENGE },
    });
  }

  const now = new Date();
  const facts = await loadHealthFacts(
    { DB: env.DB, EXTRACT_BUCKET: env.EXTRACT_BUCKET },
    now,
  );
  const strip = assessHealth(facts);
  return new Response(renderHealthStrip(strip), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (url.pathname === "/api/responses") {
      return handleExportResponses(request, env);
    }

    if (url.pathname === "/report") {
      return handleReport(request, env);
    }

    if (url.pathname === "/checkin") {
      return handleManualCheckin(request, env);
    }

    const tokenMatch = url.pathname.match(/^\/c\/([a-f0-9]+)$/);
    if (tokenMatch) {
      return handleCheckinToken(request, env, tokenMatch[1]);
    }

    return new Response("Not Found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const now = new Date();
    log("info", "scheduler_run", {});
    const notifier = buildNotifier(env);
    await runScheduler(env, notifier, now);

    try {
      await runWeeklySummary(env, notifier, now);
    } catch (error) {
      log("error", "weekly_summary_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }

    try {
      await runAnswerRateAlert(env, notifier, now);
    } catch (error) {
      log("error", "answer_rate_alert_failed", {
        error: error instanceof Error ? error.message : "unknown",
      });
    }

    await runAnalyticsExtractGuarded(env, now);
  },
};

/**
 * The extract runs inside its own try/catch so a failure can never take down
 * the rest of the scheduled handler (N1). On failure the catch first writes a
 * durable `_status/` marker to the extract bucket — evidence readable with the
 * same credentials that operate the extract, unlike the log line — then logs
 * `analytics_extract_failed`. A marker write that itself fails is logged and
 * swallowed like every other failure in this path.
 */
export async function runAnalyticsExtractGuarded(env: Env, now: Date): Promise<void> {
  try {
    await runAnalyticsExtract(env, now);
  } catch (error) {
    if (env.EXTRACT_BUCKET && error instanceof AnalyticsExtractError) {
      try {
        await writeExtractFailureMarker(
          env.EXTRACT_BUCKET,
          error.slot,
          error.attemptId,
          error.message,
          now,
        );
      } catch (markerError) {
        log("error", "analytics_extract_marker_write_failed", {
          error: markerError instanceof Error ? markerError.message : "unknown",
        });
      }
    }
    log("error", "analytics_extract_failed", {
      error: error instanceof Error ? error.message : "unknown",
      ...(error instanceof AnalyticsExtractError
        ? { attempt_id: error.attemptId }
        : {}),
    });
  }
}
