import { describe, expect, it } from "vitest";
import { joinCodeHasChars, normalizeJoinCodeInput } from "./joinCode";

describe("join code input", () => {
  it("trims, removes spaces, and uppercases while keeping an optional hyphen", () => {
    expect(normalizeJoinCodeInput("  ab12-cd34  ")).toBe("AB12-CD34");
    expect(normalizeJoinCodeInput("ab12cd34")).toBe("AB12CD34");
    expect(normalizeJoinCodeInput("ab 12 cd 34")).toBe("AB12CD34");
  });

  it("rejects an empty or hyphen-only value", () => {
    expect(joinCodeHasChars("")).toBe(false);
    expect(joinCodeHasChars("   ")).toBe(false);
    expect(joinCodeHasChars("--")).toBe(false);
    expect(joinCodeHasChars("ab12-cd34")).toBe(true);
    expect(joinCodeHasChars("ab12cd34")).toBe(true);
  });
});
