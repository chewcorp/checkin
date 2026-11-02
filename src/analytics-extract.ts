import { log } from "./logger";
import {
  ExportedPromptRow,
  ExportedResponseRow,
  countAllPromptsForExport,
  countAllResponsesForExport,
  listAllPromptsForExport,
  listAllResponsesForExport,
} from "./store";

/** Daily export slots in UTC — two runs per calendar day, 12 hours apart (D4). */
export const EXPORT_SLOTS_UTC = [
  { hour: 3, minute: 0 },
  { hour: 15, minute: 0 },
] as const;

/** Cron interval — export window matches the scheduled handler cadence. */
export const EXPORT_SLOT_WINDOW_MINUTES = 15;

export interface AnalyticsExtractEnv {
  DB: D1Database;
  EXTRACT_BUCKET?: R2Bucket;
}

/**
 * Manifest schema version. 1 (implicit, absent field) is every manifest written
 * before the independent source-count check; 2 adds `source_row_count`;
 * 3 adds `attempt_id`.
 */
export const EXPORT_MANIFEST_VERSION = 3;

export interface ExportTableManifest {
  /** Rows serialized into the JSONL object. */
  row_count: number;
  /**
   * Rows reported by a separate `SELECT COUNT(*)` against the source table —
   * a different code path from the row fetch, so it can catch a short read the
   * manifest/JSONL comparison cannot. Absent in manifest_version 1 artifacts.
   */
  source_row_count?: number;
  object_key: string;
  /**
   * True when `source_row_count` disagrees with `row_count`. The extract
   * writes anyway (fail open); every consumer must check this flag.
   */
  source_count_mismatch?: boolean;
}

export interface ExportManifest {
  /** Absent in manifest_version 1 artifacts written before the source count. */
  manifest_version?: number;
  extraction_timestamp: string;
  /**
   * Id of the single extract attempt that wrote every object this manifest
   * certifies. Absent in manifest_version < 3 artifacts.
   */
  attempt_id?: string;
  /**
   * True when any table's `source_row_count` disagrees with `row_count`.
   * Always present from manifest_version 2. Consumers must check this —
   * mismatched data still lands.
   */
  source_count_mismatch?: boolean;
  tables: {
    checkin_prompt: ExportTableManifest;
    checkin_response: ExportTableManifest;
  };
}

export interface ExportSlot {
  scheduledAt: Date;
  extractionDate: string;
  objectTimestamp: string;
}

export function formatExtractionDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatObjectTimestamp(date: Date): string {
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");
  return `${hours}${minutes}${seconds}`;
}

export function buildExportSlot(
  calendarDay: Date,
  hour: number,
  minute: number,
): ExportSlot {
  const scheduledAt = new Date(
    Date.UTC(
      calendarDay.getUTCFullYear(),
      calendarDay.getUTCMonth(),
      calendarDay.getUTCDate(),
      hour,
      minute,
      0,
      0,
    ),
  );
  return {
    scheduledAt,
    extractionDate: formatExtractionDate(scheduledAt),
    objectTimestamp: formatObjectTimestamp(scheduledAt),
  };
}

export function getExportSlotsForDay(now: Date): ExportSlot[] {
  return EXPORT_SLOTS_UTC.map(({ hour, minute }) => buildExportSlot(now, hour, minute));
}

export function shouldRunExport(now: Date): ExportSlot | null {
  for (const slot of getExportSlotsForDay(now)) {
    const windowEnd = new Date(
      slot.scheduledAt.getTime() + EXPORT_SLOT_WINDOW_MINUTES * 60 * 1000,
    );
    if (now >= slot.scheduledAt && now < windowEnd) {
      return slot;
    }
  }
  return null;
}

export function buildTableObjectKey(
  table: "checkin_prompt" | "checkin_response",
  slot: ExportSlot,
): string {
  return `raw/cloudflare/checkins/${table}/extraction_date=${slot.extractionDate}/${slot.objectTimestamp}.jsonl.gz`;
}

export function buildManifestObjectKey(slot: ExportSlot): string {
  return `raw/cloudflare/checkins/manifests/extraction_date=${slot.extractionDate}/${slot.objectTimestamp}.json`;
}

/**
 * One attempt id per `runAnalyticsExtract` invocation: wall-clock HHMMSS plus
 * random hex. Stamped into every object the attempt writes (exported rows and
 * the manifest) and into the `_status/` failure marker key, so a partial rerun
 * is detectable from the bucket alone (option B, CCP-648).
 */
export function newExtractAttemptId(now: Date): string {
  const random = new Uint8Array(4);
  crypto.getRandomValues(random);
  const suffix = [...random]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${formatObjectTimestamp(now)}-${suffix}`;
}

/**
 * Failure markers live under `_status/` in the same bucket, partitioned like
 * every other extract object. The key carries the slot timestamp plus the
 * attempt id, so a failed attempt's marker survives any number of later
 * (re)runs in the same slot.
 */
export function buildExtractStatusMarkerKey(
  slot: ExportSlot,
  attemptId: string,
): string {
  return `raw/cloudflare/checkins/_status/extraction_date=${slot.extractionDate}/${slot.objectTimestamp}-${attemptId}.json`;
}

export interface ExtractFailureMarker {
  extraction_date: string;
  object_timestamp: string;
  attempt_id: string;
  error: string;
  timestamp: string;
}

export function buildExtractFailureMarker(
  slot: ExportSlot,
  attemptId: string,
  error: string,
  timestamp: Date,
): ExtractFailureMarker {
  return {
    extraction_date: slot.extractionDate,
    object_timestamp: slot.objectTimestamp,
    attempt_id: attemptId,
    error,
    timestamp: timestamp.toISOString(),
  };
}

/**
 * Durable failure evidence, readable with the same R2 credentials that operate
 * the extract — no Workers Observability query needed (#61, CCP-648).
 */
export async function writeExtractFailureMarker(
  bucket: R2Bucket,
  slot: ExportSlot,
  attemptId: string,
  errorMessage: string,
  timestamp: Date,
): Promise<void> {
  const marker = buildExtractFailureMarker(slot, attemptId, errorMessage, timestamp);
  await bucket.put(
    buildExtractStatusMarkerKey(slot, attemptId),
    JSON.stringify(marker, null, 2),
    { httpMetadata: { contentType: "application/json" } },
  );
}

/**
 * A failed extract attempt. Carries the slot and attempt id because the thrown
 * error is the only channel from the extract to the scheduled handler's catch,
 * which writes the `_status/` marker from them.
 */
export class AnalyticsExtractError extends Error {
  constructor(
    message: string,
    readonly slot: ExportSlot,
    readonly attemptId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AnalyticsExtractError";
  }
}

export function serializeJsonl(rows: object[]): string {
  if (rows.length === 0) {
    return "";
  }
  return rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
}

export async function gzipText(text: string): Promise<ArrayBuffer> {
  const encoded = new TextEncoder().encode(text);
  const stream = new Blob([encoded])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

export async function gunzipText(data: ArrayBuffer): Promise<string> {
  const stream = new Blob([data])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

export async function countJsonlLines(data: ArrayBuffer): Promise<number> {
  const text = await gunzipText(data);
  if (text.length === 0) {
    return 0;
  }
  return text.trimEnd().split("\n").length;
}

export interface ExportTableCounts {
  objectKey: string;
  rowCount: number;
  sourceRowCount: number;
}

export function buildManifest(
  slot: ExportSlot,
  extractionTimestamp: string,
  attemptId: string,
  prompt: ExportTableCounts,
  response: ExportTableCounts,
): ExportManifest {
  const promptMismatch = prompt.rowCount !== prompt.sourceRowCount;
  const responseMismatch = response.rowCount !== response.sourceRowCount;
  return {
    manifest_version: EXPORT_MANIFEST_VERSION,
    extraction_timestamp: extractionTimestamp,
    attempt_id: attemptId,
    source_count_mismatch: promptMismatch || responseMismatch,
    tables: {
      checkin_prompt: {
        row_count: prompt.rowCount,
        source_row_count: prompt.sourceRowCount,
        object_key: prompt.objectKey,
        source_count_mismatch: promptMismatch,
      },
      checkin_response: {
        row_count: response.rowCount,
        source_row_count: response.sourceRowCount,
        object_key: response.objectKey,
        source_count_mismatch: responseMismatch,
      },
    },
  };
}

export interface SourceCountCheck {
  table: "checkin_prompt" | "checkin_response";
  /** Rows the export query returned. */
  fetched: number;
  /** Rows the independent SELECT COUNT(*) reported. */
  source: number;
}

/**
 * Fail open on a source-count disagreement: log which tables disagreed, but
 * do not throw. The extract writes the objects and records the mismatch in
 * the manifest. Fail-closed would produce a landing-zone gap with no
 * explanation — the only extract-failure event is an unqueryable Workers
 * log line (issue #61).
 *
 * Consequence: mismatched data lands. Every manifest consumer must check
 * `source_count_mismatch`.
 */
export function flagSourceCountMismatches(
  slot: ExportSlot,
  checks: SourceCountCheck[],
): SourceCountCheck[] {
  const mismatched = checks.filter((check) => check.fetched !== check.source);
  if (mismatched.length === 0) {
    return [];
  }

  const detail = mismatched
    .map((check) => `${check.table} fetched=${check.fetched} source=${check.source}`)
    .join("; ");

  log("error", "analytics_extract_source_count_mismatch", {
    extraction_date: slot.extractionDate,
    detail,
  });

  return mismatched;
}

export async function executeAnalyticsExtract(
  env: AnalyticsExtractEnv,
  slot: ExportSlot,
  now: Date,
  attemptId: string = newExtractAttemptId(now),
): Promise<ExportManifest> {
  if (!env.EXTRACT_BUCKET) {
    throw new Error("extract_bucket_unconfigured");
  }

  // The prompt read is bounded by this watermark, which is also what the
  // manifest reports as extraction_timestamp, so prompts are a defined set
  // rather than "whatever was there when the query happened". Responses are
  // deliberately unbounded — see listAllResponsesForExport for why bounding on
  // the mutable submitted_at is worse than not bounding at all, and issue #62
  // for the column that would fix it.
  const extractionTimestamp = now.toISOString();

  const prompts = await listAllPromptsForExport(env.DB, extractionTimestamp);
  const responses = await listAllResponsesForExport(env.DB);

  // Independent source counts: a separate SELECT COUNT(*) rather than
  // prompts.length, so a short read from the unpaged export query is visible.
  // Comparing the manifest against the JSONL alone cannot see it — both sides
  // derive from the same in-memory array. Each count carries the same bound as
  // its fetch, so the comparison stays like-for-like.
  const promptSourceCount = await countAllPromptsForExport(env.DB, extractionTimestamp);
  const responseSourceCount = await countAllResponsesForExport(env.DB);

  flagSourceCountMismatches(slot, [
    { table: "checkin_prompt", fetched: prompts.length, source: promptSourceCount },
    { table: "checkin_response", fetched: responses.length, source: responseSourceCount },
  ]);

  const promptKey = buildTableObjectKey("checkin_prompt", slot);
  const responseKey = buildTableObjectKey("checkin_response", slot);
  const manifestKey = buildManifestObjectKey(slot);

  // Every exported row carries the attempt id, so the object is stamped the
  // same way the manifest is — a rerun that overwrites a table object but dies
  // before the manifest leaves rows naming an attempt the manifest does not.
  const stampedPrompts = prompts.map((row) => ({ ...row, attempt_id: attemptId }));
  const stampedResponses = responses.map((row) => ({
    ...row,
    attempt_id: attemptId,
  }));

  const promptBody = await gzipText(serializeJsonl(stampedPrompts));
  const responseBody = await gzipText(serializeJsonl(stampedResponses));

  await env.EXTRACT_BUCKET.put(promptKey, promptBody, {
    httpMetadata: { contentType: "application/gzip" },
  });
  await env.EXTRACT_BUCKET.put(responseKey, responseBody, {
    httpMetadata: { contentType: "application/gzip" },
  });

  const manifest = buildManifest(
    slot,
    extractionTimestamp,
    attemptId,
    { objectKey: promptKey, rowCount: prompts.length, sourceRowCount: promptSourceCount },
    {
      objectKey: responseKey,
      rowCount: responses.length,
      sourceRowCount: responseSourceCount,
    },
  );

  await env.EXTRACT_BUCKET.put(manifestKey, JSON.stringify(manifest, null, 2), {
    httpMetadata: { contentType: "application/json" },
  });

  log("info", "analytics_extract_completed", {
    extraction_date: slot.extractionDate,
    prompt_count: prompts.length,
    response_count: responses.length,
    prompt_source_count: promptSourceCount,
    response_source_count: responseSourceCount,
    source_count_mismatch: manifest.source_count_mismatch === true,
    manifest_key: manifestKey,
  });

  return manifest;
}

export async function runAnalyticsExtract(
  env: AnalyticsExtractEnv,
  now: Date,
): Promise<{ skipped: true; reason: string } | { skipped: false; manifest: ExportManifest }> {
  if (!env.EXTRACT_BUCKET) {
    return { skipped: true, reason: "extract_bucket_unconfigured" };
  }

  const slot = shouldRunExport(now);
  if (!slot) {
    return { skipped: true, reason: "outside_export_window" };
  }

  const attemptId = newExtractAttemptId(now);
  try {
    const manifest = await executeAnalyticsExtract(env, slot, now, attemptId);
    return { skipped: false, manifest };
  } catch (error) {
    throw new AnalyticsExtractError(
      error instanceof Error ? error.message : "unknown",
      slot,
      attemptId,
      { cause: error },
    );
  }
}
