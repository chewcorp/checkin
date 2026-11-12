import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildExportSlot,
  buildManifestObjectKey,
  type ExportSlot,
} from "../src/analytics-extract";
import { REPORT_AUTH_CHALLENGE } from "../src/export";
import {
  FRESHNESS_LOOKBACK_DAYS,
  addCivilDays,
  recentExportSlots,
  trailingLondonWindow,
} from "../src/health-strip";
import { getLondonParts } from "../src/london-time";

function requiredBinding(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} binding missing`);
  }
  return value;
}

const sliToken = requiredBinding(env.SLI_BEARER_TOKEN, "SLI_BEARER_TOKEN");
const exportToken = requiredBinding(env.EXPORT_BEARER_TOKEN, "EXPORT_BEARER_TOKEN");

function sliHeaders(): HeadersInit {
  return { authorization: `Bearer ${sliToken}` };
}

function exportHeaders(): HeadersInit {
  return { authorization: `Bearer ${exportToken}` };
}

async function insertPrompt(params: {
  id: string;
  status: string;
  sentAt: string | null;
  expiresAt: string | null;
  token: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO checkin_prompt
     (id, scheduled_for, sent_at, expires_at, response_token, notification_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      params.id,
      params.sentAt ?? "2026-09-20T08:00:00.000Z",
      params.sentAt,
      params.expiresAt,
      params.token,
      "secret-notification",
      params.status,
      params.sentAt ?? "2026-09-20T08:00:00.000Z",
    )
    .run();
}

async function insertResponse(params: {
  id: string;
  promptId: string | null;
  feeling: string;
  note: string | null;
  observedAt: string;
  submittedAt: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO checkin_response
     (id, prompt_id, feeling, intensity, note, confidence, vocab_era, observed_at, submitted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      params.id,
      params.promptId,
      params.feeling,
      4,
      params.note,
      null,
      null,
      params.observedAt,
      params.submittedAt,
    )
    .run();
}

function manifestBody(slot: ExportSlot): string {
  const tableEntry = (table: string) => ({
    row_count: 1,
    source_row_count: 1,
    object_key: `raw/cloudflare/checkins/${table}/extraction_date=${slot.extractionDate}/${slot.objectTimestamp}.jsonl.gz`,
    source_count_mismatch: false,
  });
  return JSON.stringify({
    manifest_version: 2,
    extraction_timestamp: new Date(slot.scheduledAt.getTime() + 3 * 60_000).toISOString(),
    source_count_mismatch: false,
    tables: {
      checkin_prompt: tableEntry("checkin_prompt"),
      checkin_response: tableEntry("checkin_response"),
    },
  });
}

async function putManifest(slot: ExportSlot): Promise<void> {
  const bucket = env.EXTRACT_BUCKET;
  if (!bucket) {
    throw new Error("EXTRACT_BUCKET binding missing");
  }
  await bucket.put(buildManifestObjectKey(slot), manifestBody(slot));
}

async function putRecentManifest(): Promise<void> {
  const slot = recentExportSlots(new Date(), FRESHNESS_LOOKBACK_DAYS)[0];
  if (!slot) {
    throw new Error("no recent export slot");
  }
  await putManifest(slot);
}

async function countBucketLists(run: () => Promise<void>): Promise<number> {
  const bucket = env.EXTRACT_BUCKET;
  if (!bucket) {
    throw new Error("EXTRACT_BUCKET binding missing");
  }
  let lists = 0;
  const original = bucket.list.bind(bucket);
  bucket.list = ((...args: Parameters<R2Bucket["list"]>) => {
    lists += 1;
    return original(...args);
  }) as typeof bucket.list;
  try {
    await run();
    return lists;
  } finally {
    bucket.list = original;
  }
}

async function clearManifests(): Promise<void> {
  const bucket = env.EXTRACT_BUCKET;
  if (!bucket) {
    throw new Error("EXTRACT_BUCKET binding missing");
  }
  const listed = await bucket.list({
    prefix: "raw/cloudflare/checkins/manifests/",
  });
  await Promise.all(listed.objects.map((object) => bucket.delete(object.key)));
}

function collectNumbers(value: unknown, into: number[]): void {
  if (typeof value === "number") {
    into.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectNumbers(item, into);
    }
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectNumbers(item, into);
    }
  }
}

describe("GET /api/sli", () => {
  beforeEach(async () => {
    await env.DB.prepare("DELETE FROM checkin_response").run();
    await env.DB.prepare("DELETE FROM checkin_prompt").run();
    await clearManifests();
    await putRecentManifest();
  });

  it("lets the SLI bearer read /api/sli and refuses it on export, report, and check-in", async () => {
    const sli = await SELF.fetch("http://example.com/api/sli", {
      headers: sliHeaders(),
    });
    expect(sli.status).toBe(200);
    expect(sli.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(sli.headers.get("cache-control")).toBe("private, no-store");
    expect(sli.headers.get("x-content-type-options")).toBe("nosniff");

    const responses = await SELF.fetch("https://example.com/api/responses", {
      headers: sliHeaders(),
    });
    expect(responses.status).toBe(401);
    expect(await responses.text()).toBe("Unauthorized");

    const report = await SELF.fetch("https://example.com/report", {
      headers: sliHeaders(),
    });
    expect(report.status).toBe(401);
    expect(report.headers.get("www-authenticate")).toBe(REPORT_AUTH_CHALLENGE);

    const checkin = await SELF.fetch("https://example.com/checkin", {
      headers: sliHeaders(),
    });
    expect(checkin.status).toBe(401);
    expect(checkin.headers.get("www-authenticate")).toBe(REPORT_AUTH_CHALLENGE);
  });

  it("rejects the export bearer, a missing Authorization header, and Basic", async () => {
    const exported = await SELF.fetch("https://example.com/api/sli", {
      headers: exportHeaders(),
    });
    expect(exported.status).toBe(401);
    expect(await exported.text()).toBe("Unauthorized");
    expect(exported.headers.get("www-authenticate")).toBeNull();

    const missing = await SELF.fetch("https://example.com/api/sli");
    expect(missing.status).toBe(401);
    expect(await missing.text()).toBe("Unauthorized");
    expect(missing.headers.get("www-authenticate")).toBeNull();

    const basic = await SELF.fetch("https://example.com/api/sli", {
      headers: { authorization: `Basic ${btoa(`reader:${sliToken}`)}` },
    });
    expect(basic.status).toBe(401);
    expect(await basic.text()).toBe("Unauthorized");
    expect(basic.headers.get("www-authenticate")).toBeNull();
  });

  it("rejects POST before auth with a body that is not JSON", async () => {
    const response = await SELF.fetch("https://example.com/api/sli", {
      method: "POST",
    });
    expect(response.status).toBe(405);
    const text = await response.text();
    expect(text).toBe("Method Not Allowed");
    expect(() => JSON.parse(text)).toThrow();
  });

  it("returns manifest_missing and does not list R2 when the lookback is empty", async () => {
    await clearManifests();
    const lists = await countBucketLists(async () => {
      const response = await SELF.fetch("https://example.com/api/sli", {
        headers: sliHeaders(),
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      const body = JSON.parse(text) as {
        coverage: {
          window: { dayCount: number };
          answer: { kind: string; reason?: string };
          failed: number | null;
        };
        recency: string | null;
        extract: { kind: string; reason?: string };
      };
      expect(body.coverage.answer).toEqual({ kind: "absent", reason: "no-sends" });
      expect(body.coverage.failed).toBeNull();
      expect(body.coverage.window.dayCount).toBe(14);
      expect(body.recency).toBeNull();
      expect(body.extract).toEqual({ kind: "error", reason: "manifest_missing" });
      expect(text).not.toContain('"feeling"');
      expect(text).not.toContain('"note"');
      expect(text).not.toContain('"prompt_id"');
      const numbers: number[] = [];
      collectNumbers(body, numbers);
      expect(numbers.every((value) => value !== 0)).toBe(true);
    });
    expect(lists).toBe(0);
  });

  it("reports an empty prompt table with no numeric zero", async () => {
    const response = await SELF.fetch("https://example.com/api/sli", {
      headers: sliHeaders(),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      coverage: {
        window: { dayCount: number };
        answer: { kind: string; reason?: string };
        failed: number | null;
      };
      recency: string | null;
    };
    expect(body.coverage.answer).toEqual({ kind: "absent", reason: "no-sends" });
    expect(body.coverage.failed).toBeNull();
    expect(body.recency).toBeNull();
    expect(body.coverage.window.dayCount).toBe(14);
    const numbers: number[] = [];
    collectNumbers(body, numbers);
    expect(numbers).toContain(14);
    expect(numbers.every((value) => value !== 0)).toBe(true);
  });

  it("does not search older manifests, while /report still does", async () => {
    await clearManifests();
    const past = new Date(Date.now() - 40 * 86_400_000);
    await putManifest(buildExportSlot(past, 3, 0));

    const lists = await countBucketLists(async () => {
      const sli = await SELF.fetch("https://example.com/api/sli", {
        headers: sliHeaders(),
      });
      expect(sli.status).toBe(200);
      const body = (await sli.json()) as { extract: { kind: string; reason?: string } };
      expect(body.extract).toEqual({ kind: "error", reason: "manifest_missing" });
    });
    expect(lists).toBe(0);

    const reportLists = await countBucketLists(async () => {
      const report = await SELF.fetch("https://example.com/report", {
        headers: exportHeaders(),
      });
      const html = await report.text();
      expect(report.status).toBe(200);
      expect(html).toContain('data-extract="landed"');
    });
    expect(reportLists).toBeGreaterThan(0);
  });

  it("omits feeling text, notes, and prompt ids from the body", async () => {
    const feeling = "zircon-glimmer-feeling";
    const note = "quartz-margin-sentinel";
    const promptId = "prompt-sentinel-9";
    await insertPrompt({
      id: promptId,
      status: "answered",
      sentAt: "2026-11-01T08:00:00.000Z",
      expiresAt: "2026-11-01T20:00:00.000Z",
      token: "sentinel-token",
    });
    await insertResponse({
      id: "response-sentinel",
      promptId,
      feeling,
      note,
      observedAt: "2026-11-01T09:00:00.000Z",
      submittedAt: "2026-11-01T09:01:00.000Z",
    });

    const response = await SELF.fetch("https://example.com/api/sli", {
      headers: sliHeaders(),
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain(feeling);
    expect(text).not.toContain(note);
    expect(text).not.toContain(promptId);
    expect(text).not.toContain("sentinel-token");
    expect(text).not.toContain('"feeling"');
    expect(text).not.toContain('"note"');
    expect(text).not.toContain('"prompt_id"');
  });

  it("counts an in-window failed prompt with a null sent_at and drops the others", async () => {
    const window = trailingLondonWindow(new Date());
    await insertPrompt({
      id: `prompt-${window.end}-w1`,
      status: "failed",
      sentAt: null,
      expiresAt: null,
      token: "failed-in-window",
    });
    await insertPrompt({
      id: `prompt-${window.start}-w0`,
      status: "failed",
      sentAt: null,
      expiresAt: null,
      token: "failed-on-start",
    });
    await insertPrompt({
      id: `prompt-${addCivilDays(window.end, 1)}-w0`,
      status: "failed",
      sentAt: null,
      expiresAt: null,
      token: "failed-after-window",
    });
    await insertPrompt({
      id: "prompt-2020-01-01-w1",
      status: "failed",
      sentAt: null,
      expiresAt: null,
      token: "failed-before-window",
    });
    await insertPrompt({
      id: "not-a-prompt-id",
      status: "failed",
      sentAt: null,
      expiresAt: null,
      token: "failed-unparsed",
    });
    await insertPrompt({
      id: `prompt-${window.end}-extra`,
      status: "failed",
      sentAt: null,
      expiresAt: null,
      token: "failed-unparsed-in-range",
    });

    const response = await SELF.fetch("https://example.com/api/sli", {
      headers: sliHeaders(),
    });
    const body = (await response.json()) as {
      coverage: {
        answer: { kind: string; reason?: string };
        failed: number | null;
      };
    };
    expect(body.coverage.answer).toEqual({ kind: "absent", reason: "no-sends" });
    expect(body.coverage.failed).toBe(2);

    const report = await SELF.fetch("https://example.com/report", {
      headers: exportHeaders(),
    });
    const html = await report.text();
    expect(report.status).toBe(200);
    expect(html).toContain('data-answer="absent"');
    expect(html).not.toMatch(/\d+%/);
  });

  it("returns failed 0 for a measured answer and keeps that prompt out of the report rate", async () => {
    const londonDate = getLondonParts(new Date()).dateKey;
    await insertPrompt({
      id: `prompt-${londonDate}-w1`,
      status: "answered",
      sentAt: `${londonDate}T08:01:00.000Z`,
      expiresAt: `${londonDate}T20:01:00.000Z`,
      token: "closed-answered",
    });
    await insertPrompt({
      id: "prompt-2020-01-01-w9",
      status: "failed",
      sentAt: "2020-01-01T08:00:00.000Z",
      expiresAt: "2020-01-01T20:00:00.000Z",
      token: "old-failed-sent",
    });

    const response = await SELF.fetch("https://example.com/api/sli", {
      headers: sliHeaders(),
    });
    const body = (await response.json()) as {
      coverage: {
        answer: { kind: string; answered?: number; sent?: number };
        failed: number | null;
      };
    };
    expect(body.coverage.answer.kind).toBe("measured");
    expect(body.coverage.answer.answered).toBe(1);
    expect(body.coverage.answer.sent).toBe(1);
    expect(body.coverage.failed).toBe(0);

    const report = await SELF.fetch("https://example.com/report", {
      headers: exportHeaders(),
    });
    const html = await report.text();
    expect(report.status).toBe(200);
    expect(html).toContain("1/1 · 100% · Healthy");
    expect(html).toContain('data-answer="measured"');
    expect(html).not.toContain("1/2");
  });

  it("uses the latest submitted_at, including a manual row", async () => {
    const londonDate = getLondonParts(new Date()).dateKey;
    const promptedObserved = "2026-12-01T00:00:00.000Z";
    const promptedSubmitted = "2026-11-01T10:00:00.000Z";
    const manualObserved = "2026-08-01T00:00:00.000Z";
    const manualSubmitted = "2026-11-11T18:04:00.000Z";
    await insertPrompt({
      id: `prompt-${londonDate}-w2`,
      status: "answered",
      sentAt: `${londonDate}T08:01:00.000Z`,
      expiresAt: `${londonDate}T20:01:00.000Z`,
      token: "prompted-recency",
    });
    await insertResponse({
      id: "response-prompted",
      promptId: `prompt-${londonDate}-w2`,
      feeling: "calm",
      note: null,
      observedAt: promptedObserved,
      submittedAt: promptedSubmitted,
    });
    await insertResponse({
      id: "response-manual",
      promptId: null,
      feeling: "calm",
      note: null,
      observedAt: manualObserved,
      submittedAt: manualSubmitted,
    });

    const response = await SELF.fetch("https://example.com/api/sli", {
      headers: sliHeaders(),
    });
    const body = (await response.json()) as { recency: string | null };
    expect(body.recency).toBe(manualSubmitted);
    expect(body.recency).not.toBe(promptedObserved);
    expect(body.recency).not.toBe(manualObserved);
    expect(body.recency).not.toBe(promptedSubmitted);
  });

  it("ignores from and to query parameters", async () => {
    const response = await SELF.fetch(
      "https://example.com/api/sli?from=&to=",
      { headers: sliHeaders() },
    );
    const body = (await response.json()) as {
      coverage: { window: { dayCount: number } };
    };
    expect(response.status).toBe(200);
    expect(body.coverage.window.dayCount).toBe(14);
  });
});
