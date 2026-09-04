import { getSupabaseClient } from "../../lib/supabase/client";
import { isSupabaseConfigured } from "../../lib/supabase/config";
import { CloudError, toCloudError } from "../../lib/supabase/errors";
import { subscribeIncomingHandoffs, subscribeOutgoingHandoffs } from "../workspace/realtime";
import type { HandoffStatus } from "../../copy/he";
import type { CreatedHandoff, HandoffEvent, HandoffRecord, HandoffService, HandoffVersion, StartedReturn } from "./types";

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
};

type EventRow = {
  event_type: string;
  note?: string | null;
  version_number?: number | null;
  actor_member_id?: string | null;
  created_at: string;
};

type HandoffRow = {
  id: string;
  workspace_id: string;
  sender_member_id: string;
  recipient_member_id: string;
  original_filename: string;
  instruction?: string | null;
  due_on?: string | null;
  status: HandoffStatus;
  created_at: string;
  updated_at: string;
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
      eventType: event.event_type,
      note: event.note ?? null,
      versionNumber: event.version_number ?? null,
      actorMemberId: event.actor_member_id ?? null,
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
    originalFilename: row.original_filename,
    instruction: row.instruction ?? null,
    dueOn: row.due_on ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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

export function createSupabaseHandoffService(): HandoffService {
  return {
    async listHandoffs() {
      if (!isSupabaseConfigured()) {
        return [];
      }
      try {
        const client = await getSupabaseClient();
        if (!client) {
          return [];
        }
        const { data, error } = await client
          .from("handoffs")
          .select(
            "id, workspace_id, sender_member_id, recipient_member_id, original_filename, instruction, due_on, status, created_at, updated_at, handoff_versions(version_number, storage_path, file_size, blake3), handoff_events(event_type, note, version_number, actor_member_id, created_at)",
          )
          .order("created_at", { ascending: false });
        if (error) {
          throw toCloudError(error);
        }
        return ((data as HandoffRow[] | null) ?? []).map(mapHandoff);
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
    subscribeToIncomingHandoffs(recipientMemberId, onChange) {
      let stopped = false;
      let stopInner: (() => void) | null = null;
      void getSupabaseClient().then((client) => {
        if (stopped || !client || !isSupabaseConfigured()) {
          return;
        }
        stopInner = subscribeIncomingHandoffs(client, recipientMemberId, onChange);
      });
      return () => {
        stopped = true;
        stopInner?.();
      };
    },
    subscribeToOutgoingHandoffs(senderMemberId, onChange) {
      let stopped = false;
      let stopInner: (() => void) | null = null;
      void getSupabaseClient().then((client) => {
        if (stopped || !client || !isSupabaseConfigured()) {
          return;
        }
        stopInner = subscribeOutgoingHandoffs(client, senderMemberId, onChange);
      });
      return () => {
        stopped = true;
        stopInner?.();
      };
    },
  };
}
