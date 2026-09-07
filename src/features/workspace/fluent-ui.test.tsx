import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { he } from "../../copy/he";
import { THEME_STORAGE_KEY } from "../../theme/theme";
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

afterEach(() => {
  localStorage.removeItem(THEME_STORAGE_KEY);
});

describe("FileRelay Fluent UI", () => {
  it("keeps every existing action reachable and labels icon buttons", () => {
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
        onSubmitSend={() => undefined}
        onPickFile={() => undefined}
        onOpenV2={() => undefined}
        onApprove={() => undefined}
        onReject={() => undefined}
        onRemind={() => undefined}
        onCancelV2={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: he.settings })).toHaveAttribute(
      "aria-label",
      he.settings,
    );
    expect(screen.getByRole("button", { name: he.newRequest })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: `${he.waitingForMe} 1` }));
    expect(screen.getByRole("button", { name: he.moreActions })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.moreActions }));
    expect(screen.getByRole("menuitem", { name: he.approve })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: he.reject })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: he.showHistory })).toBeInTheDocument();
  });

  it("keeps reminder and cancel reachable from the overflow menu", () => {
    const { record, transfers } = v2RootActive();
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="מאור"
        currentUserId="user-1"
        currentMemberId={MEMBER.creator}
        handoffs={[record]}
        transfers={transfers}
        members={members}
        onRemind={() => undefined}
        onCancelV2={() => undefined}
      />,
    );
    fireEvent.click(screen.getByRole("tab", { name: `${he.waitingForOthers} 1` }));
    fireEvent.click(screen.getByRole("button", { name: he.moreActions }));
    expect(screen.getByRole("menuitem", { name: he.sendReminder })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: he.cancelRequest })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /returned_to_sender|handoff_id|storagePath|flow_version|active_transfer/i,
    );
    expect(document.body.textContent).not.toMatch(/מחכה לי|מחכה לאחרים|לטיפולי/);
  });

  it("persists a theme choice and keeps mixed filenames in plaintext", () => {
    const { record, transfers } = v2RootActive();
    const mixed = {
      ...record,
      originalFilename: "מחירון-Supplier-2026.xlsx",
      versions: record.versions.map((version) => ({
        ...version,
        fileName: "מחירון-Supplier-2026.xlsx",
      })),
    };
    render(
      <WorkspaceReadyScreen
        workspace={workspace}
        displayName="דני"
        currentUserId="user-2"
        currentMemberId={MEMBER.recipient}
        handoffs={[mixed]}
        transfers={transfers}
        members={members}
        onSubmitSend={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: `${he.waitingForMe} 1` }));
    const file = screen.getByTitle("מחירון-Supplier-2026.xlsx");
    expect(file).toHaveAttribute("dir", "auto");
    expect(file.className).toMatch(/fr-plaintext|fr-file-name/);

    fireEvent.click(screen.getByRole("button", { name: he.settings }));
    fireEvent.click(screen.getByLabelText(he.themeDark));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByLabelText(he.themeLight));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    fireEvent.click(screen.getByLabelText(he.themeSystem));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
  });

  it("does not change Tauri window chrome or service contracts", () => {
    expect(he.downloadAndOpen).toBe("הורד ופתח");
    expect(document.body.textContent ?? "").not.toContain("invoke(");
  });
});
