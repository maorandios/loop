import { readFileSync } from "node:fs";
import path from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { he } from "../../copy/he";
import { WorkspaceReadyScreen } from "../workspace/WorkspaceReadyScreen";

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

const baseProps = {
  workspace,
  displayName: "מאור",
  currentUserId: "user-1",
  currentMemberId: "member-1",
  members,
  onSubmitSend: vi.fn(),
  onSubmitFileRequest: vi.fn(),
  onPickFile: vi.fn(),
};

function openLinkForm(props: Partial<typeof baseProps> & {
  externalLinkPolicy?: "anyone" | "identified";
  externalLinkStage?: "form" | "uploading" | "success";
} = {}) {
  render(<WorkspaceReadyScreen {...baseProps} {...props} />);
  fireEvent.click(screen.getByRole("button", { name: he.newRequest }));
  fireEvent.click(screen.getByRole("button", { name: he.createExternalLink }));
}

function pickComputerFile(name = "דוח.pdf") {
  const input = document.querySelector(".fr-file-input") as HTMLInputElement;
  const file = new File(["abc"], name, { type: "application/pdf" });
  fireEvent.change(input, { target: { files: [file] } });
}

describe("external link compose UI", () => {
  it("reuses the same compose shell as send and request", () => {
    openLinkForm();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("fr-compose-send");
    expect(dialog.querySelector(".fr-compose-form-nav")).toBeTruthy();
    expect(screen.getByRole("button", { name: he.back })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: he.createExternalLink })).toBeInTheDocument();
    expect(screen.getByText(he.externalLinkHint)).toBeInTheDocument();
    expect(dialog.querySelector(".fr-compose-form-actions")).toBeTruthy();
    expect(screen.getByRole("button", { name: he.linkCreate })).toHaveClass("fr-btn-primary");
    expect(screen.getByRole("button", { name: he.cancel })).toHaveClass("fr-btn-secondary");
    expect(document.documentElement.dir).toBe("rtl");
    expect(screen.getByLabelText(he.chooseFile)).toHaveClass("fr-dropzone");
  });

  it("picks a computer file and a cloud fixture without calling send pick", () => {
    const onPickFile = vi.fn();
    openLinkForm({ onPickFile });
    pickComputerFile("חוזה.pdf");
    expect(screen.getByText("חוזה.pdf")).toBeInTheDocument();
    expect(screen.getByText(he.linkFileSavedInOrg.replace("{provider}", he.providerSharePoint))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.removeFile }));
    expect(screen.queryByText("חוזה.pdf")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.chooseFromCloud }));
    expect(screen.getByText("תקציב 2026.xlsx")).toBeInTheDocument();
    expect(screen.getByText(he.linkFileSavedInOrg.replace("{provider}", he.providerGoogleWorkspace))).toBeInTheDocument();
    expect(onPickFile).not.toHaveBeenCalled();
  });

  it("toggles access cards and keeps emails while the people field slides closed", () => {
    openLinkForm();
    const peopleFold = document.querySelectorAll(".fr-compose-link .fr-history-fold")[0];
    expect(peopleFold).not.toHaveClass("fr-open");
    fireEvent.click(screen.getByText(he.linkAccessPeople));
    const people = screen.getByLabelText(he.linkPeopleLabel);
    expect(peopleFold).toHaveClass("fr-open");
    fireEvent.change(people, { target: { value: "dana@drops.app" } });
    fireEvent.keyDown(people, { key: "Enter" });
    fireEvent.change(people, { target: { value: "lee@company.com," } });
    fireEvent.keyDown(people, { key: "," });
    expect(screen.getByText("dana@drops.app")).toBeInTheDocument();
    expect(screen.getByText("lee@company.com")).toBeInTheDocument();
    fireEvent.click(screen.getByText(he.linkAccessAnyone));
    expect(peopleFold).not.toHaveClass("fr-open");
    fireEvent.click(screen.getByText(he.linkAccessPeople));
    expect(peopleFold).toHaveClass("fr-open");
    expect(screen.getByText("dana@drops.app")).toBeInTheDocument();
  });

  it("shows a local error for an invalid email", () => {
    openLinkForm();
    fireEvent.click(screen.getByText(he.linkAccessPeople));
    const people = screen.getByLabelText(he.linkPeopleLabel);
    fireEvent.change(people, { target: { value: "not-an-email" } });
    fireEvent.keyDown(people, { key: "Enter" });
    expect(screen.getByText(he.linkEmailInvalid)).toBeInTheDocument();
  });

  it("keeps public sharing visible but locked under org policy", () => {
    openLinkForm({ externalLinkPolicy: "identified" });
    const publicRadio = screen.getByRole("radio", { name: new RegExp(he.linkAccessAnyone) });
    const peopleRadio = screen.getByRole("radio", { name: new RegExp(he.linkAccessPeople) });
    expect(publicRadio).toBeDisabled();
    expect(peopleRadio).toBeChecked();
    expect(screen.getByText(he.linkOrgPolicyIdentified)).toBeInTheDocument();
    expect(publicRadio.closest("label")).toHaveClass("fr-choice-locked");
    expect(screen.getByText(he.linkAccessAnyone)).toBeVisible();
  });

  it("selects expiry presets and opens a custom date", () => {
    openLinkForm();
    expect(screen.getByRole("radio", { name: he.linkExpirySevenDays })).toBeChecked();
    expect(screen.getByText(/הקישור יפוג ב־/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: he.linkExpiryOneDay }));
    expect(screen.getByRole("radio", { name: he.linkExpiryOneDay })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: he.linkExpiryCustom }));
    const customFold = document.querySelectorAll(".fr-compose-link .fr-history-fold")[1];
    expect(customFold).toHaveClass("fr-open");
    const custom = screen.getByLabelText(he.linkExpiryCustomLabel);
    fireEvent.change(custom, { target: { value: "2020-01-01T10:00" } });
    expect((custom as HTMLInputElement).value.startsWith("2020-01-01")).toBe(false);
  });

  it("disables create until the form is complete", () => {
    openLinkForm();
    const create = screen.getByRole("button", { name: he.linkCreate });
    expect(create).toBeDisabled();
    pickComputerFile();
    expect(create).toBeEnabled();
    fireEvent.click(screen.getByText(he.linkAccessPeople));
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText(he.linkPeopleLabel), {
      target: { value: "name@company.com" },
    });
    fireEvent.keyDown(screen.getByLabelText(he.linkPeopleLabel), { key: "Enter" });
    expect(create).toBeEnabled();
  });

  it("shows the upload fixture after create, without send progress wiring", () => {
    const onSubmitSend = vi.fn();
    openLinkForm({ onSubmitSend });
    pickComputerFile("מצגת.pptx");
    fireEvent.click(screen.getByRole("button", { name: he.linkCreate }));
    expect(screen.getByText(he.linkPreparing)).toBeInTheDocument();
    expect(screen.getByText("מצגת.pptx")).toBeInTheDocument();
    expect(document.querySelector(".fr-progress-bar")).toBeTruthy();
    expect(onSubmitSend).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: he.cancel }));
    expect(screen.getByRole("button", { name: he.linkCreate })).toBeInTheDocument();
  });

  it("renders the success fixture and revoke confirm", () => {
    openLinkForm({ externalLinkStage: "success" });
    expect(screen.getByRole("heading", { name: he.linkReadyTitle })).toBeInTheDocument();
    expect(screen.getByDisplayValue("https://drops.app/l/q3-report")).toHaveAttribute("readonly");
    expect(screen.getByRole("button", { name: he.linkCopy })).toBeInTheDocument();
    expect(screen.getByText(he.linkNotDownloaded)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.linkRevoke }));
    expect(screen.getByRole("heading", { name: he.linkRevokeConfirm })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.linkConfirmRevoke }));
    expect(screen.getByRole("button", { name: he.linkCreate })).toBeInTheDocument();
  });

  it("supports keyboard focus on the dropzone and radios", () => {
    openLinkForm();
    const dropzone = screen.getByLabelText(he.chooseFile);
    dropzone.focus();
    expect(dropzone).toHaveFocus();
    fireEvent.keyDown(dropzone, { key: "Enter" });
    screen.getByRole("radio", { name: he.linkExpiryThreeDays }).focus();
    expect(screen.getByRole("radio", { name: he.linkExpiryThreeDays })).toHaveFocus();
  });

  it("keeps reduced-motion hooks on the existing motion system", () => {
    const css = readFileSync(path.join(process.cwd(), "src/styles.css"), "utf8");
    expect(css).toContain("prefers-reduced-motion");
    expect(css).toContain(".fr-history-fold");
    expect(css).toContain(".fr-link-stage");
    expect(css).not.toContain("framer-motion");
    expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
  });

  it("does not add RPC, Storage, or Tauri calls", () => {
    const files = [
      "src/features/link/ExternalLinkScreen.tsx",
      "src/features/link/externalLinkForm.ts",
      "src/features/link/designLink.ts",
    ];
    for (const file of files) {
      const source = readFileSync(path.join(process.cwd(), file), "utf8");
      expect(source).not.toMatch(/invoke\(|supabase|\.rpc\(|tus_|pick_send_file|storage\.from/i);
    }
  });

  it("leaves send and request compose behavior unchanged", () => {
    const onSubmitSend = vi.fn();
    const onSubmitFileRequest = vi.fn();
    const onPickFile = vi.fn();
    render(
      <WorkspaceReadyScreen
        {...baseProps}
        onSubmitSend={onSubmitSend}
        onSubmitFileRequest={onSubmitFileRequest}
        onPickFile={onPickFile}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: he.newRequest }));
    fireEvent.click(screen.getByRole("button", { name: he.sendNewFile }));
    expect(screen.getByRole("heading", { name: he.sendNewFile })).toBeInTheDocument();
    expect(screen.getByLabelText(he.chooseFile)).toHaveClass("fr-dropzone");
    fireEvent.click(screen.getByRole("button", { name: he.send }));
    expect(onSubmitSend).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(he.fileRequired);
    fireEvent.click(screen.getByRole("button", { name: he.back }));

    fireEvent.click(screen.getByRole("button", { name: he.requestFile }));
    expect(screen.getByRole("heading", { name: he.requestFile })).toBeInTheDocument();
    expect(screen.queryByLabelText(he.chooseFile)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.sendRequest }));
    expect(onSubmitFileRequest).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(he.recipientRequired);
    expect(onPickFile).not.toHaveBeenCalled();
    expect(within(screen.getByRole("dialog")).queryByRole("button", { name: he.linkCreate })).not.toBeInTheDocument();
  });
});
