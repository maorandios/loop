export const INSTRUCTION_MIN = 1;
export const INSTRUCTION_MAX = 280;
export const REVISION_NOTE_MIN = 1;
export const REVISION_NOTE_MAX = 500;

export type SendFormInput = {
  recipientMemberId: string | null;
  instruction: string;
  picked: { selectionId: string } | null;
};

export type SendFormError =
  | "recipient_required"
  | "file_required"
  | "instruction_required"
  | "instruction_too_long";

export type RevisionNoteError = "revision_note_required" | "revision_note_too_long";

export function validateSendForm(input: SendFormInput): SendFormError | null {
  if (!input.recipientMemberId) {
    return "recipient_required";
  }
  if (!input.picked) {
    return "file_required";
  }
  const instruction = input.instruction.trim();
  if (instruction.length < INSTRUCTION_MIN) {
    return "instruction_required";
  }
  if (instruction.length > INSTRUCTION_MAX) {
    return "instruction_too_long";
  }
  return null;
}

export function validateRevisionNote(note: string): RevisionNoteError | null {
  const trimmed = note.trim();
  if (trimmed.length < REVISION_NOTE_MIN) {
    return "revision_note_required";
  }
  if (trimmed.length > REVISION_NOTE_MAX) {
    return "revision_note_too_long";
  }
  return null;
}

export function normalizeDueOn(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
