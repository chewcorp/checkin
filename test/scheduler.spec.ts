import { describe, expect, it } from "vitest";
import { DEFAULT_WINDOWS, parseClock, parseWindows } from "../src/config";
import { getLondonParts } from "../src/london-time";
import {
  decideSchedulerTick,
  isLastWindowOpportunity,
  isWithinPromptDay,
  pickTargetMinutes,
} from "../src/scheduler";

describe("london time", () => {
  it("handles BST during summer", () => {
    const parts = getLondonParts(new Date("2026-07-15T10:30:00.000Z"));
    expect(parts.hour).toBe(11);
    expect(parts.minute).toBe(30);
  });

  it("handles GMT after autumn transition", () => {
    const parts = getLondonParts(new Date("2026-11-15T10:30:00.000Z"));
    expect(parts.hour).toBe(10);
    expect(parts.minute).toBe(30);
  });

  it("handles spring forward boundary day", () => {
    const parts = getLondonParts(new Date("2026-03-29T12:00:00.000Z"));
    expect(parts.dateKey).toBe("2026-03-29");
    expect(parts.minutesOfDay).toBeGreaterThanOrEqual(0);
  });

  it("handles autumn fallback boundary day", () => {
    const parts = getLondonParts(new Date("2026-10-25T12:00:00.000Z"));
    expect(parts.dateKey).toBe("2026-10-25");
    expect(parts.minutesOfDay).toBeGreaterThanOrEqual(0);
  });
});

describe("scheduler helpers", () => {
  it("parses configured windows", () => {
    const windows = parseWindows("09:00-11:00,13:00-15:00");
    expect(windows).toHaveLength(2);
    expect(windows[0].startMinutes).toBe(parseClock("09:00"));
  });

  it("picks a stable target minute within the window", () => {
    const windows = parseWindows("09:00-11:00");
    const first = pickTargetMinutes(windows[0], "2026-08-13");
    const second = pickTargetMinutes(windows[0], "2026-08-13");
    expect(first).toBe(second);
    expect(first).toBeGreaterThanOrEqual(9 * 60);
    expect(first).toBeLessThan(11 * 60);
  });

  it("restricts active prompt hours to 08:00-20:00", () => {
    expect(isWithinPromptDay(parseClock("07:59"))).toBe(false);
    expect(isWithinPromptDay(parseClock("08:00"))).toBe(true);
    expect(isWithinPromptDay(parseClock("19:59"))).toBe(true);
    expect(isWithinPromptDay(parseClock("20:00"))).toBe(false);
  });
});

describe("scheduler tick decisions (Oct 2026 dead zone)", () => {
  const windows = parseWindows(DEFAULT_WINDOWS);

  it("hashes 10 Oct into the last 15 minutes of every window", () => {
    // Production sent 9 Oct w2 at 17:46Z (18:46 BST) because the target was 18:32.
    // The 09→10 date-digit rollover jumps ~22 minutes, past the last in-window
    // 15-minute tick (10:45 / 14:45 / 18:45 London). Exclusive end then skips 11:00.
    expect(pickTargetMinutes(windows[0], "2026-10-09")).toBe(parseClock("10:30"));
    expect(pickTargetMinutes(windows[1], "2026-10-09")).toBe(parseClock("14:31"));
    expect(pickTargetMinutes(windows[2], "2026-10-09")).toBe(parseClock("18:32"));
    expect(pickTargetMinutes(windows[0], "2026-10-10")).toBe(parseClock("10:52"));
    expect(pickTargetMinutes(windows[1], "2026-10-10")).toBe(parseClock("14:53"));
    expect(pickTargetMinutes(windows[2], "2026-10-10")).toBe(parseClock("18:54"));
    expect(isLastWindowOpportunity(parseClock("10:45"), windows[0])).toBe(true);
    expect(isLastWindowOpportunity(parseClock("10:30"), windows[0])).toBe(false);
  });

  it("names the skip at each 10-13 Oct tick a 15-minute cron would hit", () => {
    const ticks: { iso: string; action: string; lastOpportunity?: boolean }[] = [
      { iso: "2026-10-09T17:45:00.000Z", action: "due", lastOpportunity: false },
      { iso: "2026-10-10T06:00:00.000Z", action: "outside_active_hours" },
      { iso: "2026-10-10T09:30:00.000Z", action: "before_target" },
      { iso: "2026-10-10T09:45:00.000Z", action: "due", lastOpportunity: true },
      { iso: "2026-10-10T13:30:00.000Z", action: "before_target" },
      { iso: "2026-10-10T13:45:00.000Z", action: "due", lastOpportunity: true },
      { iso: "2026-10-10T15:00:00.000Z", action: "no_matching_window" },
      { iso: "2026-10-10T17:45:00.000Z", action: "due", lastOpportunity: true },
      { iso: "2026-10-11T19:00:00.000Z", action: "outside_active_hours" },
      { iso: "2026-10-13T09:45:00.000Z", action: "due", lastOpportunity: true },
      { iso: "2026-10-13T13:45:00.000Z", action: "due", lastOpportunity: true },
      { iso: "2026-10-13T17:15:00.000Z", action: "before_target" },
      { iso: "2026-10-13T17:45:00.000Z", action: "due", lastOpportunity: true },
    ];

    for (const tick of ticks) {
      const decision = decideSchedulerTick(new Date(tick.iso), DEFAULT_WINDOWS);
      expect({ iso: tick.iso, action: decision.action }).toEqual({
        iso: tick.iso,
        action: tick.action,
      });
      if (decision.action === "due") {
        expect(decision.lastOpportunity).toBe(tick.lastOpportunity);
      }
    }
  });
});
