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
