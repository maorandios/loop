import { describe, expect, it } from "vitest";
import { formatLocalDateTime, formatRelativeTime } from "./dates";
import { he } from "../copy/he";

describe("formatLocalDateTime", () => {
  const now = new Date(2026, 8, 2, 18, 0);

  it("formats today with a 24-hour clock", () => {
    expect(formatLocalDateTime(new Date(2026, 8, 2, 14, 35), now)).toBe(
      "היום, 14:35",
    );
  });

  it("formats yesterday with a 24-hour clock", () => {
    expect(formatLocalDateTime(new Date(2026, 8, 1, 9, 10), now)).toBe(
      "אתמול, 09:10",
    );
  });

  it("formats a relative time for recent activity", () => {
    expect(formatRelativeTime(new Date(2026, 8, 2, 17, 56), now)).toBe(
      he.minutesAgo.replace("{n}", "4"),
    );
    expect(formatRelativeTime(new Date(2026, 8, 1, 9, 10), now)).toBe(he.yesterday);
  });

  it("formats an older date in he-IL", () => {
    expect(formatLocalDateTime(new Date(2026, 8, 2, 11, 20), new Date(2026, 8, 10, 12, 0))).toBe(
      "2 בספטמבר 2026, 11:20",
    );
  });
});
