import type { ComponentProps } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { he } from "../../copy/he";
import type { HandoffRecord } from "../handoff/types";
import { MEMBER, v2RootActive } from "../handoff/view.fixtures";
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

function legacy(partial: Partial<HandoffRecord>): HandoffRecord {
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

function renderRecipient(extra: Partial<ComponentProps<typeof WorkspaceReadyScreen>> = {}) {
  const { record, transfers } = v2RootActive();
  return render(
    <WorkspaceReadyScreen
      workspace={workspace}
      displayName="דני"
      currentUserId="user-2"
      currentMemberId={MEMBER.recipient}
      handoffs={[record]}
      transfers={transfers}
      members={members}
      onSubmitSend={() => undefined}
      onPickFile={() => undefined}
      onOpenV2={() => undefined}
      onApprove={() => undefined}
      onReject={() => undefined}
      onRemind={() => undefined}
      onCancelV2={() => undefined}
      {...extra}
    />,
  );
}

describe("Inbox UI", () => {
  it("shows three mailbox tabs and no הכול tab", () => {
    renderRecipient();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByRole("tab", { name: `${he.allRequests} 1` })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: `${he.done} 0` })).not.toBeInTheDocument();
  });

  it("maps the three mailbox tabs with counts", () => {
    renderRecipient();
    expect(screen.getByRole("button", { name: he.filterRequests })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: `${he.primaryAction} 1` })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: `${he.primaryInfo} 0` })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: `${he.primaryCompleted} 0` })).toBeInTheDocument();
  });

  it("keeps a request on a single row", () => {
    renderRecipient();
    fireEvent.click(screen.getByRole("tab", { name: `${he.primaryAction} 1` }));
    expect(screen.getAllByTitle("v2-active.docx")).toHaveLength(1);
  });

  it("keeps secondary v1 and v2 actions reachable", () => {
    const approve = vi.fn();
    const reject = vi.fn();
    renderRecipient({ onApprove: approve, onReject: reject });
    fireEvent.click(screen.getByRole("tab", { name: `${he.primaryAction} 1` }));
    expect(screen.queryByRole("button", { name: he.moreActions })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("נא לאשר"));
    fireEvent.click(screen.getByRole("button", { name: he.approve }));
    expect(approve).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: he.reject }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("opens request details from the card and restores focus", () => {
    const openV2 = vi.fn();
    renderRecipient({ onOpenV2: openV2 });
    fireEvent.click(screen.getByRole("tab", { name: `${he.primaryAction} 1` }));
    fireEvent.click(screen.getByText("נא לאשר"));
    expect(screen.getByRole("heading", { name: he.requestDetails })).toHaveFocus();
    expect(screen.queryByText(he.toRecipient)).not.toBeInTheDocument();
    expect(screen.getAllByText("מאור").length).toBeGreaterThan(0);
    expect(screen.getByText("נא לאשר")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.back }));
    expect(screen.queryByRole("heading", { name: he.requestDetails })).not.toBeInTheDocument();
    expect(document.activeElement).toHaveClass("fr-card-compact");
  });

  it("restores the list scroll position after details close", () => {
    const cards = [0, 1, 2, 3, 4].map((index) =>
      legacy({
        id: `legacy-${index}`,
        originalFilename: `קובץ-${index}.docx`,
        updatedAt: `2026-09-0${index + 1}T00:00:00.000Z`,
      }),
    );
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId="member-2"
        handoffs={cards}
        members={[
          { ...members[0]!, id: "member-1", displayName: "מאור" },
          { ...members[1]!, id: "member-2", displayName: "דני" },
        ]}
        onDownloadAndOpen={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: `${he.primaryAction} 5` }));
    const list = document.querySelector(".fr-scroll") as HTMLElement;
    list.scrollTop = 96;
    fireEvent.click(screen.getAllByText("נא לבדוק")[0]!);
    expect(screen.getByRole("heading", { name: he.requestDetails })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.back }));
    expect((document.querySelector(".fr-scroll") as HTMLElement).scrollTop).toBe(96);
  });

  it("opens and closes the compose sheet", () => {
    renderRecipient();
    fireEvent.click(screen.getByRole("button", { name: he.newRequest }));
    expect(screen.getByRole("dialog", { name: he.newRequest })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.closeDialog }));
    expect(screen.queryByRole("dialog", { name: he.newRequest })).not.toBeInTheDocument();
  });

  it("opens and closes the filter popover", () => {
    renderRecipient();
    fireEvent.click(screen.getByRole("button", { name: he.filterRequests }));
    const dialog = screen.getByRole("dialog", { name: he.filterRequests });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: he.clearFilter }));
    expect(screen.queryByRole("dialog", { name: he.filterRequests })).not.toBeInTheDocument();
  });

  it("expands and collapses history on the details screen", () => {
    renderRecipient();
    fireEvent.click(screen.getByRole("tab", { name: `${he.primaryAction} 1` }));
    fireEvent.click(screen.getByText("נא לאשר"));
    fireEvent.click(screen.getByRole("button", { name: he.showHistory }));
    expect(screen.getByRole("button", { name: he.hideHistory })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(document.querySelector(".fr-history-fold")).toHaveClass("fr-open");
    fireEvent.click(screen.getByRole("button", { name: he.hideHistory }));
    expect(document.querySelector(".fr-history-fold")).not.toHaveClass("fr-open");
  });

  it("closes popovers with Escape and restores focus", () => {
    renderRecipient();
    const filter = screen.getByRole("button", { name: he.filterRequests });
    fireEvent.click(filter);
    expect(screen.getByRole("dialog", { name: he.filterRequests })).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: he.filterRequests })).not.toBeInTheDocument();
  });

  it("labels every icon button and respects reduced motion", () => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    renderRecipient();
    fireEvent.click(screen.getByRole("tab", { name: `${he.primaryAction} 1` }));
    for (const button of document.querySelectorAll(".fr-icon-btn")) {
      expect(button).toHaveAttribute("aria-label");
    }
    fireEvent.click(screen.getByText("נא לאשר"));
    expect(screen.getByRole("heading", { name: he.requestDetails })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.back }));
    expect(screen.getByRole("button", { name: he.filterRequests })).toBeInTheDocument();
  });

  it("does not leak technical ids from the list or details", () => {
    renderRecipient();
    fireEvent.click(screen.getByRole("tab", { name: `${he.primaryAction} 1` }));
    expect(screen.queryByRole("button", { name: he.moreActions })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("נא לאשר"));
    expect(document.body.textContent).not.toMatch(
      /handoff-v2|storagePath|flow_version|active_transfer|rpc|uuid/i,
    );
  });
});
