import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { he } from "../../copy/he";
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

function renderSearch() {
  const active = v2RootActive();
  const done = v2Completed();
  return render(
    <WorkspaceReadyScreen
      workspace={workspace}
      displayName="דני"
      currentUserId="user-2"
      currentMemberId={MEMBER.recipient}
      handoffs={[active.record, done.record]}
      transfers={[...active.transfers, ...done.transfers]}
      members={members}
      onOpenV2={() => undefined}
      onApprove={() => undefined}
      onReject={() => undefined}
    />,
  );
}

function searchBox() {
  return screen.getByRole("searchbox", { name: he.searchRequests });
}

function tab(label: string) {
  return screen.getByRole("tab", { name: new RegExp(`^${label}(?:,|$)`) });
}

describe("local request search", () => {
  it("filters the active section by file, person, instruction, and status", () => {
    renderSearch();
    fireEvent.change(searchBox(), { target: { value: "V2-ACTIVE" } });
    expect(screen.getByTitle("v2-active.docx")).toBeInTheDocument();
    expect(screen.queryByTitle("v2-completed.docx")).not.toBeInTheDocument();
    fireEvent.change(searchBox(), { target: { value: "מאור" } });
    expect(screen.getByTitle("v2-active.docx")).toBeInTheDocument();
    fireEvent.change(searchBox(), { target: { value: "לאשר" } });
    expect(screen.getByTitle("v2-active.docx")).toBeInTheDocument();
    fireEvent.change(searchBox(), { target: { value: he.actionApproval } });
    expect(screen.getByTitle("v2-active.docx")).toBeInTheDocument();
  });

  it("applies the same query only to the active section", () => {
    renderSearch();
    fireEvent.change(searchBox(), { target: { value: "v2-completed" } });
    expect(screen.getByText(he.noSearchMatches)).toBeInTheDocument();
    expect(screen.queryByTitle("v2-active.docx")).not.toBeInTheDocument();
    expect(tab(he.primaryAction)).toHaveAttribute("aria-label", he.primaryAction);
    expect(tab(he.primaryCompleted)).toHaveAttribute("aria-label", he.primaryCompleted);
    fireEvent.click(tab(he.primaryCompleted));
    expect(searchBox()).toHaveValue("v2-completed");
    expect(screen.getByTitle("v2-completed.docx")).toBeInTheDocument();
    expect(screen.queryByText(he.noSearchMatches)).not.toBeInTheDocument();
  });

  it("clears search and restores the section cards", () => {
    renderSearch();
    fireEvent.change(searchBox(), { target: { value: "אין-התאמה" } });
    expect(screen.getByText(he.noSearchMatches)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.clearSearch }));
    expect(searchBox()).toHaveValue("");
    expect(screen.getByTitle("v2-active.docx")).toBeInTheDocument();
    expect(screen.queryByText(he.noSearchMatches)).not.toBeInTheDocument();
  });
});
