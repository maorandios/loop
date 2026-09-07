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

describe("primary navigation and status filter", () => {
  it("defaults to feed with no status filter", () => {
    renderNav();
    expect(tab(he.feed)).toHaveAttribute("aria-selected", "true");
    expect(tab(he.waitingForMe)).toHaveAttribute("aria-selected", "false");
    expect(tab(he.waitingForOthers)).toHaveAttribute("aria-selected", "false");
    expect(screen.getByRole("button", { name: he.filterAction })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: he.filterInfo })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: he.filterCompleted })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("exposes only feed, inbox, and outbox as primary tabs", () => {
    renderNav();
    expect(screen.getAllByRole("tab")).toHaveLength(3);
    expect(screen.queryByRole("tab", { name: new RegExp(`^${he.done}\\s`) })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("tab", { name: new RegExp(`^${he.allRequests}\\s`) }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.filterAction })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.filterInfo })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.filterCompleted })).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: he.filterAny }),
    ).not.toBeInTheDocument();
  });

  it("activates one status filter and clears it on a second press", () => {
    renderNav();
    const action = screen.getByRole("button", { name: he.filterAction });
    const info = screen.getByRole("button", { name: he.filterInfo });
    fireEvent.click(action);
    expect(action).toHaveAttribute("aria-pressed", "true");
    expect(info).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(info);
    expect(action).toHaveAttribute("aria-pressed", "false");
    expect(info).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(info);
    expect(info).toHaveAttribute("aria-pressed", "false");
  });

  it("keeps the status filter while switching primary views", () => {
    renderNav();
    fireEvent.click(screen.getByRole("button", { name: he.filterAction }));
    fireEvent.click(tab(he.waitingForMe));
    expect(screen.getByRole("button", { name: he.filterAction })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(tab(he.waitingForOthers));
    expect(screen.getByRole("button", { name: he.filterAction })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("does not change primary counts when a status filter is applied", () => {
    renderNav();
    const feed = tab(he.feed).getAttribute("aria-label");
    const inbox = tab(he.waitingForMe).getAttribute("aria-label");
    const outbox = tab(he.waitingForOthers).getAttribute("aria-label");
    fireEvent.click(screen.getByRole("button", { name: he.filterAction }));
    expect(tab(he.feed)).toHaveAttribute("aria-label", feed);
    expect(tab(he.waitingForMe)).toHaveAttribute("aria-label", inbox);
    expect(tab(he.waitingForOthers)).toHaveAttribute("aria-label", outbox);
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
    fireEvent.click(tab(he.waitingForMe));
    expect(screen.getAllByTitle("v2-active.docx")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: he.moreActions }));
    expect(screen.getByRole("menuitem", { name: he.approve })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: he.reject })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: he.approve }));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toMatch(
      /mine|watching|flow_version|storagePath|uuid|tus_chunk|retry/i,
    );
  });
});
