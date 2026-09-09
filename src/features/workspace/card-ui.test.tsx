import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { he } from "../../copy/he";
import type { HandoffRecord } from "../handoff/types";
import { MEMBER, v2Completed, v2RootActive } from "../handoff/view.fixtures";
import { DESIGN_ALL_ACTIONS_ID } from "../handoff/designCards";
import { WorkspaceReadyScreen } from "./WorkspaceReadyScreen";

const workspace = {
  id: "workspace-1",
  name: "הצוות של מאור",
  createdBy: "user-1",
  createdAt: "2026-09-02T00:00:00.000Z",
};

const members = [
  {
    id: MEMBER.creator,
    workspaceId: "workspace-1",
    userId: "user-1",
    deviceId: "11111111-1111-4111-8111-111111111111",
    displayName: "מאור",
    email: "maor@drops.app",
    joinedAt: "2026-09-02T00:00:00.000Z",
    lastSeenAt: "2026-09-02T00:00:00.000Z",
  },
  {
    id: MEMBER.recipient,
    workspaceId: "workspace-1",
    userId: "user-2",
    deviceId: "22222222-2222-4222-8222-222222222222",
    displayName: "דני",
    email: "dani@drops.app",
    joinedAt: "2026-09-02T00:00:00.000Z",
    lastSeenAt: "2026-09-02T00:00:00.000Z",
  },
];

function legacy(partial: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    id: "handoff-1",
    workspaceId: "workspace-1",
    senderMemberId: "member-1",
    recipientMemberId: "member-2",
    originalFilename: "דוח.docx",
    instruction: "נא לוודא שהסכומים תואמים לדוח הרבעוני",
    dueOn: "2026-09-10",
    status: "sent",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    fileSize: 2048,
    blake3: "ab".repeat(32),
    storagePath: null,
    returnFileSize: null,
    returnBlake3: null,
    returnStoragePath: null,
    versions: [{ versionNumber: 1, storagePath: "p", fileSize: 2048, blake3: "ab".repeat(32) }],
    events: [],
    ...partial,
  };
}

describe("request card UI", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-02T12:00:00"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows sender, recipient, due only when present, and one primary action", () => {
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId="member-2"
        handoffs={[legacy({ dueOn: "2026-09-10" })]}
        members={[
          { ...members[0]!, id: "member-1" },
          { ...members[1]!, id: "member-2" },
        ]}
        onDownloadAndOpen={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(screen.getByText("נא לוודא שהסכומים תואמים לדוח הרבעוני")).toBeInTheDocument();
    expect(screen.getByText("מאור")).toBeInTheDocument();
    expect(screen.queryByText("maor@drops.app")).not.toBeInTheDocument();
    expect(screen.queryByText(he.toRecipient)).not.toBeInTheDocument();
    expect(screen.queryByText(he.meLabel)).not.toBeInTheDocument();
    expect(screen.queryByText("dani@drops.app")).not.toBeInTheDocument();
    expect(screen.getByText("עד 10 בספטמבר")).toBeInTheDocument();
    expect(document.querySelector(".fr-due-soon, .fr-due-overdue")).toBeFalsy();
    expect(screen.queryByText("גרסה 1")).not.toBeInTheDocument();
    expect(screen.queryByText(he.noDueDate)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.openAndHandle })).not.toBeInTheDocument();
    const file = screen.getByTitle("דוח.docx");
    expect(file).toHaveAttribute("dir", "auto");
    expect(document.querySelector(".fr-note-clamp")).toBeFalsy();
    expect(document.querySelector(".fr-card-actor")).toBeFalsy();
    expect(document.querySelector(".fr-sentence-at")?.textContent).toBe("@");
    expect(document.querySelector(".fr-sentence-user")?.textContent).toBe("מאור");
    expect(document.querySelector(".fr-sentence-text")?.textContent).toBe(
      "נא לוודא שהסכומים תואמים לדוח הרבעוני",
    );
    expect(document.querySelector(".fr-status")?.textContent).not.toContain("מאור");
    expect(document.querySelector(".fr-status .fr-activity-time")).toBeFalsy();
    expect(document.querySelector(".fr-card-status .fr-activity-time")).toBeTruthy();
    expect(screen.queryByRole("button", { name: he.moreActions })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.downloadAndOpen })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/active|returned_to_sender|flow_version|uuid|storagePath/i);
    expect(document.body.textContent ?? "").not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    for (const button of document.querySelectorAll(".fr-icon-btn")) {
      expect(button).toHaveAttribute("aria-label");
    }
  });

  it("keeps overdue due dates muted", () => {
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId="member-2"
        handoffs={[legacy({ dueOn: "2020-01-01" })]}
        members={[
          { ...members[0]!, id: "member-1" },
          { ...members[1]!, id: "member-2" },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(screen.getByText(/באיחור/)).toBeInTheDocument();
    expect(document.querySelector(".fr-due-soon, .fr-due-overdue")).toBeFalsy();
  });

  it("hides due and version 0, and does not invent a file-request name", () => {
    const { record, transfers } = v2RootActive();
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        handoffs={[
          {
            ...record,
            originalFilename: "unknown.txt",
            dueOn: null,
            versions: [],
          },
        ]}
        transfers={transfers.map((hop) => ({
          ...hop,
          requestedAction: "file_request",
          instruction: "דוח הכספים לשנת 2021",
          dueOn: null,
        }))}
        members={members}
        onAttachFileRequest={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(screen.queryByText(he.needAttachFile)).not.toBeInTheDocument();
    expect(screen.getByText("דוח הכספים לשנת 2021")).toBeInTheDocument();
    expect(screen.queryByText("unknown.txt")).not.toBeInTheDocument();
    expect(screen.queryByText(he.noDueDate)).not.toBeInTheDocument();
    expect(screen.queryByText(/גרסה 0/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.attachFile })).not.toBeInTheDocument();
  });

  it("keeps completed cards free of פתח לבדיקה and opens details from the card, not the button", () => {
    const openV2 = vi.fn();
    const { record, transfers } = v2Completed();
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="מאור"
        currentUserId="user-1"
        currentMemberId={MEMBER.creator}
        handoffs={[record]}
        transfers={transfers}
        members={members}
        onOpenV2={openV2}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${he.primaryCompleted}`) }));
    expect(screen.queryByRole("button", { name: he.openToReview })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.openFile })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.downloadAndOpen }));
    expect(openV2).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: "נא לאשר" })).not.toBeInTheDocument();
    fireEvent.click(document.querySelector(".fr-card-compact") as HTMLElement);
    expect(screen.getByRole("heading", { name: "נא לאשר" })).toBeInTheDocument();
  });

  it("keeps v1 and v2 actions on the details screen, not a list menu", () => {
    const approve = vi.fn();
    const { record, transfers } = v2RootActive();
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        handoffs={[record]}
        transfers={transfers}
        members={members}
        onOpenV2={() => undefined}
        onApprove={approve}
        onReject={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(screen.queryByRole("button", { name: he.moreActions })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.approve })).not.toBeInTheDocument();
    expect(document.querySelector(".fr-command-list")).toBeFalsy();
    fireEvent.click(screen.getByText("נא לאשר"));
    expect(screen.getByRole("button", { name: he.actions })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.approve })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.actions }));
    expect(screen.getByRole("button", { name: he.approve })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.reject })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.hideHistory })).toBeInTheDocument();
    expect(document.querySelector(".fr-action-drawer .fr-command-list")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: he.approve }));
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it("keeps the same card hierarchy in light and dark", () => {
    const { record, transfers } = v2RootActive();
    const { rerender } = render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        handoffs={[record]}
        transfers={transfers}
        members={members}
        onOpenV2={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(document.querySelector(".fr-card-status")).toBeTruthy();
    expect(document.querySelector(".fr-card-actor")).toBeFalsy();
    expect(document.querySelector(".fr-sentence-at")?.textContent).toBe("@");
    expect(document.querySelector(".fr-sentence-user")?.textContent).toBe("מאור");
    expect(document.querySelector(".fr-actions .fr-btn-primary")).toBeFalsy();
    document.documentElement.setAttribute("data-theme", "light");
    rerender(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        handoffs={[record]}
        transfers={transfers}
        members={members}
        onOpenV2={() => undefined}
      />,
    );
    expect(document.querySelector(".fr-card-status")).toBeTruthy();
    expect(document.querySelector(".fr-card-actor")).toBeFalsy();
    expect(document.querySelectorAll(".fr-actions .fr-btn-primary")).toHaveLength(0);
    document.documentElement.removeAttribute("data-theme");
  });

  it("keeps the full @handle and a long compact title", () => {
    const { record, transfers } = v2RootActive();
    const longTitle =
      "כרטיס לבחינת כל כפתורי הפעולות והחלונות שלהם במסך הראשי עם כותרת ארוכה במיוחד";
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        handoffs={[{ ...record, instruction: longTitle }]}
        transfers={transfers.map((hop) => ({ ...hop, instruction: longTitle }))}
        members={[
          { ...members[0]!, displayName: "בן דוד הלוי" },
          members[1]!,
        ]}
        onOpenV2={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(document.querySelector(".fr-sentence-at")?.textContent).toBe("@");
    expect(document.querySelector(".fr-sentence-user")?.textContent).toBe(
      "בן דוד הלוי",
    );
    expect(document.querySelector(".fr-sentence-text")?.textContent).toBe(longTitle);
  });

  it("unlocks every action on the design preview card and opens each follow-up", () => {
    const approve = vi.fn();
    const reject = vi.fn();
    const { record, transfers } = v2RootActive();
    const preview = {
      ...record,
      id: DESIGN_ALL_ACTIONS_ID,
      originalFilename: "בדיקת פעולות.docx",
      instruction: "כרטיס לבחינת כל כפתורי הפעולות והחלונות שלהם",
      activeTransferId: "hop-preview",
    };
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        handoffs={[preview]}
        transfers={transfers.map((hop) => ({
          ...hop,
          id: "hop-preview",
          handoffId: DESIGN_ALL_ACTIONS_ID,
          instruction: "כרטיס לבחינת כל כפתורי הפעולות והחלונות שלהם",
        }))}
        members={members}
        onApprove={approve}
        onReject={reject}
        onRemind={() => undefined}
        onCancelV2={() => undefined}
        onAttachFileRequest={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    fireEvent.click(screen.getByText("כרטיס לבחינת כל כפתורי הפעולות והחלונות שלהם"));
    fireEvent.click(screen.getByRole("button", { name: he.actions }));
    expect(screen.getByRole("button", { name: he.approve })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.reject })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.attachFile })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.sendReminder })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.cancelRequest })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.requestRevision })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "מחיקה" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: he.approve }));
    expect(screen.getByRole("dialog", { name: he.approve })).toBeInTheDocument();
    expect(document.querySelector(".fr-overlay .fr-dialog")).toBeFalsy();
    expect(document.querySelector(".fr-detail-dock.fr-dock-open")).toBeTruthy();
    expect(document.querySelector(".fr-detail-dock .fr-form-drawer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: he.backToMenu }));
    expect(approve).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: he.reject })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: he.reject }));
    expect(screen.getByRole("dialog", { name: he.reject })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.backToMenu }));
    expect(reject).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: he.attachFile }));
    expect(screen.getByRole("dialog", { name: he.attachFile })).toBeInTheDocument();
    expect(screen.getByText(he.dropHint)).toBeInTheDocument();
    expect(document.querySelector(".fr-dropzone .fr-icon")).toHaveAttribute(
      "viewBox",
      "0 0 20 20",
    );
    fireEvent.click(screen.getByRole("button", { name: he.browseFromExplorer }));
    fireEvent.change(document.querySelector(".fr-file-input") as HTMLInputElement, {
      target: { files: [new File(["ok"], "דוגמה.docx")] },
    });
    expect(screen.getByText("דוגמה.docx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.backToMenu }));

    fireEvent.click(screen.getByRole("button", { name: he.cancelRequest }));
    expect(screen.getByText(he.cancelRequestConfirm)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.backToMenu }));

    fireEvent.click(screen.getByRole("button", { name: he.requestRevision }));
    expect(screen.getByRole("dialog", { name: he.requestRevision })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.backToMenu }));

    fireEvent.click(screen.getByRole("button", { name: he.sendReminder }));
    expect(screen.getByText(he.sendReminderConfirm)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.backToMenu }));
    expect(document.querySelector(".fr-banner")).toBeNull();
  });
});
