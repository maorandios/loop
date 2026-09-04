import { describe, expect, it } from "vitest";
import { he } from "../../copy/he";
import { visibleHistory } from "./history";
import type { HandoffRecord } from "./types";

function record(partial: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    id: "handoff-1",
    workspaceId: "workspace-1",
    senderMemberId: "sender",
    recipientMemberId: "recipient",
    originalFilename: "דוח.docx",
    instruction: "נא לבדוק את המספרים",
    dueOn: null,
    status: "completed",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
    fileSize: 1,
    blake3: "aa",
    storagePath: "p",
    returnFileSize: 2,
    returnBlake3: "bb",
    returnStoragePath: "p2",
    versions: [],
    events: [],
    ...partial,
  };
}

describe("handoff history", () => {
  it("shows versions and notes in Hebrew and hides internal events", () => {
    const lines = visibleHistory(
      record({
        events: [
          {
            eventType: "finalized",
            note: null,
            versionNumber: 1,
            actorMemberId: "sender",
            createdAt: "2026-09-01T08:00:00.000Z",
          },
          {
            eventType: "received",
            note: null,
            versionNumber: null,
            actorMemberId: "recipient",
            createdAt: "2026-09-01T09:00:00.000Z",
          },
          {
            eventType: "opened",
            note: null,
            versionNumber: null,
            actorMemberId: "recipient",
            createdAt: "2026-09-01T10:00:00.000Z",
          },
          {
            eventType: "modified",
            note: null,
            versionNumber: null,
            actorMemberId: "recipient",
            createdAt: "2026-09-01T11:00:00.000Z",
          },
          {
            eventType: "returning",
            note: null,
            versionNumber: 2,
            actorMemberId: "recipient",
            createdAt: "2026-09-01T12:00:00.000Z",
          },
          {
            eventType: "returned",
            note: null,
            versionNumber: 3,
            actorMemberId: "recipient",
            createdAt: "2026-09-01T13:00:00.000Z",
          },
          {
            eventType: "revision_requested",
            note: "חסר החתימה בעמוד 2",
            versionNumber: 3,
            actorMemberId: "sender",
            createdAt: "2026-09-01T14:00:00.000Z",
          },
          {
            eventType: "completed",
            note: null,
            versionNumber: 4,
            actorMemberId: "sender",
            createdAt: "2026-09-01T15:00:00.000Z",
          },
        ],
      }),
    );

    expect(lines.map((line) => line.title)).toEqual([
      he.historySent,
      he.historyOpened,
      he.historyModified,
      "הוחזר · גרסה 3",
      he.historyRevisionRequested,
      he.historyCompleted,
    ]);
    expect(lines[0]?.detail).toBe("נא לבדוק את המספרים");
    expect(lines[4]?.detail).toBe("חסר החתימה בעמוד 2");
    expect(lines.some((line) => line.eventType === "returning")).toBe(false);
    expect(lines.some((line) => line.eventType === "received")).toBe(false);
    expect(lines.map((line) => line.title).join(" ")).not.toMatch(
      /returning|received|finalized|modified|completed|revision_requested/,
    );
  });
});
