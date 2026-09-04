import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

document.documentElement.lang = "he";
document.documentElement.dir = "rtl";

afterEach(() => {
  cleanup();
});

