import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { he } from "../../copy/he";
import { WorkspaceSetupScreen } from "./WorkspaceSetupScreen";

describe("WorkspaceSetupScreen", () => {
  it("shows create and join actions without a join field at first", () => {
    render(
      <WorkspaceSetupScreen
        onCreateWorkspace={() => undefined}
        onJoinWorkspace={() => undefined}
      />,
    );

    expect(
      screen.getByRole("heading", { name: he.workspaceHowToStart }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.createWorkspace })).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: he.joinWorkspace }).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText(he.joinCodeLabel)).not.toBeInTheDocument();
  });

  it("shows the join code field in LTR after choosing join", () => {
    render(
      <WorkspaceSetupScreen
        onCreateWorkspace={() => undefined}
        onJoinWorkspace={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: he.joinWorkspace }));
    const input = screen.getByLabelText(he.joinCodeLabel);
    expect(input).toHaveAttribute("dir", "ltr");
  });

  it("blocks an empty join code and normalizes a hyphenless code", () => {
    const onJoinWorkspace = vi.fn();
    render(
      <WorkspaceSetupScreen
        onCreateWorkspace={() => undefined}
        onJoinWorkspace={onJoinWorkspace}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: he.joinWorkspace }));
    fireEvent.click(screen.getAllByRole("button", { name: he.joinWorkspace })[1]!);
    expect(screen.getByText(he.joinCodeRequired)).toBeInTheDocument();
    expect(onJoinWorkspace).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(he.joinCodeLabel), {
      target: { value: "  ab12cd34  " },
    });
    fireEvent.click(screen.getAllByRole("button", { name: he.joinWorkspace })[1]!);
    expect(onJoinWorkspace).toHaveBeenCalledWith("AB12CD34");
  });
});

