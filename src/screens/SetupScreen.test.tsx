import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { HANDOFF_STATUSES } from "../copy/he";
import { SetupScreen } from "./SetupScreen";

describe("SetupScreen RTL", () => {
  it("keeps the document in Hebrew RTL and shows the first-run form", () => {
    render(<SetupScreen onSubmitName={() => undefined} />);

    expect(document.documentElement).toHaveAttribute("lang", "he");
    expect(document.documentElement).toHaveAttribute("dir", "rtl");
    expect(
      screen.getByRole("heading", { name: "ברוכים הבאים ל־FileRelay" }),
    ).toBeInTheDocument();
    expect(screen.getByText("איך להציג את המחשב הזה?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "המשך" })).toBeInTheDocument();
  });

  it("requires a computer name before saving", () => {
    const onSubmitName = vi.fn();
    render(<SetupScreen onSubmitName={onSubmitName} />);

    fireEvent.click(screen.getByRole("button", { name: "המשך" }));

    expect(screen.getByRole("alert")).toHaveTextContent("נא להזין שם למחשב");
    expect(onSubmitName).not.toHaveBeenCalled();
  });

  it("submits a trimmed computer name", () => {
    const onSubmitName = vi.fn();
    render(<SetupScreen onSubmitName={onSubmitName} />);

    fireEvent.change(screen.getByLabelText("שם המחשב"), {
      target: { value: "  המחשב של מאור  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "המשך" }));

    expect(onSubmitName).toHaveBeenCalledWith("המחשב של מאור");
  });

  it("does not show internal English handoff statuses", () => {
    const { container } = render(<SetupScreen onSubmitName={() => undefined} />);
    const text = container.textContent ?? "";
    for (const status of HANDOFF_STATUSES) {
      expect(text).not.toContain(status);
    }
  });
});
