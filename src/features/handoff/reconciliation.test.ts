import { describe, expect, it, vi } from "vitest";
import { createReconciliationRegistry, isReturnTerminal } from "./reconciliation";

describe("reconciliation stop statuses", () => {
  it("stops local reconciliation for returned and completed", () => {
    expect(isReturnTerminal("returned")).toBe(true);
    expect(isReturnTerminal("completed")).toBe(true);
    expect(isReturnTerminal("return_received")).toBe(true);
    expect(isReturnTerminal("returning")).toBe(true);
    expect(isReturnTerminal("revision_requested")).toBe(false);
    expect(isReturnTerminal("modified")).toBe(false);
  });

  it("does not start work after a terminal returned or completed notify", async () => {
    const markModified = vi.fn();
    const registry = createReconciliationRegistry({
      getCloudStatus: async () => "returned",
      markModified,
      markUnmodified: async () => undefined,
      markOpened: async () => undefined,
      acknowledge: async () => true,
    });
    registry.stop("handoff-1");
    registry.notify({
      handoffId: "handoff-1",
      generation: 1,
      contentDiffersFromV1: true,
      desiredStatus: "modified",
      pendingRecheck: false,
    });
    await Promise.resolve();
    expect(markModified).not.toHaveBeenCalled();
    expect(isReturnTerminal("completed")).toBe(true);
  });

  it("resumes after a revision cycle so a later notify can mark modified", async () => {
    const markModified = vi.fn(async () => {
      status = "modified";
    });
    let status: "revision_requested" | "modified" = "revision_requested";
    const registry = createReconciliationRegistry({
      getCloudStatus: async () => status,
      markModified,
      markUnmodified: async () => undefined,
      markOpened: async () => undefined,
      acknowledge: async () => true,
    });
    registry.stop("handoff-1");
    registry.resume("handoff-1");
    registry.notify({
      handoffId: "handoff-1",
      generation: 2,
      contentDiffersFromV1: true,
      desiredStatus: "modified",
      pendingRecheck: false,
    });
    await vi.waitFor(() => {
      expect(markModified).toHaveBeenCalledWith("handoff-1");
    });
  });
});
