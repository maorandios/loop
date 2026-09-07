import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

function renderNav() {
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

function tab(label: string) {
  return screen.getByRole("tab", { name: new RegExp(`^${label}\\s`) });
}

describe("primary navigation", () => {
  it("defaults to action and exposes only the three status tabs", () => {
    renderNav();
    expect(tab(he.primaryAction)).toHaveAttribute("aria-selected", "true");
    expect(tab(he.primaryInfo)).toHaveAttribute("aria-selected", "false");
    expect(tab(he.primaryCompleted)).toHaveAttribute("aria-selected", "false");
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByRole("tab", { name: new RegExp(`^${he.feed}\\s`) })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: new RegExp(`^${he.waitingForMe}\\s`) }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: new RegExp(`^${he.waitingForOthers}\\s`) }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("group", { name: he.statusFilter })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.filterAction })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.filterInfo })).not.toBeInTheDocument();
  });

  it("switches between action, info, and completed", () => {
    renderNav();
    fireEvent.click(tab(he.primaryCompleted));
    expect(tab(he.primaryCompleted)).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tab(he.primaryInfo));
    expect(tab(he.primaryInfo)).toHaveAttribute("aria-selected", "true");
    expect(tab(he.primaryAction)).toHaveAttribute("aria-selected", "false");
  });

  it("counts one action and one completed for mixed requests", () => {
    renderNav();
    expect(tab(he.primaryAction)).toHaveAttribute("aria-label", `${he.primaryAction} 1`);
    expect(tab(he.primaryInfo)).toHaveAttribute("aria-label", `${he.primaryInfo} 0`);
    expect(tab(he.primaryCompleted)).toHaveAttribute("aria-label", `${he.primaryCompleted} 1`);
  });

  it("shows inbox items once and keeps v2 actions reachable", () => {
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
    expect(screen.getAllByTitle("v2-active.docx")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: he.moreActions })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("נא לאשר"));
    expect(screen.getByRole("button", { name: he.approve })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.reject })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.approve }));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toMatch(
      /mine|watching|flow_version|storagePath|uuid|tus_chunk|retry/i,
    );
  });
});
