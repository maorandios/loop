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
  return screen.getByRole("tab", { name: new RegExp(`^${label}(?:,|$)`) });
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
    expect(document.querySelector(".fr-seg")).toBeFalsy();
    expect(document.querySelector(".fr-workspace [role='tab']")).toBeFalsy();
    expect(screen.getByRole("button", { name: he.settings })).toBeInTheDocument();
    expect(tab(he.primaryAction)).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: he.settings })).not.toHaveAttribute("aria-current");
  });

  it("switches between action, info, and completed", () => {
    renderNav();
    fireEvent.click(tab(he.primaryCompleted));
    expect(tab(he.primaryCompleted)).toHaveAttribute("aria-selected", "true");
    fireEvent.click(tab(he.primaryInfo));
    expect(tab(he.primaryInfo)).toHaveAttribute("aria-selected", "true");
    expect(tab(he.primaryInfo)).toHaveAttribute("aria-current", "page");
    expect(tab(he.primaryAction)).toHaveAttribute("aria-selected", "false");
    expect(tab(he.primaryAction)).not.toHaveAttribute("aria-current");
  });

  it("shows an unread dot until the section is opened", () => {
    const active = v2RootActive();
    const done = v2Completed();
    const screenProps = {
      workspace,
      displayName: "דני",
      currentUserId: "user-2",
      currentMemberId: MEMBER.recipient,
      members,
      onOpenV2: () => undefined,
      onApprove: () => undefined,
      onReject: () => undefined,
    };
    const { rerender } = render(
      <WorkspaceReadyScreen
        {...screenProps}
        handoffs={[active.record, done.record]}
        transfers={[...active.transfers, ...done.transfers]}
      />,
    );
    expect(tab(he.primaryCompleted).querySelector(".fr-rail-dot")).toBeFalsy();
    expect(tab(he.primaryCompleted)).toHaveAttribute("aria-label", he.primaryCompleted);

    const later = "2099-01-01T00:00:00.000Z";
    rerender(
      <WorkspaceReadyScreen
        {...screenProps}
        handoffs={[active.record, { ...done.record, updatedAt: later }]}
        transfers={[...active.transfers, { ...done.transfers[0]!, updatedAt: later }]}
      />,
    );
    expect(tab(he.primaryCompleted)).toHaveAttribute(
      "aria-label",
      `${he.primaryCompleted}, ${he.unreadRequests}`,
    );
    expect(tab(he.primaryCompleted).querySelector(".fr-rail-dot")).toBeTruthy();
    fireEvent.click(tab(he.primaryCompleted));
    expect(tab(he.primaryCompleted)).toHaveAttribute("aria-label", he.primaryCompleted);
    expect(tab(he.primaryCompleted).querySelector(".fr-rail-dot")).toBeFalsy();
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
    expect(screen.getByRole("button", { name: he.actions })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.actions }));
    expect(screen.getByRole("button", { name: he.approve })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.reject })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.approve }));
    expect(approve).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toMatch(
      /mine|watching|flow_version|storagePath|uuid|tus_chunk|retry/i,
    );
  });

  it("keeps the rail on details and opens settings in the content pane", () => {
    renderNav();
    fireEvent.click(screen.getByText("נא לאשר"));
    expect(document.querySelector(".fr-rail")).toBeTruthy();
    expect(screen.getByRole("button", { name: he.settings })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.back })).toBeInTheDocument();
    expect(screen.queryByRole("searchbox", { name: he.searchRequests })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.back }));
    fireEvent.click(screen.getByRole("button", { name: he.settings }));
    expect(screen.getByRole("heading", { name: he.settings })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.settings })).toHaveAttribute("aria-current", "page");
    expect(tab(he.primaryAction)).not.toHaveAttribute("aria-current");
    expect(document.querySelector(".fr-overlay")).toBeFalsy();
    expect(screen.queryByRole("searchbox", { name: he.searchRequests })).not.toBeInTheDocument();
    fireEvent.click(tab(he.primaryCompleted));
    expect(screen.queryByRole("heading", { name: he.settings })).not.toBeInTheDocument();
    expect(tab(he.primaryCompleted)).toHaveAttribute("aria-current", "page");
    expect(screen.getByTitle("v2-completed.docx")).toBeInTheDocument();
  });

  it("respects prefers-reduced-motion", () => {
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
    renderNav();
    expect(document.querySelector(".fr-list-in")).toBeTruthy();
  });
});
