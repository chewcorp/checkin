import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MISS_RUN_ALERT_ID, MISS_RUN_THRESHOLD } from "../src/config";
import { runMissRunAlert } from "../src/miss-run-alert";
import { NoopNotifier } from "../src/notifier";
import { getAlertState, insertPrompt, PromptStatus } from "../src/store";

describe("runMissRunAlert", () => {
  const now = new Date("2026-11-06T12:00:00.000Z");
  const sendAlert = vi.fn(async (_title: string, _message: string) => ({ id: "alert" }));
  const notifier = {
    deliversNotifications: true,
    sendAlert,
    sendCheckin: async () => ({ id: "checkin" }),
    sendWeeklySummary: async () => ({ id: "weekly" }),
  };

  beforeEach(async () => {
    sendAlert.mockClear();
    await env.DB.prepare("DELETE FROM checkin_alert_state").run();
    await env.DB.prepare("DELETE FROM checkin_response").run();
    await env.DB.prepare("DELETE FROM checkin_prompt").run();
  });

  async function seed(day: number, status: PromptStatus, expiresAt = "2026-11-06T11:00:00.000Z") {
    const date = `2026-10-${String(day).padStart(2, "0")}`;
    const id = `prompt-${date}-w0`;
    await insertPrompt(env.DB, {
      id,
      status,
      scheduled_for: `${date}T09:00:00.000Z`,
      sent_at: status === "failed" || status === "scheduled" ? null : `${date}T09:00:00.000Z`,
      expires_at: expiresAt,
      response_token: id,
      notification_id: null,
      created_at: `${date}T09:00:00.000Z`,
    });
  }

  async function seedRun() {
    await seed(1, "expired");
    await seed(2, "declined");
    await seed(3, "expired");
  }

  it("notifies once for three misses, not again for a fourth, then recovers once and rearms", async () => {
    expect(MISS_RUN_THRESHOLD).toBe(3);
    await seedRun();
    await runMissRunAlert(env, notifier, now);
    await runMissRunAlert(env, notifier, now);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect(sendAlert.mock.calls[0][1]).toContain("3 consecutive");
    expect((await getAlertState(env.DB, MISS_RUN_ALERT_ID))?.notified_status).toBe("breach");

    await seed(4, "expired");
    await runMissRunAlert(env, notifier, now);
    expect(sendAlert).toHaveBeenCalledTimes(1);

    await seed(5, "answered");
    await runMissRunAlert(env, notifier, now);
    await runMissRunAlert(env, notifier, now);
    expect(sendAlert).toHaveBeenCalledTimes(2);
    expect(sendAlert.mock.calls[1][1]).toContain("run has ended");
    expect((await getAlertState(env.DB, MISS_RUN_ALERT_ID))?.notified_status).toBe("ok");

    for (const day of [6, 7, 8]) await seed(day, "declined");
    await runMissRunAlert(env, notifier, now);
    expect(sendAlert).toHaveBeenCalledTimes(3);
  });

  it("skips failed, scheduled and open sent prompts without breaking or extending a run", async () => {
    // Insert out of order; evaluate by prompt order, not insertion order or a fortnight window.
    await seed(5, "declined");
    await seed(2, "failed");
    await seed(1, "expired");
    await seed(4, "sent", "2026-11-07T12:00:00.000Z");
    await seed(3, "scheduled");
    await runMissRunAlert(env, notifier, now);
    expect(sendAlert).not.toHaveBeenCalled();

    await seed(6, "sent"); // Overdue sent has the same outcome as expired.
    await runMissRunAlert(env, notifier, now);
    expect(sendAlert).toHaveBeenCalledTimes(1);
    expect((await getAlertState(env.DB, MISS_RUN_ALERT_ID))?.sent).toBe(3);
  });

  it("does not alert for an empty history or misses interrupted by an answer", async () => {
    await runMissRunAlert(env, notifier, now);
    await seed(1, "expired");
    await seed(2, "answered");
    await seed(3, "declined");
    await seed(4, "expired");
    await runMissRunAlert(env, notifier, now);
    expect(sendAlert).not.toHaveBeenCalled();
  });

  it("retries failed delivery and never marks a noop notification as delivered", async () => {
    await seedRun();
    await runMissRunAlert(env, new NoopNotifier(), now);
    expect((await getAlertState(env.DB, MISS_RUN_ALERT_ID))?.notified_status).toBeNull();
    sendAlert.mockRejectedValueOnce(new Error("pushover down"));
    await runMissRunAlert(env, notifier, now);
    expect((await getAlertState(env.DB, MISS_RUN_ALERT_ID))?.notified_status).toBeNull();
    await runMissRunAlert(env, notifier, now);
    expect((await getAlertState(env.DB, MISS_RUN_ALERT_ID))?.notified_status).toBe("breach");

    await seed(4, "answered");
    sendAlert.mockRejectedValueOnce(new Error("pushover down"));
    await runMissRunAlert(env, notifier, now);
    expect((await getAlertState(env.DB, MISS_RUN_ALERT_ID))?.notified_status).toBe("breach");
    await runMissRunAlert(env, notifier, now);
    expect((await getAlertState(env.DB, MISS_RUN_ALERT_ID))?.notified_status).toBe("ok");
  });
});
