export type PromptStatus =
  | "scheduled"
  | "sent"
  | "answered"
  | "declined"
  | "expired"
  | "failed";

/** Closed delivered outcomes. Overdue `sent` counts as expired. */
export type ClosedPromptOutcome = "answered" | "declined" | "expired";

export function closedPromptOutcome(
  status: PromptStatus,
  expiresAt: string | null,
  nowIso: string,
): ClosedPromptOutcome | null {
  if (status === "answered" || status === "declined" || status === "expired") {
    return status;
  }
  if (status === "sent" && expiresAt !== null && expiresAt < nowIso) {
    return "expired";
  }
  return null;
}

export interface PromptRow {
  id: string;
  scheduled_for: string;
  sent_at: string | null;
  expires_at: string | null;
  response_token: string;
  notification_id: string | null;
  status: PromptStatus;
  created_at: string;
}

export type Confidence = "weak" | "strong";

export interface ResponseRow {
  id: string;
  prompt_id: string | null;
  feeling: string;
  intensity: number;
  note: string | null;
  confidence: Confidence | null;
  vocab_era: string | null;
  observed_at: string;
  submitted_at: string;
}

/** Prompt columns exported to analytics (F4 excludes credentials). */
export interface ExportedPromptRow {
  id: string;
  scheduled_for: string;
  sent_at: string | null;
  expires_at: string | null;
  status: PromptStatus;
  created_at: string;
}

export type ExportedResponseRow = ResponseRow;

export function promptId(dateKey: string, windowIndex: number): string {
  return `prompt-${dateKey}-w${windowIndex}`;
}

export async function getPromptById(
  db: D1Database,
  id: string,
): Promise<PromptRow | null> {
  return db
    .prepare(
      "SELECT id, scheduled_for, sent_at, expires_at, response_token, notification_id, status, created_at FROM checkin_prompt WHERE id = ?",
    )
    .bind(id)
    .first<PromptRow>();
}

export async function getPromptByToken(
  db: D1Database,
  token: string,
): Promise<PromptRow | null> {
  return db
    .prepare(
      "SELECT id, scheduled_for, sent_at, expires_at, response_token, notification_id, status, created_at FROM checkin_prompt WHERE response_token = ?",
    )
    .bind(token)
    .first<PromptRow>();
}

export async function insertPrompt(
  db: D1Database,
  row: PromptRow,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT OR IGNORE INTO checkin_prompt
      (id, scheduled_for, sent_at, expires_at, response_token, notification_id, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.scheduled_for,
      row.sent_at,
      row.expires_at,
      row.response_token,
      row.notification_id,
      row.status,
      row.created_at,
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updatePromptStatus(
  db: D1Database,
  id: string,
  status: PromptStatus,
  fields: Partial<Pick<PromptRow, "sent_at" | "expires_at" | "notification_id">> = {},
): Promise<void> {
  await db
    .prepare(
      `UPDATE checkin_prompt
       SET status = ?, sent_at = COALESCE(?, sent_at), expires_at = COALESCE(?, expires_at), notification_id = COALESCE(?, notification_id)
       WHERE id = ?`,
    )
    .bind(
      status,
      fields.sent_at ?? null,
      fields.expires_at ?? null,
      fields.notification_id ?? null,
      id,
    )
    .run();
}

export async function upsertResponse(
  db: D1Database,
  row: ResponseRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO checkin_response (id, prompt_id, feeling, intensity, note, confidence, vocab_era, observed_at, submitted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         feeling = excluded.feeling,
         intensity = excluded.intensity,
         note = excluded.note,
         confidence = excluded.confidence,
         vocab_era = excluded.vocab_era,
         observed_at = excluded.observed_at,
         submitted_at = excluded.submitted_at`,
    )
    .bind(
      row.id,
      row.prompt_id,
      row.feeling,
      row.intensity,
      row.note,
      row.confidence,
      row.vocab_era,
      row.observed_at,
      row.submitted_at,
    )
    .run();
}

export async function deleteResponseForPrompt(
  db: D1Database,
  promptId: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM checkin_response WHERE prompt_id = ?")
    .bind(promptId)
    .run();
}

export async function expireStalePrompts(
  db: D1Database,
  nowIso: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE checkin_prompt
       SET status = 'expired'
       WHERE status = 'sent' AND expires_at IS NOT NULL AND expires_at < ?`,
    )
    .bind(nowIso)
    .run();
  return result.meta.changes ?? 0;
}

export async function listResponses(
  db: D1Database,
  from?: string,
  to?: string,
): Promise<ResponseRow[]> {
  let query =
    "SELECT id, prompt_id, feeling, intensity, note, confidence, vocab_era, observed_at, submitted_at FROM checkin_response";
  const conditions: string[] = [];
  const bindings: string[] = [];

  if (from) {
    conditions.push("observed_at >= ?");
    bindings.push(from);
  }
  if (to) {
    conditions.push("observed_at <= ?");
    bindings.push(to);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(" AND ")}`;
  }
  query += " ORDER BY observed_at ASC";

  const statement = db.prepare(query);
  const result = await statement.bind(...bindings).all<ResponseRow>();
  return result.results ?? [];
}

/**
 * `checkin_prompt` is bounded by a watermark — the manifest's
 * extraction_timestamp — rather than read as "everything right now". The
 * scheduled handler captures that instant before it does any work, so rows can
 * land while the run is still in progress; without the bound the snapshot would
 * include rows stamped after the timestamp the manifest claims. `created_at` is
 * never rewritten, so the bound only ever excludes rows that did not exist at
 * the watermark. In practice it excludes nothing mid-run: the scheduler stamps
 * created_at from the same `now` the watermark comes from, so prompts it creates
 * during this run sit exactly on the boundary and are included.
 *
 * `checkin_response` is deliberately NOT bounded. Its only candidate column,
 * submitted_at, is mutable: re-answering upserts the row and moves submitted_at
 * forward, so a bound on it drops responses that existed long before the
 * watermark and makes them look deleted for that slot — worse than the
 * over-inclusion it would prevent, and invisible to every count check, since
 * the COUNT carries the same predicate. observed_at is no better: it derives
 * from prompt.sent_at and would admit responses that did not exist yet.
 * Bounding responses correctly needs an immutable creation or commit column
 * (issue #62). Until then a response written mid-run lands in this slot while
 * falling outside the manifest's timestamp.
 */
export async function listAllPromptsForExport(
  db: D1Database,
  watermark: string,
): Promise<ExportedPromptRow[]> {
  const result = await db
    .prepare(
      `SELECT id, scheduled_for, sent_at, expires_at, status, created_at
       FROM checkin_prompt
       WHERE created_at <= ?
       ORDER BY created_at ASC`,
    )
    .bind(watermark)
    .all<ExportedPromptRow>();
  return result.results ?? [];
}

export async function listAllResponsesForExport(
  db: D1Database,
): Promise<ExportedResponseRow[]> {
  const result = await db
    .prepare(
      `SELECT id, prompt_id, feeling, intensity, note, confidence, vocab_era, observed_at, submitted_at
       FROM checkin_response
       ORDER BY observed_at ASC`,
    )
    .all<ExportedResponseRow>();
  return result.results ?? [];
}

export async function countAllPromptsForExport(
  db: D1Database,
  watermark: string,
): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS row_count FROM checkin_prompt WHERE created_at <= ?")
    .bind(watermark)
    .first<{ row_count: number }>();
  return row?.row_count ?? 0;
}

export async function countAllResponsesForExport(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS row_count FROM checkin_response")
    .first<{ row_count: number }>();
  return row?.row_count ?? 0;
}

export async function listSentPromptsBetween(
  db: D1Database,
  fromIso: string,
  toIsoExclusive: string,
): Promise<PromptRow[]> {
  const result = await db
    .prepare(
      `SELECT id, scheduled_for, sent_at, expires_at, response_token, notification_id, status, created_at
       FROM checkin_prompt
       WHERE scheduled_for >= ? AND scheduled_for < ? AND sent_at IS NOT NULL
       ORDER BY scheduled_for ASC`,
    )
    .bind(fromIso, toIsoExclusive)
    .all<PromptRow>();
  return result.results ?? [];
}

export async function listResponsesForSentPromptsBetween(
  db: D1Database,
  fromIso: string,
  toIsoExclusive: string,
): Promise<ResponseRow[]> {
  const result = await db
    .prepare(
      `SELECT r.id, r.prompt_id, r.feeling, r.intensity, r.note, r.confidence, r.vocab_era, r.observed_at, r.submitted_at
       FROM checkin_response r
       WHERE r.prompt_id IN (
         SELECT id FROM checkin_prompt
         WHERE scheduled_for >= ? AND scheduled_for < ? AND sent_at IS NOT NULL
       )
       ORDER BY r.observed_at ASC`,
    )
    .bind(fromIso, toIsoExclusive)
    .all<ResponseRow>();
  return result.results ?? [];
}

export async function insertWeeklySummary(
  db: D1Database,
  id: string,
  sentAt: string,
): Promise<boolean> {
  const result = await db
    .prepare("INSERT OR IGNORE INTO weekly_summary (id, sent_at) VALUES (?, ?)")
    .bind(id, sentAt)
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function deleteWeeklySummary(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM weekly_summary WHERE id = ?").bind(id).run();
}

export interface PromptStatusRow {
  id: string;
  status: PromptStatus;
  expires_at: string | null;
}

/**
 * Prompts whose id falls in `[startId, endIdExclusive)` — prompt ids are
 * `prompt-YYYY-MM-DD-wN`, so a date prefix range is a London-calendar range.
 */
export async function listPromptsInIdRange(
  db: D1Database,
  startId: string,
  endIdExclusive: string,
): Promise<PromptStatusRow[]> {
  const result = await db
    .prepare(
      `SELECT id, status, expires_at
       FROM checkin_prompt
       WHERE id >= ? AND id < ?
       ORDER BY id ASC`,
    )
    .bind(startId, endIdExclusive)
    .all<PromptStatusRow>();
  return result.results ?? [];
}

export type AlertNotifiedStatus = "ok" | "breach";

/** Latest closed delivered prompts, newest first; open and failed sends are skipped. */
export async function listRecentClosedPrompts(
  db: D1Database,
  nowIso: string,
  limit: number,
): Promise<PromptStatusRow[]> {
  const result = await db
    .prepare(
      `SELECT id, status, expires_at FROM checkin_prompt
       WHERE scheduled_for <= ? AND (
         status IN ('answered', 'declined', 'expired')
         OR (status = 'sent' AND expires_at < ?)
       )
       ORDER BY scheduled_for DESC, id DESC
       LIMIT ?`,
    )
    .bind(nowIso, nowIso, limit)
    .all<PromptStatusRow>();
  return result.results ?? [];
}

export interface AlertStateRow {
  id: string;
  notified_status: AlertNotifiedStatus | null;
  evaluated_at: string;
  answered: number;
  sent: number;
  rate: number | null;
  window_from: string;
  window_to: string;
}

export async function getAlertState(
  db: D1Database,
  id: string,
): Promise<AlertStateRow | null> {
  return db
    .prepare(
      `SELECT id, notified_status, evaluated_at, answered, sent, rate, window_from, window_to
       FROM checkin_alert_state
       WHERE id = ?`,
    )
    .bind(id)
    .first<AlertStateRow>();
}

export async function upsertAlertState(
  db: D1Database,
  row: AlertStateRow,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO checkin_alert_state
        (id, notified_status, evaluated_at, answered, sent, rate, window_from, window_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         notified_status = excluded.notified_status,
         evaluated_at = excluded.evaluated_at,
         answered = excluded.answered,
         sent = excluded.sent,
         rate = excluded.rate,
         window_from = excluded.window_from,
         window_to = excluded.window_to`,
    )
    .bind(
      row.id,
      row.notified_status,
      row.evaluated_at,
      row.answered,
      row.sent,
      row.rate,
      row.window_from,
      row.window_to,
    )
    .run();
}
