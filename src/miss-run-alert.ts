import { noticeForTransition } from "./answer-rate-alert";
import { MISS_RUN_ALERT_ID, MISS_RUN_THRESHOLD } from "./config";
import { log } from "./logger";
import { Notifier } from "./notifier";
import {
  closedPromptOutcome,
  getAlertState,
  listRecentClosedPrompts,
  upsertAlertState,
} from "./store";

export async function runMissRunAlert(
  env: { DB: D1Database },
  notifier: Notifier,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const prompts = await listRecentClosedPrompts(env.DB, nowIso, MISS_RUN_THRESHOLD);
  const closed = prompts.flatMap((prompt) => {
    const outcome = closedPromptOutcome(prompt.status, prompt.expires_at, nowIso);
    return outcome === null ? [] : [{ prompt, outcome }];
  });
  const answered = closed.filter(({ outcome }) => outcome === "answered").length;
  const status = answered > 0 ? "ok"
    : closed.length >= MISS_RUN_THRESHOLD ? "breach" : "unevaluable";
  const previous = await getAlertState(env.DB, MISS_RUN_ALERT_ID);
  let notifiedStatus = previous?.notified_status ?? null;
  const notice = noticeForTransition(notifiedStatus, status);

  log("info", "miss_run_evaluated", {
    alert_id: MISS_RUN_ALERT_ID,
    status,
    answered,
    closed: closed.length,
  });

  if (notice) {
    if (!notifier.deliversNotifications) {
      log("info", "miss_run_alert_skipped", { notice, reason: "no_delivering_notifier" });
    } else {
      try {
        await notifier.sendAlert(
          "checkin missed prompts",
          notice === "breach"
            ? `At least ${MISS_RUN_THRESHOLD} consecutive check-in prompts were expired or declined.`
            : "A check-in prompt was answered. The unanswered prompt run has ended.",
        );
        notifiedStatus = notice === "breach" ? "breach" : "ok";
        log("info", "miss_run_alert_sent", { notice });
      } catch (error) {
        log("error", "miss_run_alert_failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
    }
  } else if (status !== "unevaluable") {
    notifiedStatus = status;
  }

  await upsertAlertState(env.DB, {
    id: MISS_RUN_ALERT_ID,
    notified_status: notifiedStatus,
    evaluated_at: nowIso,
    answered,
    sent: closed.length,
    rate: null,
    window_from: closed.at(-1)?.prompt.id.slice(7, 17) ?? nowIso.slice(0, 10),
    window_to: closed[0]?.prompt.id.slice(7, 17) ?? nowIso.slice(0, 10),
  });
}
