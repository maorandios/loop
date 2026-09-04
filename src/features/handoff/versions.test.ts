import { describe, expect, it } from "vitest";
import type { HandoffRecord } from "./types";
import { latestHandoffVersion, versionLabel } from "./versions";

function row(partial: Partial<HandoffRecord>): HandoffRecord {
  return {
    id: "handoff-1",
    workspaceId: "workspace-1",
    senderMemberId: "sender",
    recipientMemberId: "recipient",
    originalFilename: "a.txt",
    instruction: null,
    dueOn: null,
    status: "returned",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    fileSize: 1,
    blake3: "aa",
    storagePath: "ws/h/v1/o",
    returnFileSize: 2,
    returnBlake3: "bb",
    returnStoragePath: "ws/h/v2/o",
    versions: [],
    events: [],
    ...partial,
  };
}

describe("handoff versions", () => {
  it("selects the highest approved version, not necessarily v2", () => {
    const latest = latestHandoffVersion(
      row({
        versions: [
          { versionNumber: 1, storagePath: "ws/h/v1/o", fileSize: 1, blake3: "aa" },
          { versionNumber: 2, storagePath: "ws/h/v2/o", fileSize: 2, blake3: "bb" },
          { versionNumber: 3, storagePath: "ws/h/v3/o", fileSize: 3, blake3: "cc" },
        ],
      }),
    );
    expect(latest?.versionNumber).toBe(3);
    expect(latest?.storagePath).toBe("ws/h/v3/o");
    expect(versionLabel(3)).toBe("v3");
  });

  it("still loads a legacy return_received pair of v1 and v2", () => {
    const latest = latestHandoffVersion(
      row({
        status: "return_received",
        versions: [
          { versionNumber: 1, storagePath: "ws/h/v1/o", fileSize: 1, blake3: "aa" },
          { versionNumber: 2, storagePath: "ws/h/v2/o", fileSize: 2, blake3: "bb" },
        ],
      }),
    );
    expect(latest?.versionNumber).toBe(2);
    expect(latestHandoffVersion(row({ versions: [] }))?.versionNumber).toBe(2);
  });
});
