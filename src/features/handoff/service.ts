import { getSupabaseClient } from "../../lib/supabase/client";
import { isSupabaseConfigured } from "../../lib/supabase/config";
import { CloudError, toCloudError } from "../../lib/supabase/errors";
import {
  subscribeHandoffEvents,
  subscribeIncomingHandoffs,
  subscribeOutgoingHandoffs,
} from "../workspace/realtime";
import type { HandoffStatus } from "../../copy/he";
import type {
  CreatedFileRequest,
  CreatedHandoff,
  CreatedHandoffV2,
  HandoffEvent,
  HandoffFlowVersion,
  HandoffRecord,
  HandoffService,
  HandoffSnapshot,
  HandoffVersion,
  ReminderResult,
  RequestStatus,
  StartedResultUpload,
  StartedReturn,
  TransferRecord,
} from "./types";

export const HANDOFF_LIST_SELECT =
  "id, workspace_id, sender_member_id, recipient_member_id, original_filename, instruction, due_on, status, created_at, updated_at, flow_version, request_status, active_transfer_id, closed_at, cancelled_at, handoff_versions(version_number, storage_path, file_size, blake3, file_name), handoff_events(id, event_type, note, version_number, actor_member_id, transfer_id, created_at)";

export const TRANSFER_LIST_SELECT =
  "id, handoff_id, workspace_id, parent_transfer_id, from_member_id, to_member_id, requested_action, instruction, due_on, status, result_action, result_note, result_version_number, handling_round, last_reminder_at, pending_object_id, pending_version_number, pending_storage_path, pending_upload_expires_at, updated_at";

type RpcCreateHandoff = {
  handoff_id: string;
  object_id: string;
  storage_path: string;
  workspace_id: string;
};

type VersionRow = {
  version_number: number;
  storage_path: string;
  file_size: number;
  blake3: string;
  file_name?: string | null;
};

type EventRow = {
  id?: string | null;
  event_type: string;
  note?: string | null;
  version_number?: number | null;
  actor_member_id?: string | null;
  transfer_id?: string | null;
  created_at: string;
};

type TransferRow = {
  id: string;
  handoff_id: string;
  parent_transfer_id?: string | null;
  from_member_id: string;
  to_member_id: string;
  requested_action: TransferRecord["requestedAction"];
  instruction: string;
  due_on?: string | null;
  status: TransferRecord["status"];
  result_action?: TransferRecord["resultAction"];
  result_note?: string | null;
  result_version_number?: number | null;
  handling_round?: number | null;
  last_reminder_at?: string | null;
  pending_object_id?: string | null;
  pending_version_number?: number | null;
  pending_storage_path?: string | null;
  pending_upload_expires_at?: string | null;
  updated_at: string;
};

type HandoffRow = {
  id: string;
  workspace_id: string;
  sender_member_id: string;
  recipient_member_id: string;
  original_filename?: string | null;
  instruction?: string | null;
  due_on?: string | null;
  status: HandoffStatus | null;
  created_at: string;
  updated_at: string;
  flow_version?: number | null;
  request_status?: RequestStatus | null;
  active_transfer_id?: string | null;
  closed_at?: string | null;
  cancelled_at?: string | null;
  handoff_versions?: VersionRow[] | VersionRow | null;
  handoff_events?: EventRow[] | EventRow | null;
};

async function requireClient() {
  if (!isSupabaseConfigured()) {
    throw new CloudError("cloud_not_configured");
  }
  const client = await getSupabaseClient();
  if (!client) {
    throw new CloudError("cloud_not_configured");
  }
  return client;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function mapCreatedHandoffV2(data: unknown): CreatedHandoffV2 {
  const row = data as {
    handoff_id?: string;
    transfer_id?: string;
    object_id?: string;
    storage_path?: string;
    pending_upload_expires_at?: string;
  };
  if (
    !row.handoff_id ||
    !row.transfer_id ||
    !row.object_id ||
    !row.storage_path ||
    !row.pending_upload_expires_at
  ) {
    throw new CloudError("handoff_create_failed");
  }
  return {
    handoffId: row.handoff_id,
    transferId: row.transfer_id,
    objectId: row.object_id,
    storagePath: row.storage_path,
    pendingUploadExpiresAt: row.pending_upload_expires_at,
  };
}

function mapStartedResult(data: unknown): StartedResultUpload {
  const row = data as {
    object_id?: string;
    version_number?: number;
    storage_path?: string;
    pending_upload_expires_at?: string;
  };
  if (!row.object_id || !row.storage_path || !row.pending_upload_expires_at || !row.version_number) {
    throw new CloudError("handoff_return_begin_failed");
  }
  return {
    objectId: row.object_id,
    versionNumber: row.version_number,
    storagePath: row.storage_path,
    pendingUploadExpiresAt: row.pending_upload_expires_at,
  };
}

function versionByNumber(row: HandoffRow, versionNumber: number): VersionRow | null {
  const versions = row.handoff_versions;
  if (!versions) {
    return null;
  }
  const list = Array.isArray(versions) ? versions : [versions];
  return list.find((version) => version.version_number === versionNumber) ?? null;
}

function versionList(row: HandoffRow): HandoffVersion[] {
  const versions = row.handoff_versions;
  if (!versions) {
    return [];
  }
  const list = Array.isArray(versions) ? versions : [versions];
  return list
    .filter((version) => version.version_number >= 1 && version.version_number <= 1000)
    .map((version) => ({
      versionNumber: version.version_number,
      storagePath: version.storage_path,
      fileSize: version.file_size,
      blake3: version.blake3,
      fileName: version.file_name ?? null,
    }))
    .sort((left, right) => left.versionNumber - right.versionNumber);
}

function firstVersion(row: HandoffRow): VersionRow | null {
  return versionByNumber(row, 1);
}

function eventList(row: HandoffRow): HandoffEvent[] {
  const events = row.handoff_events;
  if (!events) {
    return [];
  }
  const list = Array.isArray(events) ? events : [events];
  return list
    .map((event) => ({
      id: event.id ?? null,
      eventType: event.event_type,
      note: event.note ?? null,
      versionNumber: event.version_number ?? null,
      actorMemberId: event.actor_member_id ?? null,
      transferId: event.transfer_id ?? null,
      createdAt: event.created_at,
    }))
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

function latestReturnedVersion(versions: HandoffVersion[]): HandoffVersion | null {
  const returned = versions.filter((version) => version.versionNumber >= 2);
  if (returned.length === 0) {
    return null;
  }
  return returned[returned.length - 1] ?? null;
}

function mapHandoff(row: HandoffRow): HandoffRecord {
  const versions = versionList(row);
  const version = firstVersion(row);
  const returned = latestReturnedVersion(versions);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    senderMemberId: row.sender_member_id,
    recipientMemberId: row.recipient_member_id,
    originalFilename: row.original_filename ?? "",
    instruction: row.instruction ?? null,
    dueOn: row.due_on ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    flowVersion: (row.flow_version === 2 ? 2 : 1) as HandoffFlowVersion,
    requestStatus: row.request_status ?? null,
    activeTransferId: row.active_transfer_id ?? null,
    closedAt: row.closed_at ?? null,
    cancelledAt: row.cancelled_at ?? null,
    fileSize: version?.file_size ?? null,
    blake3: version?.blake3 ?? null,
    storagePath: version?.storage_path ?? null,
    returnFileSize: returned?.fileSize ?? null,
    returnBlake3: returned?.blake3 ?? null,
    returnStoragePath: returned?.storagePath ?? null,
    versions,
    events: eventList(row),
  };
}

function mapTransfer(row: TransferRow): TransferRecord {
  return {
    id: row.id,
    handoffId: row.handoff_id,
    parentTransferId: row.parent_transfer_id ?? null,
    fromMemberId: row.from_member_id,
    toMemberId: row.to_member_id,
    requestedAction: row.requested_action,
    instruction: row.instruction,
    dueOn: row.due_on ?? null,
    status: row.status,
    resultAction: row.result_action ?? null,
    resultNote: row.result_note ?? null,
    resultVersionNumber: row.result_version_number ?? null,
    handlingRound: row.handling_round ?? 1,
    lastReminderAt: row.last_reminder_at ?? null,
    pendingObjectId: row.pending_object_id ?? null,
    pendingVersionNumber: row.pending_version_number ?? null,
    pendingStoragePath: row.pending_storage_path ?? null,
    pendingUploadExpiresAt: row.pending_upload_expires_at ?? null,
    updatedAt: row.updated_at,
  };
}

async function loadHandoffSnapshot(workspaceId: string | null): Promise<HandoffSnapshot> {
  if (!isSupabaseConfigured()) {
    return { handoffs: [], transfers: [], v2LoadFailed: false };
  }
  const client = await getSupabaseClient();
  if (!client) {
    return { handoffs: [], transfers: [], v2LoadFailed: false };
  }

  let handoffQuery = client.from("handoffs").select(HANDOFF_LIST_SELECT);
  if (workspaceId) {
    handoffQuery = handoffQuery.eq("workspace_id", workspaceId);
  }
  const { data, error } = await handoffQuery.order("created_at", { ascending: false });
  if (error) {
    throw toCloudError(error);
  }
  const handoffs = ((data as HandoffRow[] | null) ?? []).map(mapHandoff);

  if (!workspaceId) {
    return { handoffs, transfers: [], v2LoadFailed: false };
  }

  try {
    const transfersResult = await client
      .from("handoff_transfers")
      .select(TRANSFER_LIST_SELECT)
      .eq("workspace_id", workspaceId);
    if (transfersResult.error) {
      return { handoffs, transfers: [], v2LoadFailed: true };
    }
    return {
      handoffs,
      transfers: ((transfersResult.data as TransferRow[] | null) ?? []).map(mapTransfer),
      v2LoadFailed: false,
    };
  } catch {
    return { handoffs, transfers: [], v2LoadFailed: true };
  }
}

export function createSupabaseHandoffService(): HandoffService {
  return {
    async listHandoffs() {
      try {
        const snapshot = await loadHandoffSnapshot(null);
        return snapshot.handoffs;
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async listHandoffSnapshot(workspaceId) {
      try {
        return await loadHandoffSnapshot(workspaceId);
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async createHandoff(recipientMemberId, originalFilename) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("create_handoff", {
          recipient_member_id: recipientMemberId,
          original_filename: originalFilename,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("handoff_create_failed"));
        }
        const result = data as RpcCreateHandoff;
        if (!result.handoff_id || !result.object_id || !result.storage_path) {
          throw new CloudError("handoff_create_failed");
        }
        return {
          handoffId: result.handoff_id,
          objectId: result.object_id,
          storagePath: result.storage_path,
          workspaceId: result.workspace_id,
        } satisfies CreatedHandoff;
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async createHandoffWithContext(recipientMemberId, originalFilename, instruction, dueOn) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("create_handoff_with_context", {
          recipient_member_id: recipientMemberId,
          original_filename: originalFilename,
          instruction,
          due_on: dueOn,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("handoff_create_failed"));
        }
        const result = data as RpcCreateHandoff;
        if (!result.handoff_id || !result.object_id || !result.storage_path) {
          throw new CloudError("handoff_create_failed");
        }
        return {
          handoffId: result.handoff_id,
          objectId: result.object_id,
          storagePath: result.storage_path,
          workspaceId: result.workspace_id,
        } satisfies CreatedHandoff;
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async currentAccessToken() {
      try {
        const client = await requireClient();
        const { data, error } = await client.auth.getSession();
        const token = data.session?.access_token;
        if (error || !token) {
          throw toCloudError(error ?? new CloudError("send_failed"));
        }
        return token;
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async finalizeHandoffV1(handoffId, objectId, fileSize, blake3) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("finalize_handoff_v1", {
          handoff_id: handoffId,
          object_id: objectId,
          file_size: fileSize,
          blake3,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async failHandoff(handoffId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("fail_handoff", {
          handoff_id: handoffId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async markReceived(handoffId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("mark_handoff_received", {
          handoff_id: handoffId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async markOpened(handoffId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("mark_handoff_opened", {
          handoff_id: handoffId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async markModified(handoffId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("mark_handoff_modified", {
          handoff_id: handoffId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async markUnmodified(handoffId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("mark_handoff_unmodified", {
          handoff_id: handoffId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async beginReturn(handoffId) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("begin_handoff_return", {
          handoff_id: handoffId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("handoff_return_begin_failed"));
        }
        const result = data as {
          handoff_id: string;
          object_id: string;
          storage_path: string;
        };
        if (!result.object_id || !result.storage_path) {
          throw new CloudError("handoff_return_begin_failed");
        }
        return {
          handoffId: result.handoff_id ?? handoffId,
          objectId: result.object_id,
          storagePath: result.storage_path,
          versionNumber: 2,
        } satisfies StartedReturn;
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async beginReturnNext(handoffId) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("begin_handoff_return_next", {
          handoff_id: handoffId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("handoff_return_begin_failed"));
        }
        const result = data as {
          handoff_id: string;
          object_id: string;
          storage_path: string;
          version_number: number;
        };
        if (!result.object_id || !result.storage_path || !result.version_number) {
          throw new CloudError("handoff_return_begin_failed");
        }
        return {
          handoffId: result.handoff_id ?? handoffId,
          objectId: result.object_id,
          storagePath: result.storage_path,
          versionNumber: result.version_number,
        } satisfies StartedReturn;
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async finalizeReturnV2(handoffId, objectId, fileSize, blake3) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("finalize_handoff_return_v2", {
          handoff_id: handoffId,
          object_id: objectId,
          file_size: fileSize,
          blake3,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async finalizeHandoffReturn(handoffId, versionNumber, objectId, fileSize, blake3) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("finalize_handoff_return", {
          handoff_id: handoffId,
          version_number: versionNumber,
          object_id: objectId,
          file_size: fileSize,
          blake3,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async failHandoffReturn(handoffId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("fail_handoff_return", {
          handoff_id: handoffId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async completeHandoff(handoffId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("complete_handoff", {
          handoff_id: handoffId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async requestRevision(handoffId, note) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("request_revision", {
          handoff_id: handoffId,
          note,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async markReturnReceived(handoffId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("mark_return_received", {
          handoff_id: handoffId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async createHandoffV2(
      recipientMemberId,
      originalFilename,
      requestedAction,
      instruction,
      dueOn,
      clientRequestId,
    ) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("create_handoff_v2", {
          p_recipient_member_id: recipientMemberId,
          p_original_filename: originalFilename,
          p_requested_action: requestedAction,
          p_instruction: instruction,
          p_due_on: dueOn,
          p_client_request_id: clientRequestId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("handoff_create_failed"));
        }
        return mapCreatedHandoffV2(data);
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async createFileRequestV2(recipientMemberId, instruction, dueOn, clientRequestId) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("create_file_request_v2", {
          p_recipient_member_id: recipientMemberId,
          p_instruction: instruction,
          p_due_on: dueOn,
          p_client_request_id: clientRequestId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("handoff_create_failed"));
        }
        const row = data as { handoff_id?: string; transfer_id?: string };
        if (!row.handoff_id || !row.transfer_id) {
          throw new CloudError("handoff_create_failed");
        }
        return { handoffId: row.handoff_id, transferId: row.transfer_id } satisfies CreatedFileRequest;
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async finalizeHandoffV2Initial(handoffId, objectId, fileSize, blake3, clientRequestId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("finalize_handoff_v2_initial", {
          p_handoff_id: handoffId,
          p_object_id: objectId,
          p_file_size: fileSize,
          p_blake3: blake3,
          p_client_request_id: clientRequestId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async failHandoffV2Initial(handoffId, clientRequestId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("fail_handoff_v2_initial", {
          p_handoff_id: handoffId,
          p_client_request_id: clientRequestId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async retryHandoffV2Initial(handoffId, clientRequestId) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("retry_handoff_v2_initial", {
          p_handoff_id: handoffId,
          p_client_request_id: clientRequestId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("handoff_retry_failed"));
        }
        return mapCreatedHandoffV2(data);
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async markRootTransferOpened(handoffId, clientRequestId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("mark_root_transfer_opened", {
          p_handoff_id: handoffId,
          p_client_request_id: clientRequestId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async beginTransferResultUpload(handoffId, clientRequestId) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("begin_transfer_result_upload", {
          p_handoff_id: handoffId,
          p_client_request_id: clientRequestId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("handoff_return_begin_failed"));
        }
        return mapStartedResult(data);
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async renewTransferUploadReservation(handoffId, clientRequestId) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("renew_transfer_upload_reservation", {
          p_handoff_id: handoffId,
          p_client_request_id: clientRequestId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("reservation_renewal_required"));
        }
        return mapStartedResult(data);
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async finalizeTransferResult(
      handoffId,
      resultAction,
      resultNote,
      objectId,
      fileSize,
      blake3,
      clientRequestId,
    ) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("finalize_transfer_result", {
          p_handoff_id: handoffId,
          p_result_action: resultAction,
          p_result_note: resultNote,
          p_object_id: objectId,
          p_file_size: fileSize,
          p_blake3: blake3,
          p_client_request_id: clientRequestId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async finalizeFileRequestResult(handoffId, fileName, objectId, fileSize, blake3, clientRequestId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("finalize_file_request_result", {
          p_handoff_id: handoffId,
          p_file_name: fileName,
          p_object_id: objectId,
          p_file_size: fileSize,
          p_blake3: blake3,
          p_client_request_id: clientRequestId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async submitTransferResultWithoutFile(handoffId, resultAction, resultNote, clientRequestId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("submit_transfer_result_without_file", {
          p_handoff_id: handoffId,
          p_result_action: resultAction,
          p_result_note: resultNote,
          p_client_request_id: clientRequestId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async abortTransferResultUpload(handoffId, clientRequestId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("abort_transfer_result_upload", {
          p_handoff_id: handoffId,
          p_client_request_id: clientRequestId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async acceptRootTransferResult(handoffId, clientRequestId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("accept_root_transfer_result", {
          p_handoff_id: handoffId,
          p_client_request_id: clientRequestId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async requestRootTransferRevision(handoffId, note, clientRequestId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("request_root_transfer_revision", {
          p_handoff_id: handoffId,
          p_note: note,
          p_client_request_id: clientRequestId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async cancelRootHandoffV2(handoffId, clientRequestId) {
      try {
        const client = await requireClient();
        const { error } = await client.rpc("cancel_root_handoff_v2", {
          p_handoff_id: handoffId,
          p_client_request_id: clientRequestId,
        });
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async sendTransferReminder(handoffId, clientRequestId) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("send_transfer_reminder", {
          p_handoff_id: handoffId,
          p_client_request_id: clientRequestId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("reminder_failed"));
        }
        const row = data as { sent_at?: string; next_allowed_at?: string };
        return {
          sentAt: asText(row.sent_at) ?? new Date().toISOString(),
          nextAllowedAt: asText(row.next_allowed_at) ?? new Date().toISOString(),
        } satisfies ReminderResult;
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async removeStorageObject(storagePath) {
      try {
        const client = await requireClient();
        const { error } = await client.storage.from("filerelay").remove([storagePath]);
        if (error) {
          throw toCloudError(error);
        }
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async createSignedDownloadUrl(storagePath) {
      try {
        const client = await requireClient();
        const { data, error } = await client.storage
          .from("filerelay")
          .createSignedUrl(storagePath, 60);
        if (error || !data?.signedUrl) {
          throw toCloudError(error ?? new CloudError("download_failed"));
        }
        return data.signedUrl;
      } catch (error) {
        throw toCloudError(error);
      }
    },
    subscribeToIncomingHandoffs(recipientMemberId, onChange, options) {
      let stopped = false;
      let stopInner: (() => void) | null = null;
      void getSupabaseClient().then((client) => {
        if (stopped || !client || !isSupabaseConfigured()) {
          return;
        }
        stopInner = subscribeIncomingHandoffs(client, recipientMemberId, onChange, {
          onSubscribed: options?.onSubscribed,
          onDisconnected: options?.onDisconnected,
        });
      });
      return () => {
        stopped = true;
        stopInner?.();
      };
    },
    subscribeToOutgoingHandoffs(senderMemberId, onChange, options) {
      let stopped = false;
      let stopInner: (() => void) | null = null;
      void getSupabaseClient().then((client) => {
        if (stopped || !client || !isSupabaseConfigured()) {
          return;
        }
        stopInner = subscribeOutgoingHandoffs(client, senderMemberId, onChange, {
          onSubscribed: options?.onSubscribed,
          onDisconnected: options?.onDisconnected,
        });
      });
      return () => {
        stopped = true;
        stopInner?.();
      };
    },
    subscribeToHandoffEvents(memberId, onEvent, options) {
      let stopped = false;
      let stopInner: (() => void) | null = null;
      void getSupabaseClient().then((client) => {
        if (stopped || !client || !isSupabaseConfigured()) {
          return;
        }
        stopInner = subscribeHandoffEvents(client, memberId, onEvent, {
          onSubscribed: options?.onSubscribed,
          onDisconnected: options?.onDisconnected,
        });
      });
      return () => {
        stopped = true;
        stopInner?.();
      };
    },
  };
}
