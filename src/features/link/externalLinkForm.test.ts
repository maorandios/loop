import { describe, expect, it } from "vitest";
import {
  addDays,
  addEmailChip,
  canCreateExternalLink,
  clampExpiry,
  datetimeLocalValue,
  expiresAtFromPreset,
  formatFileSize,
  formatLinkExpiryParts,
  isExpiryAllowed,
  isValidEmail,
  maxExpiryAt,
  parseEmailTokens,
} from "./externalLinkForm";

const now = new Date("2026-09-09T14:30:00");

describe("external link form", () => {
  it("accepts only well-formed emails", () => {
    expect(isValidEmail("name@company.com")).toBe(true);
    expect(isValidEmail("bad@")).toBe(false);
    expect(parseEmailTokens("a@b.com, c@d.com")).toEqual(["a@b.com", "c@d.com"]);
    expect(addEmailChip([], "oops").invalid).toBe("oops");
    expect(addEmailChip(["a@b.com"], "a@b.com").emails).toEqual(["a@b.com"]);
    expect(addEmailChip([], "name@company.com").emails).toEqual(["name@company.com"]);
  });

  it("computes expiry presets and rejects past or over-policy dates", () => {
    const max = maxExpiryAt(now, "anyone");
    expect(expiresAtFromPreset("7d", "", now)?.getTime()).toBe(addDays(now, 7).getTime());
    expect(isExpiryAllowed(addDays(now, -1), now, max)).toBe(false);
    expect(isExpiryAllowed(addDays(now, 40), now, max)).toBe(false);
    expect(isExpiryAllowed(addDays(now, 7), now, max)).toBe(true);
    expect(clampExpiry(addDays(now, 40), now, max).getTime()).toBe(max.getTime());
    expect(datetimeLocalValue(now)).toBe("2026-09-09T14:30");
    expect(formatLinkExpiryParts(addDays(now, 7))).toEqual({
      date: "16 בספטמבר",
      time: "14:30",
    });
  });

  it("enables create only with file, access, emails, and valid expiry", () => {
    const file = {
      name: "a.pdf",
      size: 12,
      source: "computer" as const,
      provider: "sharepoint" as const,
    };
    const max = maxExpiryAt(now, "anyone");
    expect(
      canCreateExternalLink({
        file: null,
        access: "anyone",
        validEmails: [],
        expiresAt: addDays(now, 7),
        now,
        maxExpiresAt: max,
      }),
    ).toBe(false);
    expect(
      canCreateExternalLink({
        file,
        access: "people",
        validEmails: [],
        expiresAt: addDays(now, 7),
        now,
        maxExpiresAt: max,
      }),
    ).toBe(false);
    expect(
      canCreateExternalLink({
        file,
        access: "anyone",
        validEmails: [],
        expiresAt: addDays(now, 7),
        now,
        maxExpiresAt: max,
      }),
    ).toBe(true);
    expect(formatFileSize(2_450_112)).toBe("2.3 MB");
  });
});
