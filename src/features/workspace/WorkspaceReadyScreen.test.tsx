import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { he } from "../../copy/he";
import type { HandoffRecord } from "../handoff/types";
import { MEMBER, v2OpenMissingPointer, v2RootActive } from "../handoff/view.fixtures";
import { WorkspaceReadyScreen } from "./WorkspaceReadyScreen";

function openSettings() {
  fireEvent.click(screen.getByRole("button", { name: he.settings }));
}

function openCompose() {
  fireEvent.click(screen.getByRole("button", { name: he.newRequest }));
}

const workspace = {
  id: "workspace-1",
  name: "הצוות של מאור",
  createdBy: "user-1",
  createdAt: "2026-09-02T00:00:00.000Z",
};

const members = [
  {
    id: "member-1",
    workspaceId: "workspace-1",
    userId: "user-1",
    deviceId: "11111111-1111-4111-8111-111111111111",
    displayName: "מאור",
    joinedAt: "2026-09-02T00:00:00.000Z",
    lastSeenAt: "2026-09-02T00:00:00.000Z",
  },
  {
    id: "member-2",
    workspaceId: "workspace-1",
    userId: "user-2",
    deviceId: "22222222-2222-4222-8222-222222222222",
    displayName: "דני",
    joinedAt: "2026-09-02T00:00:00.000Z",
    lastSeenAt: "2026-09-02T00:00:00.000Z",
  },
];

function handoff(partial: Partial<HandoffRecord>): HandoffRecord {
  return {
    id: "handoff-1",
    workspaceId: "workspace-1",
    senderMemberId: "member-1",
    recipientMemberId: "member-2",
    originalFilename: "דוח.docx",
    instruction: "נא לבדוק",
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

describe("WorkspaceReadyScreen", () => {
  it("shows Hebrew member names and isolates the join code", () => {
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="מאור"
        currentUserId="user-1"
        currentDeviceId="11111111-1111-4111-8111-111111111111"
        joinCode="AB12-CD34"
        members={[members[0]!]}
      />,
    );

    expect(screen.queryByText("הצוות של מאור")).not.toBeInTheDocument();
    expect(screen.getByText(he.waitingForMembers)).toBeInTheDocument();
    openSettings();
    expect(screen.getAllByText("מאור").length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(he.thisComputer))).toBeInTheDocument();
    expect(screen.getByText("AB12-CD34")).toHaveAttribute("dir", "ltr");
    expect(document.body.textContent).not.toContain("invalid_join_code");
    expect(document.body.textContent).not.toContain("JWT");
    expect(screen.getByRole("button", { name: he.copyJoinCode })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: he.createNewJoinCode }),
    ).not.toBeInTheDocument();
  });

  it("lets the creator request a new join code when none is in memory", () => {
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="מאור"
        currentUserId="user-1"
        members={[members[0]!]}
      />,
    );

    openSettings();
    expect(screen.getByRole("button", { name: he.createNewJoinCode })).toBeInTheDocument();
  });

  it("does not offer join-code creation to a regular member", () => {
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId="member-2"
        onSubmitSend={() => undefined}
        onPickFile={() => undefined}
        members={members}
      />,
    );

    openSettings();
    expect(
      screen.queryByRole("button", { name: he.createNewJoinCode }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.copyJoinCode })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.back }));
    openCompose();
    expect(screen.getByRole("button", { name: he.send })).toBeInTheDocument();
    expect(screen.getByText(he.noPrimaryAction)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("C:\\\\");
    expect(document.body.textContent).not.toContain("signedUrl");
  });

  it("shows a received file with download and open actions", () => {
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId="member-2"
        handoffs={[handoff({ status: "sent" })]}
        inbox={[]}
        members={members}
        onDownloadAndOpen={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(screen.getByText("דוח.docx")).toBeInTheDocument();
    expect(screen.getByText("נא לבדוק")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.openAndHandle })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.downloadAndOpen })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.openFolder })).not.toBeInTheDocument();
    expect(screen.queryByText(/גרסה 1/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sent|handoff-1|storagePath/);
  });

  it("puts a returned file in waiting_for_me for the sender", () => {
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="מאור"
        currentUserId="user-1"
        currentMemberId="member-1"
        handoffs={[handoff({ status: "returned", updatedAt: "2026-09-03T00:00:00.000Z" })]}
        members={members}
        onOpenLatest={() => undefined}
        onCompleteHandoff={() => undefined}
        onRequestRevision={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(screen.getByRole("tab", { name: he.primaryAction })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("דוח.docx")).toBeInTheDocument();
    fireEvent.click(screen.getByText("נא לבדוק"));
    fireEvent.click(screen.getByRole("button", { name: he.actions }));
    expect(screen.getByRole("button", { name: he.approve })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.requestRevision })).toBeInTheDocument();
  });

  it("does not show failed handoffs in the done view", () => {
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="מאור"
        currentUserId="user-1"
        currentMemberId="member-1"
        handoffs={[
          handoff({ id: "failed-1", status: "failed", originalFilename: "נכשל.docx" }),
          handoff({ id: "done-1", status: "completed", originalFilename: "גמור.docx" }),
        ]}
        members={members}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: he.primaryCompleted }));
    expect(screen.getByText("גמור.docx")).toBeInTheDocument();
    expect(screen.queryByText("נכשל.docx")).not.toBeInTheDocument();
  });

  it("offers send-for-handling and file-request modes", () => {
    const onSubmitFileRequest = vi.fn();
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="מאור"
        currentUserId="user-1"
        currentMemberId="member-1"
        members={members}
        onSubmitSend={() => undefined}
        onSubmitFileRequest={onSubmitFileRequest}
        onPickFile={() => undefined}
      />,
    );
    openCompose();
    expect(screen.getAllByText(he.sendFile).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByLabelText(he.requestFile));
    expect(screen.queryByRole("button", { name: he.chooseFile })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(he.fileDescriptionLabel), {
      target: { value: "נא לצרף את הדוח החתום" },
    });
    fireEvent.click(screen.getByRole("button", { name: he.sendRequest }));
    expect(onSubmitFileRequest).toHaveBeenCalledWith({
      recipientMemberId: "member-2",
      instruction: "נא לצרף את הדוח החתום",
      dueOn: null,
    });
    expect(document.body.textContent).not.toMatch(/create_file_request|handoff_id|storage_path/);
  });

  it("does not send without a file, recipient, or instruction", () => {
    const onSubmitSend = vi.fn();
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="מאור"
        currentUserId="user-1"
        currentMemberId="member-1"
        members={members}
        onSubmitSend={onSubmitSend}
        onPickFile={() => undefined}
      />,
    );

    openCompose();
    fireEvent.click(screen.getByRole("button", { name: he.send }));
    expect(onSubmitSend).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(he.fileRequired);
  });

  it("blocks an empty revision note", () => {
    const onRequestRevision = vi.fn();
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="מאור"
        currentUserId="user-1"
        currentMemberId="member-1"
        handoffs={[handoff({ status: "returned" })]}
        members={members}
        onRequestRevision={onRequestRevision}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    fireEvent.click(screen.getByText("נא לבדוק"));
    fireEvent.click(screen.getByRole("button", { name: he.actions }));
    fireEvent.click(screen.getByRole("button", { name: he.requestRevision }));
    fireEvent.click(screen.getByRole("button", { name: he.confirmRevision }));
    expect(onRequestRevision).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(he.cloudError.revision_note_required);
  });

  it("shows the return button only when the cloud status is stably modified", () => {
    const incoming = handoff({
      senderMemberId: "member-1",
      recipientMemberId: "member-2",
      status: "opened",
    });
    const inbox = [
      {
        handoffId: "handoff-1",
        filename: "דוח.docx",
        version: "v1",
        contentDiffersFromV1: true,
        desiredStatus: "modified",
        pendingRecheck: false,
        pendingStatusSync: true,
        generation: 2,
      },
    ];

    const { rerender } = render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דנה"
        currentUserId="user-2"
        currentMemberId="member-2"
        handoffs={[incoming]}
        inbox={inbox}
        members={members}
        onReturnFile={() => undefined}
        onDownloadAndOpen={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(screen.getByText(he.syncingChanges)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.attachFile })).not.toBeInTheDocument();

    rerender(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דנה"
        currentUserId="user-2"
        currentMemberId="member-2"
        handoffs={[{ ...incoming, status: "modified" }]}
        inbox={[{ ...inbox[0]!, pendingStatusSync: false }]}
        members={members}
        onReturnFile={() => undefined}
        onDownloadAndOpen={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText("נא לבדוק"));
    fireEvent.click(screen.getByRole("button", { name: he.actions }));
    expect(screen.getByRole("button", { name: he.attachFile })).toBeEnabled();
    expect(screen.queryByText(he.syncingChanges)).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "נא לבדוק" })).toBeInTheDocument();
    expect(screen.queryByText(he.needUpdate)).not.toBeInTheDocument();

    rerender(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דנה"
        currentUserId="user-2"
        currentMemberId="member-2"
        handoffs={[{ ...incoming, status: "modified" }]}
        inbox={[{ ...inbox[0]!, pendingStatusSync: false }]}
        reconcilingIds={["handoff-1"]}
        members={members}
        onReturnFile={() => undefined}
        onDownloadAndOpen={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: he.attachFile })).toBeEnabled();
    expect(screen.queryByText(he.syncingChanges)).not.toBeInTheDocument();
  });

  it("renders Hebrew history with versions and notes", () => {
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="מאור"
        currentUserId="user-1"
        currentMemberId="member-1"
        handoffs={[
          handoff({
            status: "completed",
            events: [
              {
                eventType: "finalized",
                note: null,
                versionNumber: 1,
                actorMemberId: "member-1",
                createdAt: "2026-09-02T08:00:00.000Z",
              },
              {
                eventType: "returned",
                note: null,
                versionNumber: 3,
                actorMemberId: "member-2",
                createdAt: "2026-09-02T09:00:00.000Z",
              },
              {
                eventType: "revision_requested",
                note: "חסר החתימה",
                versionNumber: 3,
                actorMemberId: "member-1",
                createdAt: "2026-09-02T10:00:00.000Z",
              },
              {
                eventType: "completed",
                note: null,
                versionNumber: 3,
                actorMemberId: "member-1",
                createdAt: "2026-09-02T11:00:00.000Z",
              },
            ],
          }),
        ]}
        members={members}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: he.primaryCompleted }));
    fireEvent.click(screen.getByText("נא לבדוק"));
    expect(screen.getByText(he.historySent)).toBeInTheDocument();
    expect(screen.getAllByText("נא לבדוק").length).toBeGreaterThan(0);
    expect(screen.getByText(he.historyReturned)).toBeInTheDocument();
    expect(screen.getByText("חסר החתימה")).toBeInTheDocument();
    expect(screen.getByText(he.historyCompleted)).toBeInTheDocument();
    expect(screen.queryByText(/גרסה \d/)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/finalized|revision_requested|completed/);
  });

  it("shows a v2 card in the Hebrew sections with recipient actions", () => {
    const { record, transfers } = v2RootActive();
    const v2Members = [
      ...members,
      { ...members[0]!, id: MEMBER.creator, displayName: "מאור" },
      { ...members[1]!, id: MEMBER.recipient, displayName: "דני" },
    ];
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        handoffs={[record]}
        transfers={transfers}
        members={v2Members}
        onDownloadAndOpen={() => undefined}
        onOpenV2={() => undefined}
        onApprove={() => undefined}
        onReject={() => undefined}
        onReturnFile={() => undefined}
        onCompleteHandoff={() => undefined}
        onRequestRevision={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(screen.getByRole("tab", { name: he.primaryAction })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("v2-active.docx")).toBeInTheDocument();
    expect(screen.getByText("נא לאשר")).toBeInTheDocument();
    expect(screen.queryByText(he.needApprove)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.openAndHandle })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.moreActions })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("נא לאשר"));
    fireEvent.click(screen.getByRole("button", { name: he.actions }));
    expect(screen.getByRole("button", { name: he.approve })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.reject })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.approveAndComplete })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /mine|watching|flow_version|active_transfer|preparing|hop-active|handoff_view_inconsistent/,
    );
  });

  it("routes workspace notices through the header push instead of the old banner", () => {
    const { rerender } = render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        members={members}
        error={he.cloudError.unknown_cloud_error}
      />,
    );

    expect(screen.getByText(he.cloudError.unknown_cloud_error)).toBeInTheDocument();
    expect(document.querySelector(".fr-push")).toHaveAttribute("data-tone", "danger");
    expect(document.querySelector(".fr-banner")).toBeNull();

    rerender(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        members={members}
        reminderNotice={he.reminderSent}
      />,
    );

    expect(screen.getByText(he.reminderSent)).toBeInTheDocument();
    expect(document.querySelector(".fr-push")).toHaveAttribute("data-tone", "success");
    expect(document.querySelector(".fr-banner")).toBeNull();
  });

  it("keeps a load banner out of the section counts", () => {
    const good = v2RootActive();
    const bad = v2OpenMissingPointer();
    const onRetryLoad = vi.fn();
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        handoffs={[good.record, bad.record]}
        transfers={[...good.transfers, ...bad.transfers]}
        members={[
          ...members,
          { ...members[0]!, id: MEMBER.creator, displayName: "מאור" },
          { ...members[1]!, id: MEMBER.recipient, displayName: "דני" },
        ]}
        onRetryLoad={onRetryLoad}
      />,
    );

    expect(screen.getByRole("tab", { name: he.primaryAction })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: he.primaryInfo })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: he.primaryCompleted })).toBeInTheDocument();
    expect(screen.getByText(he.partialRequestsFailed)).toBeInTheDocument();
    expect(document.querySelector(".fr-push")).toHaveAttribute("data-tone", "danger");
    expect(document.querySelector(".fr-banner")).toBeNull();
    expect(screen.queryByText("v2-missing.docx")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.tryAgain }));
    expect(onRetryLoad).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("handoff_view_inconsistent");
  });

  it("keeps v1 cards when v2 data failed to load", () => {
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId="member-2"
        handoffs={[handoff({ status: "sent" })]}
        transfers={[]}
        v2LoadFailed
        members={members}
        onDownloadAndOpen={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: he.primaryAction }));
    expect(screen.getByText("דוח.docx")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.openAndHandle })).not.toBeInTheDocument();
    expect(screen.getByText(he.partialRequestsFailed)).toBeInTheDocument();
    expect(document.querySelector(".fr-push")).toHaveAttribute("data-tone", "danger");
    expect(document.querySelector(".fr-banner")).toBeNull();
  });
});
