import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  AnalyticsExtractEnv,
  EXPORT_MANIFEST_VERSION,
  buildExportSlot,
  buildExtractStatusMarkerKey,
  buildManifestObjectKey,
  buildTableObjectKey,
  countJsonlLines,
  executeAnalyticsExtract,
  gunzipText,
  gzipText,
  runAnalyticsExtract,
  shouldRunExport,
} from "../src/analytics-extract";
import {
  parseExportManifest,
  validateExtractAttemptIds,
  validateManifestTieBack,
} from "../src/analytics-extract-verify";
import { WHEEL_ERA } from "../src/feelings-wheel";
import { runAnalyticsExtractGuarded } from "../src/index";
import { NoopNotifier } from "../src/notifier";
import { runScheduler } from "../src/scheduler";

class MemoryR2Object {
  constructor(private readonly data: ArrayBuffer) {}

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data.slice(0);
  }
}

class MemoryR2Bucket {
  private readonly objects = new Map<string, ArrayBuffer>();

  async put(key: string, value: ArrayBuffer | string): Promise<void> {
    const buffer =
      typeof value === "string"
        ? new TextEncoder().encode(value).buffer
        : value;
    this.objects.set(key, buffer as ArrayBuffer);
  }

  async get(key: string): Promise<MemoryR2Object | null> {
    const data = this.objects.get(key);
    return data ? new MemoryR2Object(data) : null;
  }

  async list(options?: { prefix?: string }): Promise<{ objects: { key: string }[] }> {
    const prefix = options?.prefix ?? "";
    const objects = [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => ({ key }));
    return { objects };
  }
}

/**
 * MemoryR2Bucket with a fail switch on `put`, so a test can kill one object
 * write — e.g. the manifest — while leaving the rest of the bucket live.
 */
class FailingR2Bucket extends MemoryR2Bucket {
  constructor(private readonly failOn: (key: string) => boolean) {
    super();
  }

  override async put(key: string, value: ArrayBuffer | string): Promise<void> {
    if (this.failOn(key)) {
      throw new Error(`injected put failure: ${key}`);
    }
    await super.put(key, value);
  }
}

function createExtractEnv(bucket: R2Bucket): AnalyticsExtractEnv {
  return { DB: env.DB, EXTRACT_BUCKET: bucket };
}

interface StubCounts {
  promptRows: number;
  promptSourceCount: number;
  responseRows: number;
  responseSourceCount: number;
}

/**
 * D1 stub whose row fetch and COUNT(*) can be made to disagree — the short-read
 * case the manifest-to-JSONL comparison cannot see, because both sides of that
 * comparison come from the same fetched array.
 */
function stubDbWithCounts(counts: StubCounts): D1Database {
  const makeRows = (count: number, prefix: string) =>
    Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));

  return {
    prepare(sql: string) {
      const isPrompt = sql.includes("checkin_prompt");
      const statement = {
        bind() {
          return statement;
        },
        async all() {
          return {
            results: isPrompt
              ? makeRows(counts.promptRows, "prompt")
              : makeRows(counts.responseRows, "response"),
          };
        },
        async first() {
          return {
            row_count: isPrompt
              ? counts.promptSourceCount
              : counts.responseSourceCount,
          };
        },
      };
      return statement;
    },
  } as unknown as D1Database;
}

async function seedPromptAndResponse(): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO checkin_prompt
     (id, scheduled_for, sent_at, expires_at, response_token, notification_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "prompt-test-1",
      "2026-08-15T09:00:00.000Z",
      "2026-08-15T09:01:00.000Z",
      "2026-08-16T01:01:00.000Z",
      "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      "pushover-msg-123",
      "sent",
      "2026-08-15T09:00:00.000Z",
    )
    .run();

  await env.DB.prepare(
    `INSERT INTO checkin_response
     (id, prompt_id, feeling, intensity, note, confidence, observed_at, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      "response-test-1",
      "prompt-test-1",
      "calm",
      7,
      "after a walk",
      "weak",
      "2026-08-15T09:05:00.000Z",
      "2026-08-15T09:05:01.000Z",
    )
    .run();
}

describe("analytics extract slot gating", () => {
  it("runs only inside the daily export windows", () => {
    expect(shouldRunExport(new Date("2026-08-15T02:59:00.000Z"))).toBeNull();
    expect(shouldRunExport(new Date("2026-08-15T03:00:00.000Z"))?.objectTimestamp).toBe(
      "030000",
    );
    expect(shouldRunExport(new Date("2026-08-15T03:14:59.000Z"))?.objectTimestamp).toBe(
      "030000",
    );
    expect(shouldRunExport(new Date("2026-08-15T03:15:00.000Z"))).toBeNull();
    expect(shouldRunExport(new Date("2026-08-15T12:00:00.000Z"))).toBeNull();
    expect(shouldRunExport(new Date("2026-08-15T15:00:00.000Z"))?.objectTimestamp).toBe(
      "150000",
    );
    expect(shouldRunExport(new Date("2026-08-15T15:14:59.000Z"))?.objectTimestamp).toBe(
      "150000",
    );
    expect(shouldRunExport(new Date("2026-08-15T15:15:00.000Z"))).toBeNull();
  });

  it("keys object paths to the scheduled slot time, not wall clock", () => {
    const morning = buildExportSlot(new Date("2026-08-15T03:05:00.000Z"), 3, 0);
    expect(buildTableObjectKey("checkin_prompt", morning)).toBe(
      "raw/cloudflare/checkins/checkin_prompt/extraction_date=2026-08-15/030000.jsonl.gz",
    );
    expect(buildManifestObjectKey(morning)).toBe(
      "raw/cloudflare/checkins/manifests/extraction_date=2026-08-15/030000.json",
    );

    const afternoon = buildExportSlot(new Date("2026-08-15T15:05:00.000Z"), 15, 0);
    expect(buildTableObjectKey("checkin_prompt", afternoon)).toBe(
      "raw/cloudflare/checkins/checkin_prompt/extraction_date=2026-08-15/150000.jsonl.gz",
    );
  });

  it("writes separate file sets for each daily slot", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;
    await seedPromptAndResponse();
    const extractEnv = createExtractEnv(bucket);
    const day = new Date("2026-08-17T03:05:00.000Z");

    await executeAnalyticsExtract(
      extractEnv,
      buildExportSlot(day, 3, 0),
      new Date("2026-08-17T03:05:00.000Z"),
    );
    await executeAnalyticsExtract(
      extractEnv,
      buildExportSlot(day, 15, 0),
      new Date("2026-08-17T15:05:00.000Z"),
    );

    const listed = await bucket.list({
      prefix: "raw/cloudflare/checkins/checkin_prompt/extraction_date=2026-08-17/",
    });
    expect(listed.objects).toHaveLength(2);
  });
});

describe("analytics extract snapshot", () => {
  it("writes gzipped JSONL snapshots and a manifest with matching counts", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;
    await seedPromptAndResponse();

    // The seeded rows are stamped 09:00, so they fall inside the 15:00 slot's
    // watermark, not the 03:00 one.
    const now = new Date("2026-08-15T15:05:00.000Z");
    const slot = buildExportSlot(now, 15, 0);
    const manifest = await executeAnalyticsExtract(createExtractEnv(bucket), slot, now);

    expect(manifest.tables.checkin_prompt.row_count).toBe(1);
    expect(manifest.tables.checkin_response.row_count).toBe(1);

    const promptObject = await bucket.get(manifest.tables.checkin_prompt.object_key);
    const responseObject = await bucket.get(manifest.tables.checkin_response.object_key);
    expect(promptObject).not.toBeNull();
    expect(responseObject).not.toBeNull();

    const promptBuffer = await promptObject!.arrayBuffer();
    const responseBuffer = await responseObject!.arrayBuffer();

    expect(await countJsonlLines(promptBuffer)).toBe(1);
    expect(await countJsonlLines(responseBuffer)).toBe(1);

    const parsedPrompt = JSON.parse((await gunzipText(promptBuffer)).trim());
    expect(parsedPrompt).toMatchObject({
      id: "prompt-test-1",
      status: "sent",
    });
    expect(parsedPrompt).not.toHaveProperty("response_token");
    expect(parsedPrompt).not.toHaveProperty("notification_id");

    const parsedResponse = JSON.parse((await gunzipText(responseBuffer)).trim());
    expect(parsedResponse).toMatchObject({
      id: "response-test-1",
      note: "after a walk",
      confidence: "weak",
      vocab_era: null,
    });
    expect(parsedResponse).toHaveProperty("vocab_era");

    const manifestObject = await bucket.get(buildManifestObjectKey(slot));
    expect(manifestObject).not.toBeNull();
  });

  it("exports vocab_era for every response, null for historical rows", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;
    await env.DB.prepare("DELETE FROM checkin_response").run();
    await env.DB.prepare("DELETE FROM checkin_prompt").run();
    await seedPromptAndResponse();
    await env.DB.prepare(
      `INSERT INTO checkin_response
       (id, prompt_id, feeling, intensity, note, confidence, vocab_era, observed_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "response-test-stamped",
        "prompt-test-1",
        "calm",
        4,
        null,
        null,
        WHEEL_ERA,
        "2026-08-15T09:06:00.000Z",
        "2026-08-15T09:06:01.000Z",
      )
      .run();

    const now = new Date("2026-08-15T15:05:00.000Z");
    const slot = buildExportSlot(now, 15, 0);
    const manifest = await executeAnalyticsExtract(createExtractEnv(bucket), slot, now);

    const responseObject = await bucket.get(manifest.tables.checkin_response.object_key);
    const lines = (await gunzipText(await responseObject!.arrayBuffer()))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { id: string; vocab_era: string | null });

    expect(lines).toHaveLength(2);
    expect(lines.every((row) => Object.prototype.hasOwnProperty.call(row, "vocab_era"))).toBe(
      true,
    );
    expect(lines.find((row) => row.id === "response-test-1")?.vocab_era).toBeNull();
    expect(lines.find((row) => row.id === "response-test-stamped")?.vocab_era).toBe(
      WHEEL_ERA,
    );
  });

  it("records an independent D1 source count in the manifest", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;

    await env.DB.prepare("DELETE FROM checkin_response").run();
    await env.DB.prepare("DELETE FROM checkin_prompt").run();
    await seedPromptAndResponse();

    const now = new Date("2026-08-15T15:05:00.000Z");
    const slot = buildExportSlot(now, 15, 0);
    const manifest = await executeAnalyticsExtract(createExtractEnv(bucket), slot, now);

    expect(manifest.manifest_version).toBe(EXPORT_MANIFEST_VERSION);
    expect(manifest.source_count_mismatch).toBe(false);
    expect(manifest.tables.checkin_prompt.source_count_mismatch).toBe(false);
    expect(manifest.tables.checkin_response.source_count_mismatch).toBe(false);
    expect(manifest.tables.checkin_prompt.source_row_count).toBe(1);
    expect(manifest.tables.checkin_response.source_row_count).toBe(1);
    expect(manifest.tables.checkin_prompt.source_row_count).toBe(
      manifest.tables.checkin_prompt.row_count,
    );
    expect(manifest.tables.checkin_response.source_row_count).toBe(
      manifest.tables.checkin_response.row_count,
    );

    const manifestObject = await bucket.get(buildManifestObjectKey(slot));
    const written = JSON.parse(
      new TextDecoder().decode(await manifestObject!.arrayBuffer()),
    );
    expect(written.tables.checkin_prompt.source_row_count).toBe(1);
    expect(written.tables.checkin_response.source_row_count).toBe(1);
  });

  it("bounds prompts by the watermark but keeps every response", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;

    await env.DB.prepare("DELETE FROM checkin_response").run();
    await env.DB.prepare("DELETE FROM checkin_prompt").run();
    await seedPromptAndResponse();

    // A check-in submitted after the scheduled handler captured `now` but
    // before the export reads run. Responses are not bounded, so it lands in
    // this slot: over-inclusion is the accepted cost of never dropping a row
    // whose submitted_at was moved forward by a re-answer (issue #62).
    await env.DB.prepare(
      `INSERT INTO checkin_response
       (id, prompt_id, feeling, intensity, note, confidence, observed_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "response-after-watermark",
        "prompt-test-1",
        "calm",
        5,
        null,
        "weak",
        "2026-08-15T15:04:00.000Z",
        "2026-08-15T15:06:00.000Z",
      )
      .run();

    const now = new Date("2026-08-15T15:05:00.000Z");
    const slot = buildExportSlot(now, 15, 0);
    const manifest = await executeAnalyticsExtract(createExtractEnv(bucket), slot, now);

    expect(manifest.extraction_timestamp).toBe("2026-08-15T15:05:00.000Z");
    expect(manifest.tables.checkin_response.row_count).toBe(2);
    expect(manifest.tables.checkin_response.source_row_count).toBe(2);

    // A prompt created after the watermark is excluded — created_at is never
    // rewritten, so that bound can only ever drop rows that did not yet exist.
    await env.DB.prepare(
      `INSERT INTO checkin_prompt
       (id, scheduled_for, sent_at, expires_at, response_token, notification_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        "prompt-after-watermark",
        "2026-08-15T17:00:00.000Z",
        null,
        null,
        "f".repeat(64),
        null,
        "pending",
        "2026-08-15T15:06:00.000Z",
      )
      .run();

    const second = new MemoryR2Bucket() as unknown as R2Bucket;
    const laterManifest = await executeAnalyticsExtract(
      createExtractEnv(second),
      slot,
      now,
    );
    expect(laterManifest.tables.checkin_prompt.row_count).toBe(1);
  });

  it("keeps a response edited after the watermark", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;

    await env.DB.prepare("DELETE FROM checkin_response").run();
    await env.DB.prepare("DELETE FROM checkin_prompt").run();
    await seedPromptAndResponse();

    // "Change answer" upserts the row and moves submitted_at forward. Bounding
    // responses on that mutable column would drop a response that existed long
    // before the watermark, and every count check would still pass, because the
    // COUNT carries the same predicate — the row would simply look deleted for
    // one slot.
    await env.DB.prepare(
      `UPDATE checkin_response
       SET feeling = ?, submitted_at = ?
       WHERE id = ?`,
    )
      .bind("tense", "2026-08-15T15:06:00.000Z", "response-test-1")
      .run();

    const now = new Date("2026-08-15T15:05:00.000Z");
    const slot = buildExportSlot(now, 15, 0);
    const manifest = await executeAnalyticsExtract(createExtractEnv(bucket), slot, now);

    expect(manifest.tables.checkin_response.row_count).toBe(1);
    expect(manifest.tables.checkin_response.source_row_count).toBe(1);

    const responseObject = await bucket.get(
      manifest.tables.checkin_response.object_key,
    );
    const text = await gunzipText(await responseObject!.arrayBuffer());
    expect(text).toContain("response-test-1");
  });

  it("fails open when a source count disagrees with the fetched rows", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;
    const now = new Date("2026-08-15T03:05:00.000Z");
    const slot = buildExportSlot(now, 3, 0);

    const extractEnv: AnalyticsExtractEnv = {
      DB: stubDbWithCounts({
        promptRows: 2,
        promptSourceCount: 3,
        responseRows: 1,
        responseSourceCount: 1,
      }),
      EXTRACT_BUCKET: bucket,
    };

    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };

    let manifest;
    try {
      manifest = await executeAnalyticsExtract(extractEnv, slot, now);
    } finally {
      console.log = originalLog;
    }

    // Writes anyway: a gap with no explanation is worse because the only
    // extract-failure event is an unqueryable Workers log line (issue #61).
    expect(manifest.source_count_mismatch).toBe(true);
    expect(manifest.tables.checkin_prompt.source_count_mismatch).toBe(true);
    expect(manifest.tables.checkin_response.source_count_mismatch).toBe(false);
    expect(manifest.tables.checkin_prompt.row_count).toBe(2);
    expect(manifest.tables.checkin_prompt.source_row_count).toBe(3);
    expect(manifest.tables.checkin_response.row_count).toBe(1);
    expect(manifest.tables.checkin_response.source_row_count).toBe(1);

    const listed = await bucket.list({ prefix: "raw/cloudflare/checkins/" });
    expect(listed.objects.map((object) => object.key).sort()).toEqual(
      [
        "raw/cloudflare/checkins/checkin_prompt/extraction_date=2026-08-15/030000.jsonl.gz",
        "raw/cloudflare/checkins/checkin_response/extraction_date=2026-08-15/030000.jsonl.gz",
        "raw/cloudflare/checkins/manifests/extraction_date=2026-08-15/030000.json",
      ].sort(),
    );

    const written = JSON.parse(
      new TextDecoder().decode(
        await (await bucket.get(buildManifestObjectKey(slot)))!.arrayBuffer(),
      ),
    );
    expect(written.source_count_mismatch).toBe(true);
    expect(written.tables.checkin_prompt.source_count_mismatch).toBe(true);
    expect(written.tables.checkin_prompt.source_row_count).toBe(3);
    expect(written.tables.checkin_prompt.row_count).toBe(2);

    expect(
      logged.some(
        (line) =>
          line.includes("analytics_extract_source_count_mismatch") &&
          line.includes("checkin_prompt fetched=2 source=3"),
      ),
    ).toBe(true);
  });

  it("names every disagreeing table in the mismatch log and flag", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;
    const now = new Date("2026-08-15T03:05:00.000Z");
    const slot = buildExportSlot(now, 3, 0);

    const extractEnv: AnalyticsExtractEnv = {
      DB: stubDbWithCounts({
        promptRows: 2,
        promptSourceCount: 3,
        responseRows: 1,
        responseSourceCount: 4,
      }),
      EXTRACT_BUCKET: bucket,
    };

    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };

    let manifest;
    try {
      manifest = await executeAnalyticsExtract(extractEnv, slot, now);
    } finally {
      console.log = originalLog;
    }

    expect(manifest.source_count_mismatch).toBe(true);
    expect(manifest.tables.checkin_prompt.source_count_mismatch).toBe(true);
    expect(manifest.tables.checkin_response.source_count_mismatch).toBe(true);
    expect(
      logged.some(
        (line) =>
          line.includes("analytics_extract_source_count_mismatch") &&
          line.includes(
            "checkin_prompt fetched=2 source=3; checkin_response fetched=1 source=4",
          ),
      ),
    ).toBe(true);

    const listed = await bucket.list({ prefix: "raw/cloudflare/checkins/" });
    expect(listed.objects).toHaveLength(3);
  });

  it("is idempotent for the same slot — one file set after N invocations", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;

    await env.DB.prepare("DELETE FROM checkin_response").run();
    await env.DB.prepare("DELETE FROM checkin_prompt").run();
    await seedPromptAndResponse();

    const now = new Date("2026-08-16T03:05:00.000Z");
    const slot = buildExportSlot(now, 3, 0);
    const extractEnv = createExtractEnv(bucket);

    await executeAnalyticsExtract(extractEnv, slot, now);
    await executeAnalyticsExtract(extractEnv, slot, now);
    await executeAnalyticsExtract(extractEnv, slot, now);

    const listed = await bucket.list({
      prefix: `raw/cloudflare/checkins/checkin_prompt/extraction_date=${slot.extractionDate}/`,
    });
    expect(listed.objects).toHaveLength(1);
  });

  it("skips outside the export window via runAnalyticsExtract", async () => {
    const bucket = new MemoryR2Bucket() as unknown as R2Bucket;
    const result = await runAnalyticsExtract(
      createExtractEnv(bucket),
      new Date("2026-08-15T12:00:00.000Z"),
    );
    expect(result).toEqual({ skipped: true, reason: "outside_export_window" });
  });
});

describe("analytics extract attempt id and _status marker", () => {
  const NOW = new Date("2026-08-15T15:05:00.000Z");
  const slot = () => buildExportSlot(NOW, 15, 0);

  const readJson = async (bucket: MemoryR2Bucket, key: string) =>
    JSON.parse(
      new TextDecoder().decode(await (await bucket.get(key))!.arrayBuffer()),
    );

  const readJsonlRows = async (bucket: MemoryR2Bucket, key: string) =>
    (await gunzipText(await (await bucket.get(key))!.arrayBuffer()))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("stamps one attempt id on every row and the manifest", async () => {
    const bucket = new MemoryR2Bucket();
    await env.DB.prepare("DELETE FROM checkin_response").run();
    await env.DB.prepare("DELETE FROM checkin_prompt").run();
    await seedPromptAndResponse();

    const manifest = await executeAnalyticsExtract(
      createExtractEnv(bucket as unknown as R2Bucket),
      slot(),
      NOW,
    );

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.attempt_id).toMatch(/^\d{6}-[0-9a-f]{8}$/);

    for (const key of [
      manifest.tables.checkin_prompt.object_key,
      manifest.tables.checkin_response.object_key,
    ]) {
      const rows = await readJsonlRows(bucket, key);
      expect(rows).toHaveLength(1);
      expect(rows.every((row) => row.attempt_id === manifest.attempt_id)).toBe(true);
    }
  });

  it("keeps attempt A's _status marker readable after attempt B reruns clean", async () => {
    // Attempt A dies at the manifest write — both table objects are already in
    // the bucket, the exact partial state the marker has to describe.
    let failManifest = true;
    const bucket = new FailingR2Bucket(
      (key) => failManifest && key.includes("/manifests/"),
    );
    const extractEnv = { ...env, EXTRACT_BUCKET: bucket as unknown as R2Bucket };
    const s = slot();

    await env.DB.prepare("DELETE FROM checkin_response").run();
    await env.DB.prepare("DELETE FROM checkin_prompt").run();
    await seedPromptAndResponse();

    await runAnalyticsExtractGuarded(extractEnv, NOW);
    failManifest = false;
    await runAnalyticsExtractGuarded(extractEnv, NOW);

    const markers = await bucket.list({
      prefix: `raw/cloudflare/checkins/_status/extraction_date=${s.extractionDate}/`,
    });
    expect(markers.objects).toHaveLength(1);

    const marker = await readJson(bucket, markers.objects[0].key);
    expect(marker.attempt_id).toMatch(/^\d{6}-[0-9a-f]{8}$/);
    expect(marker.extraction_date).toBe(s.extractionDate);
    expect(marker.object_timestamp).toBe(s.objectTimestamp);
    expect(marker.error).toContain("injected put failure");
    expect(markers.objects[0].key).toBe(
      buildExtractStatusMarkerKey(s, marker.attempt_id),
    );

    const manifest = parseExportManifest(
      new TextDecoder().decode(
        await (await bucket.get(buildManifestObjectKey(s)))!.arrayBuffer(),
      ),
    );
    expect(manifest.attempt_id).toBeDefined();
    expect(manifest.attempt_id).not.toBe(marker.attempt_id);
  });

  it("flags a partial rerun whose counts are unchanged", async () => {
    const bucket = new MemoryR2Bucket();
    await env.DB.prepare("DELETE FROM checkin_response").run();
    await env.DB.prepare("DELETE FROM checkin_prompt").run();
    await seedPromptAndResponse();

    const s = slot();
    const manifest = await executeAnalyticsExtract(
      createExtractEnv(bucket as unknown as R2Bucket),
      s,
      NOW,
      "attempt-A",
    );

    // A rerun overwrites the prompt object and dies before response and
    // manifest: rows stamp the new attempt, the manifest still certifies the
    // old one — at identical row counts, which the count check cannot see.
    const promptKey = manifest.tables.checkin_prompt.object_key;
    const promptRows = await readJsonlRows(bucket, promptKey);
    await bucket.put(
      promptKey,
      await gzipText(
        promptRows
          .map((row) => JSON.stringify({ ...row, attempt_id: "attempt-B" }))
          .join("\n") + "\n",
      ),
    );

    const attemptCheck = validateExtractAttemptIds(manifest, {
      checkin_prompt: (await readJsonlRows(bucket, promptKey)).map(
        (row) => row.attempt_id as string | undefined,
      ),
      checkin_response: (
        await readJsonlRows(bucket, manifest.tables.checkin_response.object_key)
      ).map((row) => row.attempt_id as string | undefined),
    });
    expect(attemptCheck.ok).toBe(false);
    expect(attemptCheck.errors.join(" ")).toContain("attempt-B");
    expect(attemptCheck.errors.join(" ")).toContain("attempt-A");

    // And the count tie-back still passes — proof this check sees what it cannot.
    const responseRows = await readJsonlRows(
      bucket,
      manifest.tables.checkin_response.object_key,
    );
    const tieBack = validateManifestTieBack(
      manifest,
      promptRows.length,
      responseRows.length,
    );
    expect(tieBack.ok).toBe(true);
  });

  it("does not throw out of the guarded call even when the marker write fails too", async () => {
    // Every write fails: extract fails, the marker write fails as well, and
    // the guarded path still resolves — the scheduled handler stays up.
    const bucket = new FailingR2Bucket(() => true);
    const extractEnv = { ...env, EXTRACT_BUCKET: bucket as unknown as R2Bucket };

    const logged: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await expect(
        runAnalyticsExtractGuarded(extractEnv, NOW),
      ).resolves.toBeUndefined();
    } finally {
      console.log = originalLog;
    }

    expect(
      logged.some((line) => line.includes("analytics_extract_marker_write_failed")),
    ).toBe(true);
    expect(logged.some((line) => line.includes("analytics_extract_failed"))).toBe(
      true,
    );
  });
});

describe("analytics extract loop isolation", () => {
  it("does not block the scheduler when R2 writes fail", async () => {
    const failingBucket = {
      put: async () => {
        throw new Error("r2 unavailable");
      },
      get: async () => null,
      list: async () => ({ objects: [] }),
    } as unknown as R2Bucket;

    const extractEnv = { ...env, EXTRACT_BUCKET: failingBucket };
    const notifier = new NoopNotifier();
    const now = new Date("2026-08-13T09:45:00.000Z");

    await expect(runScheduler(extractEnv, notifier, now)).resolves.toBeUndefined();

    await expect(
      executeAnalyticsExtract(
        extractEnv,
        buildExportSlot(now, 3, 0),
        now,
      ),
    ).rejects.toThrow("r2 unavailable");
  });
});
