import { ensureAnonymousSession } from "../../lib/supabase/auth";
import { getSupabaseClient } from "../../lib/supabase/client";
import { isSupabaseConfigured } from "../../lib/supabase/config";
import { CloudError, toCloudError } from "../../lib/supabase/errors";
import { normalizeJoinCodeInput } from "./joinCode";
import { subscribeWorkspaceMembers } from "./realtime";
import type { Workspace, WorkspaceMember, WorkspaceService } from "./types";

type RpcCreateResult = {
  workspace_id: string;
  join_code: string;
  member_id: string;
};

type RpcJoinResult = {
  workspace_id: string;
  member_id: string;
};

type RpcRotateResult = {
  join_code: string;
};

type WorkspaceRow = {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
};

type MemberRow = {
  id: string;
  workspace_id: string;
  user_id: string;
  device_id: string;
  display_name: string;
  joined_at: string;
  last_seen_at: string;
};

async function requireClient() {
  const client = await getSupabaseClient();
  if (!client) {
    throw new CloudError("cloud_not_configured");
  }
  return client;
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapMember(row: MemberRow): WorkspaceMember {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    deviceId: row.device_id,
    displayName: row.display_name,
    joinedAt: row.joined_at,
    lastSeenAt: row.last_seen_at,
  };
}

async function loadWorkspace(workspaceId: string): Promise<Workspace> {
  const client = await requireClient();
  const { data, error } = await client
    .from("workspaces")
    .select("id, name, created_by, created_at")
    .eq("id", workspaceId)
    .maybeSingle();
  if (error || !data) {
    throw toCloudError(error ?? new CloudError("workspace_load_failed"));
  }
  return mapWorkspace(data as WorkspaceRow);
}

export function createSupabaseWorkspaceService(): WorkspaceService {
  const subscriptions: Array<() => void> = [];

  return {
    isConfigured() {
      return isSupabaseConfigured();
    },
    async ensureSession() {
      return ensureAnonymousSession();
    },
    async getCurrentWorkspace() {
      try {
        const client = await requireClient();
        const { data, error } = await client
          .from("workspace_members")
          .select("workspace_id")
          .limit(1)
          .maybeSingle();
        if (error) {
          throw toCloudError(error);
        }
        if (!data) {
          return null;
        }
        return loadWorkspace((data as { workspace_id: string }).workspace_id);
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async createWorkspace(displayName, deviceId) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("create_workspace", {
          display_name: displayName,
          device_id: deviceId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("workspace_creation_failed"));
        }
        const result = data as RpcCreateResult;
        const workspace = await loadWorkspace(result.workspace_id);
        return {
          workspaceId: result.workspace_id,
          memberId: result.member_id,
          joinCode: result.join_code,
          workspace,
        };
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async joinWorkspace(joinCode, displayName, deviceId) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("join_workspace", {
          join_code: normalizeJoinCodeInput(joinCode),
          display_name: displayName,
          device_id: deviceId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("invalid_join_code"));
        }
        const result = data as RpcJoinResult;
        const workspace = await loadWorkspace(result.workspace_id);
        return {
          workspaceId: result.workspace_id,
          memberId: result.member_id,
          workspace,
        };
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async rotateWorkspaceJoinCode(workspaceId) {
      try {
        const client = await requireClient();
        const { data, error } = await client.rpc("rotate_workspace_join_code", {
          workspace_id: workspaceId,
        });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("join_code_rotate_failed"));
        }
        const result = data as RpcRotateResult;
        if (!result.join_code) {
          throw new CloudError("join_code_rotate_failed");
        }
        return result.join_code;
      } catch (error) {
        throw toCloudError(error);
      }
    },
    async listWorkspaceMembers(workspaceId) {
      try {
        const client = await requireClient();
        const { data, error } = await client
          .from("workspace_members")
          .select(
            "id, workspace_id, user_id, device_id, display_name, joined_at, last_seen_at",
          )
          .eq("workspace_id", workspaceId)
          .order("joined_at", { ascending: true });
        if (error || !data) {
          throw toCloudError(error ?? new CloudError("members_load_failed"));
        }
        return (data as MemberRow[]).map(mapMember);
      } catch (error) {
        throw toCloudError(error);
      }
    },
    subscribeToWorkspaceMembers(workspaceId, onChange) {
      let stopped = false;
      let stopInner: (() => void) | null = null;
      void getSupabaseClient().then((client) => {
        if (stopped || !client || !isSupabaseConfigured()) {
          return;
        }
        stopInner = subscribeWorkspaceMembers(client, workspaceId, onChange);
      });
      return () => {
        stopped = true;
        stopInner?.();
      };
    },
    subscribeToIncomingHandoffs() {
      return () => undefined;
    },
    unsubscribe() {
      while (subscriptions.length > 0) {
        subscriptions.pop()?.();
      }
    },
  };
}
