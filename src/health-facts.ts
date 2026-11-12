import { buildManifestObjectKey } from "./analytics-extract";
import {
  DeliveredPrompt,
  DeliveredStatus,
  ExtractFacts,
  FRESHNESS_LOOKBACK_DAYS,
  HealthFacts,
  ManifestHead,
  parsePromptDateKey,
  recentExportSlots,
  slotFromManifestKey,
} from "./health-strip";
import { log } from "./logger";

export interface HealthFactsEnv {
  DB: D1Database;
  EXTRACT_BUCKET?: R2Bucket;
}

const DELIVERED: ReadonlySet<string> = new Set(["sent", "answered", "declined", "expired"]);

interface PromptScanRow {
  id: string;
  status: string;
  sent_at: string | null;
  expires_at: string | null;
}

function isDeliveredStatus(status: string): status is DeliveredStatus {
  return DELIVERED.has(status);
}

async function loadDelivered(db: D1Database): Promise<DeliveredPrompt[]> {
  const result = await db
    .prepare(
      `SELECT id, status, sent_at, expires_at
       FROM checkin_prompt
       WHERE status IN ('sent', 'answered', 'declined', 'expired')
         AND sent_at IS NOT NULL`,
    )
    .all<PromptScanRow>();
  const delivered: DeliveredPrompt[] = [];
  for (const row of result.results ?? []) {
    if (!isDeliveredStatus(row.status)) {
      continue;
    }
    const dateKey = parsePromptDateKey(row.id);
    if (!dateKey) {
      log("warn", "health_prompt_unparsed", { prompt_id: row.id });
      continue;
    }
    delivered.push({
      dateKey,
      status: row.status,
      expiresAt: row.expires_at,
    });
  }
  return delivered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function mismatchFromUnknown(raw: unknown): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  if (raw.source_count_mismatch === true) {
    return true;
  }
  if (!isRecord(raw.tables)) {
    return false;
  }
  for (const name of ["checkin_prompt", "checkin_response"]) {
    const table = raw.tables[name];
    if (isRecord(table) && table.source_count_mismatch === true) {
      return true;
    }
  }
  return false;
}

const MANIFEST_TABLES = ["checkin_prompt", "checkin_response"] as const;

function manifestVersionOf(raw: Record<string, unknown>): number | null {
  const version = raw.manifest_version;
  if (version === undefined) {
    return 1;
  }
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return null;
  }
  return version;
}

function isCompleteTableManifest(raw: unknown, version: number): boolean {
  if (!isRecord(raw)) {
    return false;
  }
  if (typeof raw.row_count !== "number" || typeof raw.object_key !== "string") {
    return false;
  }
  if (version < 2) {
    return true;
  }
  return (
    typeof raw.source_row_count === "number" &&
    typeof raw.source_count_mismatch === "boolean"
  );
}

function parseManifestHead(
  slot: { readonly extractionDate: string; readonly objectTimestamp: string },
  body: string,
): ManifestHead | null {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(raw)) {
    return null;
  }
  const stamp = raw.extraction_timestamp;
  if (typeof stamp !== "string" || Number.isNaN(Date.parse(stamp))) {
    return null;
  }
  const version = manifestVersionOf(raw);
  if (version === null || !isRecord(raw.tables)) {
    return null;
  }
  for (const name of MANIFEST_TABLES) {
    if (!isCompleteTableManifest(raw.tables[name], version)) {
      return null;
    }
  }
  if (version >= 2 && typeof raw.source_count_mismatch !== "boolean") {
    return null;
  }
  return {
    slot: {
      extractionDate: slot.extractionDate,
      objectTimestamp: slot.objectTimestamp,
    },
    extractionTimestamp: stamp,
    integrity:
      version >= 2
        ? mismatchFromUnknown(raw)
          ? "mismatch"
          : "match"
        : "unknown",
  };
}

async function readObjectText(
  object: { arrayBuffer(): Promise<ArrayBuffer> },
): Promise<string> {
  return new TextDecoder().decode(await object.arrayBuffer());
}

const MANIFEST_PREFIX = "raw/cloudflare/checkins/manifests/";
const FALLBACK_MAX_READS = 25;
const FALLBACK_MAX_DAYS = 400;

async function* manifestKeysNewestFirst(
  bucket: R2Bucket,
  now: Date,
): AsyncGenerator<string> {
  for (let dayOffset = 0; dayOffset <= FALLBACK_MAX_DAYS; dayOffset += 1) {
    const day = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() - dayOffset,
      ),
    );
    const listed = await bucket.list({
      prefix: `${MANIFEST_PREFIX}extraction_date=${day.toISOString().slice(0, 10)}/`,
    });
    const keys = listed.objects.map((object) => object.key).sort();
    for (const key of keys.reverse()) {
      yield key;
    }
  }
}

async function loadExtract(
  bucket: R2Bucket | undefined,
  now: Date,
  walk: boolean,
): Promise<ExtractFacts> {
  if (!bucket) {
    return { kind: "no-bucket" };
  }
  const manifests: ManifestHead[] = [];
  const unreadableKeys: string[] = [];
  try {
    const slots = recentExportSlots(now, FRESHNESS_LOOKBACK_DAYS);
    const reads = await Promise.all(
      slots.map(async (slot) => {
        const key = buildManifestObjectKey(slot);
        try {
          const object = await bucket.get(key);
          return { slot, key, object };
        } catch (error) {
          log("error", "health_manifest_read_failed", {
            manifest_key: key,
            error: error instanceof Error ? error.message : "unknown",
          });
          unreadableKeys.push(key);
          return { slot, key, object: null };
        }
      }),
    );
    for (const { slot, key, object } of reads) {
      if (!object) {
        continue;
      }
      let head: ManifestHead | null;
      try {
        head = parseManifestHead(slot, await readObjectText(object));
      } catch (error) {
        log("error", "health_manifest_read_failed", {
          manifest_key: key,
          error: error instanceof Error ? error.message : "unknown",
        });
        unreadableKeys.push(key);
        continue;
      }
      if (!head) {
        log("error", "health_manifest_unreadable", { manifest_key: key });
        unreadableKeys.push(key);
        continue;
      }
      manifests.push(head);
    }
    if (walk && manifests.length === 0) {
      const attempted = new Set(reads.map(({ key }) => key));
      let readsDone = 0;
      for await (const key of manifestKeysNewestFirst(bucket, now)) {
        if (attempted.has(key)) {
          continue;
        }
        if (readsDone >= FALLBACK_MAX_READS) {
          break;
        }
        readsDone += 1;
        const slot = slotFromManifestKey(key);
        let head: ManifestHead | null = null;
        try {
          const object = await bucket.get(key);
          if (slot !== null && object !== null) {
            head = parseManifestHead(slot, await readObjectText(object));
          }
        } catch (error) {
          log("error", "health_manifest_read_failed", {
            manifest_key: key,
            error: error instanceof Error ? error.message : "unknown",
          });
        }
        if (head === null) {
          log("error", "health_manifest_unreadable", { manifest_key: key });
          unreadableKeys.push(key);
          continue;
        }
        manifests.push(head);
        break;
      }
    }
  } catch (error) {
    log("error", "health_extract_read_failed", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return {
      kind: "bucket",
      manifests,
      unreadableKeys:
        unreadableKeys.length > 0 ? unreadableKeys : [MANIFEST_PREFIX],
    };
  }
  return { kind: "bucket", manifests, unreadableKeys };
}

export async function loadHealthFacts(
  env: HealthFactsEnv,
  now: Date,
  options?: { walk?: boolean },
): Promise<HealthFacts> {
  const walk = options?.walk !== false;
  const [delivered, extract] = await Promise.all([
    loadDelivered(env.DB),
    loadExtract(env.EXTRACT_BUCKET, now, walk),
  ]);
  return {
    observedAt: now.toISOString(),
    delivered,
    extract,
  };
}
