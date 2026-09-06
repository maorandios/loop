import { describe, expect, it } from "vitest";
import { createCommandIdStore } from "./commandIds";

describe("command request ids", () => {
  it("reuses one id per command and never shares it across commands", () => {
    const store = createCommandIdStore();
    const create = store.id("create_handoff_v2", "h1");
    const retry = store.id("create_handoff_v2", "h1");
    const finalize = store.id("finalize_handoff_v2_initial", "h1");
    const abort = store.id("abort_handoff_v2_initial", "h1");
    const other = store.id("create_handoff_v2", "h2");
    expect(retry).toBe(create);
    expect(finalize).not.toBe(create);
    expect(abort).not.toBe(create);
    expect(abort).not.toBe(finalize);
    expect(other).not.toBe(create);
    expect(new Set([create, finalize, abort, other]).size).toBe(4);
  });
});
