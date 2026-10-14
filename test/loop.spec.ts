import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { NoopNotifier } from "../src/notifier";
import { runScheduler } from "../src/scheduler";

describe("scheduler idempotency", () => {
  it("creates at most one prompt per window per day", async () => {
    const notifier = new NoopNotifier();
    const now = new Date("2026-08-13T09:45:00.000Z");

    await runScheduler(env, notifier, now);
    await runScheduler(env, notifier, now);

    const result = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM checkin_prompt WHERE id = ?",
    )
      .bind("prompt-2026-08-13-w0")
      .first<{ count: number }>();

    expect(result?.count).toBe(1);
  });
});

describe("overlapping schedule windows", () => {
  it("sends a due window an earlier before-target window would hide", async () => {
    const notifier = new NoopNotifier();
    const overlapEnv = {
      ...env,
      SCHEDULE_WINDOWS: "09:00-11:00,09:00-10:00",
    };
    const now = new Date("2026-10-10T08:45:00.000Z");

    await env.DB.prepare("DELETE FROM checkin_prompt WHERE id LIKE ?")
      .bind("prompt-2026-10-10-w%")
      .run();

    // 09:45 London: w0 target 10:52 is before_target; w1 target 09:53 is on
    // its last in-window tick, so only w1 sends.
    await runScheduler(overlapEnv, notifier, now);

    const rows = await env.DB.prepare(
      "SELECT id, scheduled_for, sent_at, status FROM checkin_prompt WHERE id LIKE ? ORDER BY id",
    )
      .bind("prompt-2026-10-10-w%")
      .all<{
        id: string;
        scheduled_for: string;
        sent_at: string | null;
        status: string;
      }>();

    expect(rows.results.map((row) => row.id)).toEqual(["prompt-2026-10-10-w1"]);
    const row = rows.results[0];
    expect(row?.status).toBe("sent");
    // A last-opportunity send fires before the hashed target, so
    // scheduled_for clamps to the send tick (not 09:53 London) to keep
    // scheduled_for at or before sent_at for the drift check.
    expect(row?.scheduled_for).toBe("2026-10-10T08:45:00.000Z");
    expect(row?.sent_at).toBe("2026-10-10T08:45:00.000Z");
  });

  it("sends every due window on the same tick", async () => {
    const notifier = new NoopNotifier();
    const overlapEnv = {
      ...env,
      SCHEDULE_WINDOWS: "09:00-11:00,09:00-11:00",
    };
    const now = new Date("2026-08-14T08:15:00.000Z");

    await env.DB.prepare("DELETE FROM checkin_prompt WHERE id LIKE ?")
      .bind("prompt-2026-08-14-w%")
      .run();

    await runScheduler(overlapEnv, notifier, now);

    const result = await env.DB.prepare(
      "SELECT COUNT(*) as count FROM checkin_prompt WHERE id LIKE ? AND status = 'sent'",
    )
      .bind("prompt-2026-08-14-w%")
      .first<{ count: number }>();
    expect(result?.count).toBe(2);
  });
});

describe("prompt scheduled_for ordering", () => {
  it("keeps the hashed target for a normal due send", async () => {
    const notifier = new NoopNotifier();
    const now = new Date("2026-08-13T09:45:00.000Z");

    await env.DB.prepare("DELETE FROM checkin_prompt WHERE id = ?")
      .bind("prompt-2026-08-13-w0")
      .run();
    await runScheduler(env, notifier, now);

    const row = await env.DB.prepare(
      "SELECT scheduled_for, sent_at FROM checkin_prompt WHERE id = ?",
    )
      .bind("prompt-2026-08-13-w0")
      .first<{ scheduled_for: string; sent_at: string }>();
    // w0 target is 09:02 London (08:02 UTC) on 13 Aug — before the send tick.
    expect(row?.scheduled_for).toBe("2026-08-13T08:02:00.000Z");
    expect(row?.sent_at).toBe("2026-08-13T09:45:00.000Z");
  });
});

describe("scheduler last-opportunity catch-up", () => {
  it("creates 10-13 Oct prompts on the last in-window cron tick", async () => {
    const notifier = new NoopNotifier();
    const dates = ["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13"];
    for (const dateKey of dates) {
      for (const window of [0, 1, 2]) {
        await env.DB.prepare("DELETE FROM checkin_prompt WHERE id = ?")
          .bind(`prompt-${dateKey}-w${window}`)
          .run();
      }
    }

    const start = Date.parse("2026-10-10T07:00:00.000Z");
    const end = Date.parse("2026-10-13T18:00:00.000Z");
    for (let t = start; t <= end; t += 15 * 60_000) {
      await runScheduler(env, notifier, new Date(t));
    }

    for (const dateKey of dates) {
      const result = await env.DB.prepare(
        "SELECT COUNT(*) as count FROM checkin_prompt WHERE id LIKE ?",
      )
        .bind(`prompt-${dateKey}-w%`)
        .first<{ count: number }>();
      expect({ dateKey, count: result?.count }).toEqual({ dateKey, count: 3 });
    }
  });
});
