import { CloudError } from "../../lib/supabase/errors";
import { normalizeJoinCodeInput } from "./joinCode";
import { defaultWorkspaceName } from "./naming";
import type {
  CreatedWorkspace,
  JoinedWorkspace,
  Workspace,
  WorkspaceMember,
  WorkspaceService,
} from "./types";

export type MockWorkspaceState = {
  configured?: boolean;
  sessionUserId?: string | null;
  workspace?: Workspace | null;
  members?: WorkspaceMember[];
  createdJoinCode?: string;
  rotatedJoinCode?: string;
  failEnsureSession?: CloudError | CloudError[];
  failCreate?: CloudError;
  failJoin?: CloudError;
  failRotate?: CloudError;
  anonymousSignInCount?: { value: number };
  rotateCount?: { value: number };
  joinCount?: { value: number };
  lastJoinCode?: { value: string | null };
  unsubscribeCount?: { value: number };
  memberListeners?: Array<() => void>;
};

export type MockWorkspaceService = WorkspaceService & {
  emitMembers(next: WorkspaceMember[]): void;
};

export function createMockWorkspaceService(
  state: MockWorkspaceState = {},
): MockWorkspaceService {
  let sessionUserId = state.sessionUserId ?? null;
  let workspace = state.workspace ?? null;
  let members = [...(state.members ?? [])];
  let ensureCallIndex = 0;
  const signInCount = state.anonymousSignInCount ?? { value: 0 };
  const rotateCount = state.rotateCount ?? { value: 0 };
  const joinCount = state.joinCount ?? { value: 0 };
  const lastJoinCode = state.lastJoinCode ?? { value: state.createdJoinCode ?? null };
  const unsubscribeCount = state.unsubscribeCount ?? { value: 0 };
  const listeners = state.memberListeners ?? [];

  return {
    isConfigured() {
      return state.configured ?? true;
    },
    async ensureSession() {
      const fail = state.failEnsureSession;
      if (Array.isArray(fail)) {
        const next = fail[ensureCallIndex];
        ensureCallIndex += 1;
        if (next) {
          throw next;
        }
      } else if (fail) {
        throw fail;
      }
      if (sessionUserId) {
        return sessionUserId;
      }
      signInCount.value += 1;
      sessionUserId = "user-anon-1";
      return sessionUserId;
    },
    async getCurrentWorkspace() {
      return workspace;
    },
    async createWorkspace(displayName, deviceId) {
      if (state.failCreate) {
        throw state.failCreate;
      }
      const userId = sessionUserId ?? "user-anon-1";
      const created: CreatedWorkspace = {
        workspaceId: "workspace-1",
        memberId: "member-1",
        joinCode: state.createdJoinCode ?? "AB12-CD34",
        workspace: {
          id: "workspace-1",
          name: defaultWorkspaceName(displayName),
          createdBy: userId,
          createdAt: "2026-09-02T00:00:00.000Z",
        },
      };
      lastJoinCode.value = created.joinCode;
      workspace = created.workspace;
      members = [
        {
          id: created.memberId,
          workspaceId: created.workspaceId,
          userId,
          deviceId,
          displayName,
          joinedAt: created.workspace.createdAt,
          lastSeenAt: created.workspace.createdAt,
        },
      ];
      return created;
    },
    async joinWorkspace(joinCode, displayName, deviceId) {
      joinCount.value += 1;
      lastJoinCode.value = normalizeJoinCodeInput(joinCode);
      if (state.failJoin) {
        throw state.failJoin;
      }
      const userId = sessionUserId ?? "user-anon-2";
      const existing = members.find((member) => member.userId === userId);
      if (existing && workspace) {
        return {
          workspaceId: workspace.id,
          memberId: existing.id,
          workspace,
        };
      }
      const joined: JoinedWorkspace = {
        workspaceId: "workspace-1",
        memberId: existing?.id ?? "member-2",
        workspace: {
          id: "workspace-1",
          name: defaultWorkspaceName("מאור"),
          createdBy: "user-anon-1",
          createdAt: "2026-09-02T00:00:00.000Z",
        },
      };
      workspace = joined.workspace;
      if (!existing) {
        members = [
          {
            id: "member-1",
            workspaceId: joined.workspaceId,
            userId: "user-anon-1",
            deviceId: "11111111-1111-4111-8111-111111111111",
            displayName: "מאור",
            joinedAt: joined.workspace.createdAt,
            lastSeenAt: joined.workspace.createdAt,
          },
          {
            id: joined.memberId,
            workspaceId: joined.workspaceId,
            userId,
            deviceId,
            displayName,
            joinedAt: joined.workspace.createdAt,
            lastSeenAt: joined.workspace.createdAt,
          },
        ];
      }
      return joined;
    },
    async rotateWorkspaceJoinCode(workspaceId) {
      if (state.failRotate) {
        throw state.failRotate;
      }
      const userId = sessionUserId ?? "user-anon-1";
      if (!workspace || workspace.id !== workspaceId || workspace.createdBy !== userId) {
        throw new CloudError("join_code_rotate_failed");
      }
      rotateCount.value += 1;
      const nextCode = state.rotatedJoinCode ?? "XY98-ZT76";
      lastJoinCode.value = nextCode;
      return nextCode;
    },
    async listWorkspaceMembers() {
      return members;
    },
    subscribeToWorkspaceMembers(_workspaceId, onChange) {
      listeners.push(onChange);
      return () => {
        const index = listeners.indexOf(onChange);
        if (index >= 0) {
          listeners.splice(index, 1);
        }
        unsubscribeCount.value += 1;
      };
    },
    subscribeToIncomingHandoffs() {
      return () => undefined;
    },
    unsubscribe() {
      unsubscribeCount.value += 1;
    },
    emitMembers(next) {
      members = [...next];
      state.members = members;
      for (const listener of [...listeners]) {
        listener();
      }
    },
  };
}
