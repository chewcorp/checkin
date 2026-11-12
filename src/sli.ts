import { parseBearerToken } from "./export";
import { HealthFactsEnv, loadHealthFacts } from "./health-facts";
import {
  AnswerReading,
  ExtractFacts,
  ExtractReading,
  HealthStrip,
  LondonDateWindow,
  addCivilDays,
  assessHealth,
  parsePromptDateKey,
} from "./health-strip";

declare const positiveCount: unique symbol;

export type PositiveCount = number & { readonly [positiveCount]: "PositiveCount" };

export type AbsentCoverage = {
  readonly window: LondonDateWindow;
  readonly answer: Extract<AnswerReading, { kind: "absent" }>;
  readonly failed: null | PositiveCount;
};

export type MeasuredCoverage = {
  readonly window: LondonDateWindow;
  readonly answer: Extract<AnswerReading, { kind: "measured" }>;
  readonly failed: number;
};

export type SliCoverage = AbsentCoverage | MeasuredCoverage;

export type SliExtract =
  | ExtractReading
  | { readonly kind: "error"; readonly reason: "manifest_missing" };

export type SliBody = {
  readonly coverage: SliCoverage;
  readonly recency: string | null;
  readonly extract: SliExtract;
};

export type SliSource = HealthFactsEnv & {
  readonly SLI_BEARER_TOKEN?: string;
};

const SLI_JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "private, no-store",
  "x-content-type-options": "nosniff",
} as const;

async function authorizeSli(
  request: Request,
  expectedToken: string | undefined,
): Promise<boolean> {
  if (!expectedToken) {
    return false;
  }
  const presented = parseBearerToken(request);
  if (!presented) {
    return false;
  }
  const encoder = new TextEncoder();
  // SHA-256 both sides so timingSafeEqual always sees two 32-byte digests.
  const [presentedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(presented)),
    crypto.subtle.digest("SHA-256", encoder.encode(expectedToken)),
  ]);
  return crypto.subtle.timingSafeEqual(presentedHash, expectedHash);
}

async function latestSubmittedAt(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT MAX(submitted_at) AS latest_submitted_at FROM checkin_response`,
    )
    .first<{ latest_submitted_at: string | null }>();
  return row?.latest_submitted_at ?? null;
}

async function countFailedInWindow(
  db: D1Database,
  window: LondonDateWindow,
): Promise<number> {
  const result = await db
    .prepare(
      `SELECT id FROM checkin_prompt
       WHERE status = 'failed' AND id >= ? AND id < ?`,
    )
    .bind(`prompt-${window.start}`, `prompt-${addCivilDays(window.end, 1)}`)
    .all<{ id: string }>();
  let count = 0;
  for (const row of result.results ?? []) {
    const dateKey = parsePromptDateKey(row.id);
    if (!dateKey || dateKey < window.start || dateKey > window.end) {
      continue;
    }
    count += 1;
  }
  return count;
}

function recentManifestMissing(extract: ExtractFacts): boolean {
  return extract.kind === "bucket" && extract.manifests.length === 0;
}

function sliBody(
  strip: HealthStrip,
  failedCount: number,
  latest: string | null,
): SliBody {
  if (!Number.isInteger(failedCount) || failedCount < 0) {
    throw new Error("failed count must be a non-negative integer");
  }
  if (strip.answer.kind === "absent") {
    const coverage: AbsentCoverage = {
      window: strip.window,
      answer: strip.answer,
      failed: failedCount === 0 ? null : (failedCount as PositiveCount),
    };
    return { coverage, recency: latest, extract: strip.extract };
  }
  const coverage: MeasuredCoverage = {
    window: strip.window,
    answer: strip.answer,
    failed: failedCount,
  };
  return { coverage, recency: latest, extract: strip.extract };
}

export async function handleSli(
  request: Request,
  source: SliSource,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (!(await authorizeSli(request, source.SLI_BEARER_TOKEN))) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();
  const [facts, recency] = await Promise.all([
    loadHealthFacts(
      { DB: source.DB, EXTRACT_BUCKET: source.EXTRACT_BUCKET },
      now,
      { walk: false },
    ),
    latestSubmittedAt(source.DB),
  ]);
  const strip = assessHealth(facts);
  const failedCount = await countFailedInWindow(source.DB, strip.window);
  const document = sliBody(strip, failedCount, recency);
  const body = recentManifestMissing(facts.extract)
    ? { ...document, extract: { kind: "error" as const, reason: "manifest_missing" as const } }
    : document;
  return new Response(JSON.stringify(body), {
    headers: SLI_JSON_HEADERS,
  });
}
