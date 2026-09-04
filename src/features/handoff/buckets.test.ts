import { describe, expect, it } from "vitest";
import type { HandoffStatus } from "../../copy/he";
import {
  classifyHandoffView,
  groupHandoffsByView,
  sortByRecentActivity,
  viewCounts,
} from "./buckets";
import type { HandoffRecord } from "./types";

function row(
  status: HandoffStatus,
  role: "sender" | "recipient",
  extras: Partial<HandoffRecord> = {},
): HandoffRecord {
  return {
    id: extras.id ?? `h-${status}-${role}`,
    workspaceId: "workspace-1",
    senderMemberId: "sender",
    recipientMemberId: "recipient",
    originalFilename: extras.originalFilename ?? "a.txt",
    instruction: extras.instruction ?? "בדוק",
    dueOn: extras.dueOn ?? null,
    status,
    createdAt: extras.createdAt ?? "2026-09-01T00:00:00.000Z",
    updatedAt: extras.updatedAt ?? "2026-09-01T00:00:00.000Z",
    fileSize: 1,
    blake3: "aa",
    storagePath: "p",
    returnFileSize: null,
    returnBlake3: null,
    returnStoragePath: null,
    versions: extras.versions ?? [],
    events: extras.events ?? [],
    ...extras,
  };
}

describe("handoff view classification", () => {
  const cases: Array<[HandoffStatus, "sender" | "recipient", ReturnType<typeof classifyHandoffView>]> = [
    ["uploading", "sender", "waiting_for_me"],
    ["uploading", "recipient", null],
    ["failed", "sender", "waiting_for_me"],
    ["failed", "recipient", null],
    ["sent", "sender", "waiting_for_others"],
    ["sent", "recipient", "waiting_for_me"],
    ["received", "sender", "waiting_for_others"],
    ["received", "recipient", "waiting_for_me"],
    ["opened", "sender", "waiting_for_others"],
    ["opened", "recipient", "waiting_for_me"],
    ["modified", "sender", "waiting_for_others"],
    ["modified", "recipient", "waiting_for_me"],
    ["returning", "sender", "waiting_for_others"],
    ["returning", "recipient", "waiting_for_me"],
    ["returned", "sender", "waiting_for_me"],
    ["returned", "recipient", "waiting_for_others"],
    ["revision_requested", "sender", "waiting_for_others"],
    ["revision_requested", "recipient", "waiting_for_me"],
    ["completed", "sender", "done"],
    ["completed", "recipient", "done"],
    ["return_received", "sender", "done"],
    ["return_received", "recipient", "done"],
  ];

  it("maps every status to the three views by role", () => {
    for (const [status, role, expected] of cases) {
      expect(classifyHandoffView(status, role), `${status} ${role}`).toBe(expected);
    }
  });

  it("never places failed in done", () => {
    expect(classifyHandoffView("failed", "sender")).not.toBe("done");
    expect(classifyHandoffView("failed", "recipient")).not.toBe("done");
    const grouped = groupHandoffsByView(
      [row("failed", "sender"), row("completed", "sender")],
      "sender",
    );
    expect(grouped.done.map((item) => item.status)).toEqual(["completed"]);
    expect(grouped.waiting_for_me.map((item) => item.status)).toEqual(["failed"]);
  });

  it("puts a returned handoff in waiting_for_me for the sender", () => {
    const grouped = groupHandoffsByView([row("returned", "sender")], "sender");
    expect(grouped.waiting_for_me).toHaveLength(1);
    expect(grouped.waiting_for_others).toHaveLength(0);
    expect(grouped.done).toHaveLength(0);
  });

  it("counts and sorts by the newest activity first", () => {
    const rows = [
      row("sent", "recipient", {
        id: "old",
        updatedAt: "2026-09-01T10:00:00.000Z",
      }),
      row("modified", "recipient", {
        id: "new",
        updatedAt: "2026-09-03T10:00:00.000Z",
      }),
      row("completed", "recipient", {
        id: "done",
        updatedAt: "2026-09-02T10:00:00.000Z",
      }),
    ];
    const grouped = groupHandoffsByView(rows, "recipient");
    expect(grouped.waiting_for_me.map((item) => item.id)).toEqual(["new", "old"]);
    expect(viewCounts(rows, "recipient")).toEqual({
      waiting_for_me: 2,
      waiting_for_others: 0,
      done: 1,
    });
    expect(sortByRecentActivity(rows).map((item) => item.id)).toEqual([
      "new",
      "done",
      "old",
    ]);
  });
});
