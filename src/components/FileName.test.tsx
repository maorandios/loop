import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FileName } from "./FileName";

describe("FileName", () => {
  it("renders mixed Hebrew-English names with dir=auto and a tooltip", () => {
    render(<FileName name="מחירון-Supplier-2026.xlsx" />);

    const value = screen.getByText("מחירון-Supplier-2026.xlsx");
    expect(value).toHaveAttribute("dir", "auto");
    expect(value).toHaveAttribute("title", "מחירון-Supplier-2026.xlsx");
    expect(value.className).toMatch(/truncate/);
  });
});
