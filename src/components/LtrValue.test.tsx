import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LtrValue } from "./LtrValue";

describe("LtrValue", () => {
  it("isolates technical values as LTR", () => {
    render(
      <p>
        כתובת: <LtrValue>192.168.1.25:4747</LtrValue>
      </p>,
    );

    const value = screen.getByText("192.168.1.25:4747");
    expect(value).toHaveAttribute("dir", "ltr");
    expect(value).toHaveStyle({ unicodeBidi: "isolate" });
  });
});
