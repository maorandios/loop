export type Workspace = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
};

export type WorkspaceMember = {
  id: string;
  workspaceId: string;
  userId: string;
  deviceId: string;
  displayName: string;
  email?: string | null;
  joinedAt: string;
  lastSeenAt: string;
};

export type CreatedWorkspace = {
  workspaceId: string;
  memberId: string;
  joinCode: string;
  workspace: Workspace;
};

export type JoinedWorkspace = {
  workspaceId: string;
  memberId: string;
  workspace: Workspace;
};

export type WorkspaceService = {
  isConfigured(): boolean;
  ensureSession(): Promise<string>;
  getCurrentWorkspace(): Promise<Workspace | null>;
  createWorkspace(displayName: string, deviceId: string): Promise<CreatedWorkspace>;
  joinWorkspace(
    joinCode: string,
    displayName: string,
    deviceId: string,
  ): Promise<JoinedWorkspace>;
  rotateWorkspaceJoinCode(workspaceId: string): Promise<string>;
  listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  subscribeToWorkspaceMembers(workspaceId: string, onChange: () => void): () => void;
  subscribeToIncomingHandoffs(workspaceId: string, onChange: () => void): () => void;
  unsubscribe(): void;
};
