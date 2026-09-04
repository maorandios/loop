import { describe, expect, it } from "vitest";
import { formatLocalDateTime } from "./dates";

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

  it("formats an older date in he-IL", () => {
    expect(formatLocalDateTime(new Date(2026, 8, 2, 11, 20), new Date(2026, 8, 10, 12, 0))).toBe(
      "2 בספטמבר 2026, 11:20",
    );
  });
});
