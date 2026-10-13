import {
  DEFAULT_WINDOWS,
  PROMPT_DAY_END,
  PROMPT_DAY_START,
  ScheduleWindow,
  parseClock,
  parseWindows,
} from "./config";
import { getLondonParts, londonInstant } from "./london-time";
import { log } from "./logger";
import { Notifier } from "./notifier";
import { createResponseToken } from "./token";
import {
  PromptRow,
  expireStalePrompts,
  getPromptById,
  insertPrompt,
  promptId,
  updatePromptStatus,
} from "./store";
import { expiresAtFrom } from "./record-response";

export interface SchedulerEnv {
  DB: D1Database;
  SCHEDULE_WINDOWS?: string;
  BASE_URL: string;
  PUSHOVER_TOKEN?: string;
  PUSHOVER_USER?: string;
}

/** Matches wrangler.toml production cron: every 15 minutes. */
export const CRON_PERIOD_MINUTES = 15;

export function pickTargetMinutes(window: ScheduleWindow, dateKey: string): number {
  const span = Math.max(window.endMinutes - window.startMinutes, 1);
  const input = `${dateKey}:${window.index}`;
  let hash = 0;
  for (const char of input) {
    hash = (hash * 31 + char.charCodeAt(0)) % span;
  }
  return window.startMinutes + hash;
}

export function isWithinPromptDay(minutesOfDay: number): boolean {
  const start = parseClock(PROMPT_DAY_START);
  const end = parseClock(PROMPT_DAY_END);
  return minutesOfDay >= start && minutesOfDay < end;
}

/**
 * Exclusive window end + a 15-minute cron means any target in the last
 * cron period is unreachable unless this tick still sends. `now + period`
 * landing at or past `endMinutes` is the last in-window opportunity.
 */
export function isLastWindowOpportunity(
  minutesOfDay: number,
  window: ScheduleWindow,
  cronPeriodMinutes = CRON_PERIOD_MINUTES,
): boolean {
  return minutesOfDay + cronPeriodMinutes >= window.endMinutes;
}

export type SchedulerTimeDecision =
  | { action: "outside_active_hours"; dateKey: string; minutesOfDay: number }
  | { action: "no_matching_window"; dateKey: string; minutesOfDay: number }
  | {
      action: "before_target";
      dateKey: string;
      minutesOfDay: number;
      window: ScheduleWindow;
      targetMinutes: number;
    }
  | {
      action: "due";
      dateKey: string;
      minutesOfDay: number;
      window: ScheduleWindow;
      targetMinutes: number;
      lastOpportunity: boolean;
    };

export function decideSchedulerTick(
  now: Date,
  scheduleWindows: string,
  cronPeriodMinutes = CRON_PERIOD_MINUTES,
): SchedulerTimeDecision {
  const london = getLondonParts(now);
  if (!isWithinPromptDay(london.minutesOfDay)) {
    return {
      action: "outside_active_hours",
      dateKey: london.dateKey,
      minutesOfDay: london.minutesOfDay,
    };
  }

  const windows = parseWindows(scheduleWindows);
  for (const window of windows) {
    if (
      london.minutesOfDay < window.startMinutes ||
      london.minutesOfDay >= window.endMinutes
    ) {
      continue;
    }

    const targetMinutes = pickTargetMinutes(window, london.dateKey);
    if (london.minutesOfDay < targetMinutes) {
      if (!isLastWindowOpportunity(london.minutesOfDay, window, cronPeriodMinutes)) {
        return {
          action: "before_target",
          dateKey: london.dateKey,
          minutesOfDay: london.minutesOfDay,
          window,
          targetMinutes,
        };
      }
      return {
        action: "due",
        dateKey: london.dateKey,
        minutesOfDay: london.minutesOfDay,
        window,
        targetMinutes,
        lastOpportunity: true,
      };
    }

    return {
      action: "due",
      dateKey: london.dateKey,
      minutesOfDay: london.minutesOfDay,
      window,
      targetMinutes,
      lastOpportunity: false,
    };
  }

  return {
    action: "no_matching_window",
    dateKey: london.dateKey,
    minutesOfDay: london.minutesOfDay,
  };
}

async function sendPrompt(
  env: SchedulerEnv,
  notifier: Notifier,
  row: PromptRow,
  now: Date,
): Promise<void> {
  const checkinUrl = `${env.BASE_URL.replace(/\/$/, "")}/c/${row.response_token}`;
  try {
    const notification = await notifier.sendCheckin(checkinUrl);
    const sentAt = now.toISOString();
    await updatePromptStatus(env.DB, row.id, "sent", {
      sent_at: sentAt,
      expires_at: expiresAtFrom(now),
      notification_id: notification.id,
    });
    log("info", "prompt_sent", { prompt_id: row.id, notification_id: notification.id });
  } catch (error) {
    await updatePromptStatus(env.DB, row.id, "failed");
    log("error", "notification_failed", {
      prompt_id: row.id,
      error: error instanceof Error ? error.message : "unknown",
    });
  }
}

export async function runScheduler(
  env: SchedulerEnv,
  notifier: Notifier,
  now: Date,
): Promise<void> {
  const nowIso = now.toISOString();
  const expired = await expireStalePrompts(env.DB, nowIso);
  if (expired > 0) {
    log("info", "prompts_expired", { count: expired });
  }

  const decision = decideSchedulerTick(now, env.SCHEDULE_WINDOWS ?? DEFAULT_WINDOWS);
  if (decision.action === "outside_active_hours") {
    log("info", "scheduler_skipped", { reason: "outside_active_hours" });
    return;
  }
  if (decision.action === "no_matching_window") {
    log("info", "scheduler_skipped", {
      reason: "no_matching_window",
      date_key: decision.dateKey,
      minutes_of_day: decision.minutesOfDay,
    });
    return;
  }
  if (decision.action === "before_target") {
    log("info", "scheduler_skipped", {
      reason: "before_target",
      date_key: decision.dateKey,
      window: decision.window.index,
      minutes_of_day: decision.minutesOfDay,
      target_minutes: decision.targetMinutes,
    });
    return;
  }

  if (decision.lastOpportunity) {
    log("info", "scheduler_last_opportunity", {
      date_key: decision.dateKey,
      window: decision.window.index,
      minutes_of_day: decision.minutesOfDay,
      target_minutes: decision.targetMinutes,
    });
  }

  const { dateKey, window, targetMinutes } = decision;
  const id = promptId(dateKey, window.index);
  const existing = await getPromptById(env.DB, id);
  if (existing && existing.status !== "scheduled") {
    log("info", "scheduler_skipped", {
      reason: "already_final",
      prompt_id: id,
      status: existing.status,
    });
    return;
  }

  if (existing?.status === "scheduled") {
    await sendPrompt(env, notifier, existing, now);
    return;
  }

  const scheduledFor = londonInstant(dateKey, targetMinutes, now).toISOString();
  const row: PromptRow = {
    id,
    scheduled_for: scheduledFor,
    sent_at: null,
    expires_at: null,
    response_token: createResponseToken(),
    notification_id: null,
    status: "scheduled",
    created_at: nowIso,
  };

  const inserted = await insertPrompt(env.DB, row);
  if (!inserted) {
    log("info", "scheduler_skipped", { reason: "insert_conflict", prompt_id: id });
    return;
  }

  await sendPrompt(env, notifier, row, now);
}
