import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canReturnFile, createReconciliationRegistry } from "../../features/handoff/reconciliation";
import { he, returnFileToLabel } from "../../copy/he";

function read(relativePath: string): string {
  return readFileSync(path.join(process.cwd(), relativePath), "utf8").replace(/\r\n/g, "\n");
}

describe("Milestone 7 SQL", () => {
  it("keeps an idempotent patch and the same RPCs in the full setup", () => {
    const sql = read("supabase/manual-setup.sql");
    const patch = read("supabase/manual-patch-m7.sql");
    expect(patch).toContain("BEGIN;");
    expect(patch).toContain("COMMIT;");
    expect(patch).not.toContain("service_role");
    expect(patch).not.toContain("DROP FUNCTION");
    expect(patch).not.toContain("DROP POLICY");
    for (const name of [
      "mark_handoff_opened",
      "mark_handoff_modified",
      "mark_handoff_unmodified",
      "begin_handoff_return",
      "finalize_handoff_return_v2",
      "fail_handoff_return",
      "mark_return_received",
    ]) {
      expect(patch).toContain(`CREATE OR REPLACE FUNCTION public.${name}`);
      expect(sql).toContain(`CREATE OR REPLACE FUNCTION public.${name}`);
    }
    expect(patch).toContain("'restored'");
    expect(patch).toContain("fail_handoff_return");
    expect(patch).toContain("AND h.status IN ('returned', 'return_received')");
    expect(sql).toContain("m.id = h.recipient_member_id");
    expect(sql).toContain("h.status = 'returning'");
  });

  it("does not regress mark_opened from later statuses and rejects unmodified from returning", () => {
    const opened =
      read("supabase/manual-setup.sql").match(
        /CREATE OR REPLACE FUNCTION public\.mark_handoff_opened[\s\S]*?\$\$;/,
      )?.[0] ?? "";
    expect(opened).toContain("'modified', 'returning', 'returned', 'return_received'");
    expect(opened).toContain("event_type");
    const unmodified =
      read("supabase/manual-setup.sql").match(
        /CREATE OR REPLACE FUNCTION public\.mark_handoff_unmodified[\s\S]*?\$\$;/,
      )?.[0] ?? "";
    expect(unmodified).toContain("IS DISTINCT FROM 'modified'");
    const failReturn =
      read("supabase/manual-setup.sql").match(
        /CREATE OR REPLACE FUNCTION public\.fail_handoff_return[\s\S]*?\$\$;/,
      )?.[0] ?? "";
    expect(failReturn).toContain("status = 'modified'");
    expect(failReturn).not.toContain("status = 'failed'");
  });
});

describe("reconciliation worker", () => {
  it("finishes at opened when undo happens while markModified is in flight", async () => {
    let cloud: "opened" | "modified" = "opened";
    let releaseModified!: () => void;
    const markModified = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseModified = resolve;
        }),
    );
    const markUnmodified = vi.fn(async () => {
      cloud = "opened";
    });
    const acknowledge = vi.fn(async () => true);
    const markOpened = vi.fn(async () => undefined);
    const registry = createReconciliationRegistry({
      async getCloudStatus() {
        return cloud;
      },
      async markModified() {
        await markModified();
        cloud = "modified";
      },
      markUnmodified,
      markOpened,
      acknowledge,
    });

    registry.notify({
      handoffId: "h1",
      generation: 1,
      contentDiffersFromV1: true,
      desiredStatus: "modified",
      pendingRecheck: false,
    });
    await Promise.resolve();
    expect(registry.isBusy("h1")).toBe(true);
    expect(markModified).toHaveBeenCalledTimes(1);

    registry.notify({
      handoffId: "h1",
      generation: 2,
      contentDiffersFromV1: false,
      desiredStatus: "opened",
      pendingRecheck: false,
    });
    expect(markUnmodified).not.toHaveBeenCalled();

    releaseModified();
    await vi.waitFor(() => {
      expect(markUnmodified).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(acknowledge).toHaveBeenCalledWith("h1", "opened", 2);
    });
    expect(cloud).toBe("opened");
  });

  it("finishes at modified when a save happens while markUnmodified is in flight", async () => {
    let cloud: "opened" | "modified" = "modified";
    let releaseUnmodified!: () => void;
    const markUnmodified = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseUnmodified = resolve;
        }),
    );
    const markModified = vi.fn(async () => {
      cloud = "modified";
    });
    const acknowledge = vi.fn(async () => true);
    const markOpened = vi.fn(async () => undefined);
    const registry = createReconciliationRegistry({
      async getCloudStatus() {
        return cloud;
      },
      markModified,
      async markUnmodified() {
        await markUnmodified();
        cloud = "opened";
      },
      markOpened,
      acknowledge,
    });

    registry.notify({
      handoffId: "h1",
      generation: 4,
      contentDiffersFromV1: false,
      desiredStatus: "opened",
      pendingRecheck: false,
    });
    await Promise.resolve();
    registry.notify({
      handoffId: "h1",
      generation: 5,
      contentDiffersFromV1: true,
      desiredStatus: "modified",
      pendingRecheck: false,
    });
    releaseUnmodified();
    await vi.waitFor(() => {
      expect(markModified).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(acknowledge).toHaveBeenCalledWith("h1", "modified", 5);
    });
    expect(cloud).toBe("modified");
  });

  it("stops when the cloud status is returning or later", async () => {
    const markModified = vi.fn();
    const registry = createReconciliationRegistry({
      async getCloudStatus() {
        return "returning";
      },
      markModified: async () => {
        markModified();
      },
      markUnmodified: async () => undefined,
      markOpened: async () => undefined,
      acknowledge: async () => true,
    });
    registry.notify({
      handoffId: "h1",
      generation: 1,
      contentDiffersFromV1: true,
      desiredStatus: "modified",
      pendingRecheck: false,
    });
    await vi.waitFor(() => {
      expect(markModified).not.toHaveBeenCalled();
    });
  });
});

describe("return button gating", () => {
  it("enables return only when local, cloud, and sync are stable", () => {
    expect(
      canReturnFile({
        contentDiffersFromV1: true,
        cloudStatus: "modified",
        pendingStatusSync: false,
        reconciling: false,
      }),
    ).toBe(true);
    expect(
      canReturnFile({
        contentDiffersFromV1: true,
        cloudStatus: "opened",
        pendingStatusSync: false,
        reconciling: false,
      }),
    ).toBe(false);
    expect(
      canReturnFile({
        contentDiffersFromV1: true,
        cloudStatus: "modified",
        pendingStatusSync: true,
        reconciling: false,
      }),
    ).toBe(false);
    expect(
      canReturnFile({
        contentDiffersFromV1: true,
        cloudStatus: "modified",
        pendingStatusSync: false,
        reconciling: true,
      }),
    ).toBe(false);
  });
});

describe("Milestone 7 client and native source", () => {
  it("keeps snapshot paths and tokens out of the webview contract", () => {
    const app = read("src/App.tsx");
    const watch = read("src-tauri/src/watch.rs").split("#[cfg(test)]")[0] ?? "";
    const transfer = read("src-tauri/src/transfer.rs").split("#[cfg(test)]")[0] ?? "";
    expect(app).toContain("prepare_return_snapshot");
    expect(app).toContain("returnSnapshotId");
    expect(app).toContain("tus_upload_v2");
    expect(app).toContain("confirm_return_snapshot");
    expect(app).not.toContain("files/tmp");
    expect(app).not.toContain("access_token");
    expect(watch).toContain("pub async fn tus_upload_v2");
    expect(transfer).toContain("async fn tus_upload_v1");
    expect(transfer).toContain("Bearer {access_token}");
    expect(he.watchFailed).toBe("לא ניתן לעקוב אחר שינויים בקובץ הזה");
    expect(he.fileChangedDuringReturn).toBe("הקובץ השתנה בזמן ההחזרה. נסה שוב.");
    expect(returnFileToLabel("מאור")).toBe("החזר למאור");
    expect(he.handoffStatus.modified).toBe("הקובץ נערך");
  });

  it("covers stale ack, TUS change, and tmp cleanup in native tests", () => {
    const inbox = read("src-tauri/src/inbox.rs");
    const watch = read("src-tauri/src/watch.rs");
    const paths = read("src-tauri/src/paths.rs");
    expect(inbox).toContain("stale_ack_does_not_clear_newer_pending");
    expect(inbox).toContain("event_payload_omits_path_hash_and_token");
    expect(watch).toContain("orphan_cleanup_deletes_only_tmp_pattern_and_never_inbox");
    expect(watch).toContain("prepared_snapshot_json_has_no_path");
    expect(watch).toContain("FILE_CHANGED_DURING_RETURN");
    expect(paths).toContain("is_return_snapshot_filename");
  });
});
