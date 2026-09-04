import { describe, expect, it } from "vitest";
import {
  INSTRUCTION_MAX,
  REVISION_NOTE_MAX,
  validateRevisionNote,
  validateSendForm,
} from "./sendForm";

describe("send form validation", () => {
  it("blocks send without a file, recipient, or instruction", () => {
    expect(
      validateSendForm({
        recipientMemberId: null,
        instruction: "בדוק",
        picked: { selectionId: "s1" },
      }),
    ).toBe("recipient_required");
    expect(
      validateSendForm({
        recipientMemberId: "member-2",
        instruction: "בדוק",
        picked: null,
      }),
    ).toBe("file_required");
    expect(
      validateSendForm({
        recipientMemberId: "member-2",
        instruction: "   ",
        picked: { selectionId: "s1" },
      }),
    ).toBe("instruction_required");
    expect(
      validateSendForm({
        recipientMemberId: "member-2",
        instruction: "ב".repeat(INSTRUCTION_MAX + 1),
        picked: { selectionId: "s1" },
      }),
    ).toBe("instruction_too_long");
    expect(
      validateSendForm({
        recipientMemberId: "member-2",
        instruction: "נא לבדוק",
        picked: { selectionId: "s1" },
      }),
    ).toBeNull();
  });

  it("blocks an empty or oversized revision note", () => {
    expect(validateRevisionNote("")).toBe("revision_note_required");
    expect(validateRevisionNote("   ")).toBe("revision_note_required");
    expect(validateRevisionNote("א".repeat(REVISION_NOTE_MAX + 1))).toBe(
      "revision_note_too_long",
    );
    expect(validateRevisionNote("חסר חתימה")).toBeNull();
  });
});
