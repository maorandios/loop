import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { he } from "../../copy/he";
import type { HandoffRecord } from "../handoff/types";
import { MEMBER, v2Completed, v2RootActive } from "../handoff/view.fixtures";
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
    joinedAt: "2026-09-02T00:00:00.000Z",
    lastSeenAt: "2026-09-02T00:00:00.000Z",
  },
  {
    id: MEMBER.recipient,
    workspaceId: "workspace-1",
    userId: "user-2",
    deviceId: "22222222-2222-4222-8222-222222222222",
    displayName: "דני",
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
    expect(screen.getByText("מאור")).toBeInTheDocument();
    expect(screen.getByText(he.toRecipient)).toBeInTheDocument();
    expect(screen.getByText(he.meLabel)).toBeInTheDocument();
    expect(screen.getAllByTitle("דני").length).toBeGreaterThan(0);
    expect(screen.getByText("עד 10 בספטמבר")).toBeInTheDocument();
    expect(screen.getByText("גרסה 1")).toBeInTheDocument();
    expect(screen.queryByText(he.noDueDate)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: he.openAndHandle })).toHaveLength(1);
    const file = screen.getByTitle("דוח.docx");
    expect(file).toHaveAttribute("dir", "auto");
    expect(document.querySelector(".fr-note-clamp")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/active|returned_to_sender|flow_version|uuid|storagePath/i);
    expect(document.body.textContent ?? "").not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    for (const button of document.querySelectorAll(".fr-icon-btn")) {
      expect(button).toHaveAttribute("aria-label");
    }
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
    expect(screen.getByText(he.needAttachFile)).toBeInTheDocument();
    expect(screen.getByText("דוח הכספים לשנת 2021")).toBeInTheDocument();
    expect(screen.queryByText("unknown.txt")).not.toBeInTheDocument();
    expect(screen.queryByText(he.noDueDate)).not.toBeInTheDocument();
    expect(screen.queryByText(/גרסה 0/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: he.attachFile })).toHaveLength(1);
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
    fireEvent.click(screen.getByRole("tab", { name: `${he.done} 1` }));
    expect(screen.queryByRole("button", { name: he.openToReview })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.openFile })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.openFile }));
    expect(openV2).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("heading", { name: he.requestDetails })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("v2-completed.docx"));
    expect(screen.getByRole("heading", { name: he.requestDetails })).toBeInTheDocument();
  });

  it("keeps all v1 and v2 secondary actions in the overflow menu", () => {
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
    fireEvent.click(screen.getByRole("button", { name: he.moreActions }));
    expect(screen.getByRole("menuitem", { name: he.approve })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: he.reject })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: he.showHistory })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: he.approve }));
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
    expect(document.querySelector(".fr-card-status")).toBeTruthy();
    expect(document.querySelector(".fr-people")).toBeTruthy();
    expect(document.querySelector(".fr-actions .fr-btn-primary")).toBeTruthy();
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
    expect(document.querySelector(".fr-people")).toBeTruthy();
    expect(document.querySelectorAll(".fr-actions .fr-btn-primary")).toHaveLength(1);
    document.documentElement.removeAttribute("data-theme");
  });
});
