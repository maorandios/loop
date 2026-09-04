export const CLOUD_ERROR_CODES = [
  "cloud_not_configured",
  "cloud_unavailable",
  "anonymous_auth_failed",
  "workspace_creation_failed",
  "invalid_join_code",
  "already_in_workspace",
  "workspace_load_failed",
  "members_load_failed",
  "join_code_rotate_failed",
  "auth_store_corrupt",
  "handoff_create_failed",
  "handoff_finalize_failed",
  "handoff_already_finalized",
  "handoff_object_missing",
  "handoff_object_size_mismatch",
  "handoff_fail_failed",
  "handoff_receive_failed",
  "handoff_load_failed",
  "handoff_open_failed",
  "handoff_modify_failed",
  "handoff_unmodify_failed",
  "handoff_return_begin_failed",
  "handoff_return_finalize_failed",
  "handoff_return_fail_failed",
  "handoff_return_receive_failed",
  "instruction_required",
  "revision_note_required",
  "handoff_complete_failed",
  "handoff_revision_failed",
  "handoff_already_completed",
  "file_too_large",
  "send_failed",
  "download_failed",
  "unsupported_inbox_schema",
  "hash_mismatch",
  "selection_unknown",
  "invalid_storage_path",
  "invalid_download_url",
  "file_busy",
  "file_changed_during_return",
  "watch_failed",
  "snapshot_unknown",
  "unknown_cloud_error",
] as const;

export type CloudErrorCode = (typeof CLOUD_ERROR_CODES)[number];

export class CloudError extends Error {
  readonly code: CloudErrorCode;

  constructor(code: CloudErrorCode) {
    super(code);
    this.name = "CloudError";
    this.code = code;
  }
}

function collectText(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (!error || typeof error !== "object") {
    return "";
  }
  const record = error as Record<string, unknown>;
  return [record.message, record.details, record.hint, record.code]
    .filter((value) => typeof value === "string")
    .join(" ");
}

function statusOf(error: unknown): number {
  if (!error || typeof error !== "object" || !("status" in error)) {
    return Number.NaN;
  }
  return Number((error as { status: unknown }).status);
}

export function toCloudError(error: unknown): CloudError {
  if (error instanceof CloudError) {
    return error;
  }
  const message = collectText(error).toLowerCase();
  for (const code of CLOUD_ERROR_CODES) {
    if (message.includes(code)) {
      return new CloudError(code);
    }
  }
  const status = statusOf(error);
  if (
    status >= 500 ||
    status === 0 ||
    message.includes("fetch") ||
    message.includes("network") ||
    message.includes("failed to fetch") ||
    message.includes("err_internet") ||
    message.includes("timeout")
  ) {
    return new CloudError("cloud_unavailable");
  }
  if (
    message.includes("invalid jwt") ||
    message.includes("jwt expired") ||
    message.includes("refresh_token_not_found") ||
    message.includes("session_not_found")
  ) {
    return new CloudError("anonymous_auth_failed");
  }
  return new CloudError("unknown_cloud_error");
}

export function cloudErrorCode(error: unknown): CloudErrorCode {
  return toCloudError(error).code;
}
