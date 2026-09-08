import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { he } from "./copy/he";
import { CloudError } from "./lib/supabase/errors";
import { createMockHandoffService } from "./features/handoff/mock";
import { createMockWorkspaceService } from "./features/workspace/mock";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

vi.mock("./features/handoff/service", async () => {
  const { createMockHandoffService } = await import("./features/handoff/mock");
  return {
    createSupabaseHandoffService: () => createMockHandoffService(),
  };
});

const mockedInvoke = vi.mocked(invoke);

function mockTauriSnapshot(localDevice: { deviceId: string; displayName: string } | null) {
  mockedInvoke.mockImplementation(async (command) => {
    if (command === "get_snapshot") {
      return { localDevice };
    }
    if (command === "inbox_local_state") {
      return [];
    }
    if (command === "get_pending_local_statuses") {
      return [];
    }
    if (command === "acknowledge_local_status_sync") {
      return true;
    }
    if (command === "get_autostart_state" || command === "set_autostart_enabled") {
      return { enabled: false };
    }
    if (command === "list_resume_uploads") {
      return [];
    }
    return null;
  });
}

const savedDevice = {
  deviceId: "11111111-1111-4111-8111-111111111111",
  displayName: "מאור",
};

const readyWorkspace = {
  id: "workspace-1",
  name: "הצוות של מאור",
  createdBy: "user-1",
  createdAt: "2026-09-02T00:00:00.000Z",
};

const maorMember = {
  id: "member-1",
  workspaceId: "workspace-1",
  userId: "user-1",
  deviceId: savedDevice.deviceId,
  displayName: "מאור",
  joinedAt: "2026-09-02T00:00:00.000Z",
  lastSeenAt: "2026-09-02T00:00:00.000Z",
};

describe("App cloud workspace flow", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
  });

  it("keeps the loading state until the local store snapshot arrives", async () => {
    mockedInvoke.mockImplementation(() => new Promise(() => undefined));

    render(<App workspaceService={createMockWorkspaceService()} />);

    expect(screen.getByText(he.loading)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: he.setupTitle }),
    ).not.toBeInTheDocument();
    await waitFor(() => {
      expect(mockedInvoke).toHaveBeenCalledWith("get_snapshot");
    });
  });

  it("shows local setup only after the store reports no device", async () => {
    mockTauriSnapshot(null);

    render(<App workspaceService={createMockWorkspaceService()} />);

    expect(
      await screen.findByRole("heading", { name: he.setupTitle }),
    ).toBeInTheDocument();
  });

  it("shows create and join when the user has no workspace", async () => {
    mockTauriSnapshot(savedDevice);

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          workspace: null,
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: he.workspaceHowToStart }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.createWorkspace })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.joinWorkspace })).toBeInTheDocument();
  });

  it("loads an existing session without creating another anonymous user", async () => {
    mockTauriSnapshot(savedDevice);
    const anonymousSignInCount = { value: 0 };

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          anonymousSignInCount,
          workspace: null,
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: he.workspaceHowToStart }),
    ).toBeInTheDocument();
    expect(anonymousSignInCount.value).toBe(0);
  });

  it("creates an anonymous user once when no session exists", async () => {
    mockTauriSnapshot(savedDevice);
    const anonymousSignInCount = { value: 0 };

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: null,
          anonymousSignInCount,
          workspace: null,
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: he.workspaceHowToStart }),
    ).toBeInTheDocument();
    expect(anonymousSignInCount.value).toBe(1);
  });

  it("does not create another user after a temporary connection failure", async () => {
    mockTauriSnapshot(savedDevice);
    const anonymousSignInCount = { value: 0 };

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          anonymousSignInCount,
          failEnsureSession: [new CloudError("cloud_unavailable")],
          workspace: readyWorkspace,
          members: [maorMember],
        })}
      />,
    );

    expect(await screen.findByRole("heading", { name: he.cannotConnectNow })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: he.tryAgain })).toBeInTheDocument();
    expect(anonymousSignInCount.value).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: he.tryAgain }));
    expect(
      await screen.findByRole("heading", { name: he.appName }),
    ).toBeInTheDocument();
    expect(anonymousSignInCount.value).toBe(0);
  });

  it("skips the join screen when a workspace already exists", async () => {
    mockTauriSnapshot(savedDevice);

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          workspace: readyWorkspace,
          members: [maorMember],
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: he.appName }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.settings }));
    expect(screen.getAllByText("מאור").length).toBeGreaterThan(0);
    expect(screen.getByText(new RegExp(he.thisComputer))).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: he.workspaceHowToStart }),
    ).not.toBeInTheDocument();
  });

  it("returns to the same workspace after a restart", async () => {
    mockTauriSnapshot(savedDevice);
    const service = createMockWorkspaceService({
      configured: true,
      sessionUserId: "user-1",
      workspace: readyWorkspace,
      members: [maorMember],
    });

    const first = render(<App workspaceService={service} />);
    expect(
      await screen.findByRole("heading", { name: he.appName }),
    ).toBeInTheDocument();
    first.unmount();

    render(<App workspaceService={service} />);
    expect(
      await screen.findByRole("heading", { name: he.appName }),
    ).toBeInTheDocument();
    expect(screen.queryByText("הצוות של מאור")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: he.workspaceHowToStart }),
    ).not.toBeInTheDocument();
  });

  it("moves to the team screen after creating a workspace", async () => {
    mockTauriSnapshot(savedDevice);

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          createdJoinCode: "AB12-CD34",
          workspace: null,
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: he.createWorkspace }));
    expect(
      await screen.findByRole("heading", { name: he.appName }),
    ).toBeInTheDocument();
    expect(screen.queryByText("הצוות של מאור")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.settings }));
    expect(screen.getByText("AB12-CD34")).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("button", { name: he.copyJoinCode })).toBeInTheDocument();
  });

  it("moves to the team screen after joining with a valid code", async () => {
    mockTauriSnapshot({
      deviceId: "22222222-2222-4222-8222-222222222222",
      displayName: "דנה",
    });

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-2",
          workspace: null,
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: he.joinWorkspace }));
    fireEvent.change(screen.getByLabelText(he.joinCodeLabel), {
      target: { value: "ab12cd34" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: he.joinWorkspace })[1]!);

    expect(
      await screen.findByRole("heading", { name: he.appName }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.settings }));
    expect(screen.getAllByText("דנה").length).toBeGreaterThan(0);
    expect(screen.getAllByText("מאור").length).toBeGreaterThan(0);
  });

  it("shows a Hebrew message for an invalid join code", async () => {
    mockTauriSnapshot(savedDevice);

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-2",
          workspace: null,
          failJoin: new CloudError("invalid_join_code"),
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: he.joinWorkspace }));
    fireEvent.change(screen.getByLabelText(he.joinCodeLabel), {
      target: { value: "ZZ99-ZZ99" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: he.joinWorkspace })[1]!);

    expect(await screen.findByText(he.cloudError.invalid_join_code)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/P0001|postgres|JWT|invalid_join_code/i);
  });

  it("shows a member who joins after the host is already subscribed, without a reload", async () => {
    mockTauriSnapshot(savedDevice);
    const service = createMockWorkspaceService({
      configured: true,
      sessionUserId: "user-1",
      workspace: readyWorkspace,
      members: [maorMember],
    });

    render(<App workspaceService={service} />);
    expect(await screen.findByText(he.waitingForMembers)).toBeInTheDocument();
    expect(screen.queryByText("דנה")).not.toBeInTheDocument();

    service.emitMembers([
      maorMember,
      {
        id: "member-2",
        workspaceId: "workspace-1",
        userId: "user-2",
        deviceId: "22222222-2222-4222-8222-222222222222",
        displayName: "דנה",
        joinedAt: "2026-09-02T00:00:00.000Z",
        lastSeenAt: "2026-09-02T00:00:00.000Z",
      },
    ]);

    expect(await screen.findByRole("button", { name: he.newRequest })).toBeInTheDocument();
    expect(screen.queryByText(he.waitingForMembers)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.settings }));
    expect(screen.getAllByText("דנה").length).toBeGreaterThan(0);
  });

  it("removes the Realtime subscription on cleanup", async () => {
    mockTauriSnapshot(savedDevice);
    const unsubscribeCount = { value: 0 };
    const service = createMockWorkspaceService({
      configured: true,
      sessionUserId: "user-1",
      workspace: readyWorkspace,
      members: [maorMember],
      unsubscribeCount,
    });

    const view = render(<App workspaceService={service} />);
    expect(
      await screen.findByRole("heading", { name: he.appName }),
    ).toBeInTheDocument();
    view.unmount();
    expect(unsubscribeCount.value).toBeGreaterThan(0);
  });

  it("shows the Hebrew not-configured screen without env names or keys", async () => {
    mockTauriSnapshot(savedDevice);

    render(
      <App workspaceService={createMockWorkspaceService({ configured: false })} />,
    );

    expect(
      await screen.findByRole("heading", { name: he.cloudNotConfiguredTitle }),
    ).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("VITE_SUPABASE");
    expect(text).not.toContain("service_role");
    expect(text).not.toContain("anon");
  });

  it("lets a creator rotate a missing join code from the team screen", async () => {
    mockTauriSnapshot(savedDevice);

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          rotatedJoinCode: "XY98-ZT76",
          workspace: readyWorkspace,
          members: [maorMember],
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: he.settings }));
    expect(
      await screen.findByRole("button", { name: he.createNewJoinCode }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.createNewJoinCode }));
    expect(await screen.findByText("XY98-ZT76")).toHaveAttribute("dir", "ltr");
    expect(screen.getByRole("button", { name: he.copyJoinCode })).toBeInTheDocument();
  });

  it("hides join-code creation from a member who did not create the team", async () => {
    mockTauriSnapshot(savedDevice);

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-2",
          workspace: {
            ...readyWorkspace,
            createdBy: "user-1",
          },
          members: [
            {
              ...maorMember,
              id: "member-2",
              userId: "user-2",
            },
          ],
        })}
      />,
    );

    expect(
      await screen.findByRole("heading", { name: he.appName }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.settings }));
    expect(
      screen.queryByRole("button", { name: he.createNewJoinCode }),
    ).not.toBeInTheDocument();
  });

  it("shows the Hebrew auth-store corrupt message without file contents", async () => {
    mockTauriSnapshot(savedDevice);

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          failEnsureSession: new CloudError("auth_store_corrupt"),
        })}
      />,
    );

    expect(
      await screen.findByText(he.cloudError.auth_store_corrupt),
    ).toBeInTheDocument();
    expect(screen.getByText(he.authStoreCorruptHint)).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("auth_store_corrupt");
    expect(text).not.toContain("access_token");
    expect(text).not.toContain("refresh_token");
    expect(text).not.toContain("supabase-auth.json");
    expect(text).not.toMatch(/JSON|SyntaxError|parse/i);
  });

  it("does not leak tokens, hashes, or raw Supabase errors in the team UI", async () => {
    mockTauriSnapshot(savedDevice);

    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          createdJoinCode: "AB12-CD34",
          workspace: null,
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: he.createWorkspace }));
    expect(
      await screen.findByRole("heading", { name: he.appName }),
    ).toBeInTheDocument();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("access_token");
    expect(text).not.toContain("refresh_token");
    expect(text).not.toContain("join_code_hash");
    expect(text).not.toMatch(/eyJ[a-zA-Z0-9_-]+\./);
    expect(text).not.toMatch(/P0001|postgres|supabase/i);
  });

  it("listens to incoming handoffs and refetches the allowed list", async () => {
    mockTauriSnapshot(savedDevice);
    const dana = {
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      deviceId: "22222222-2222-4222-8222-222222222222",
      displayName: "דנה",
      joinedAt: "2026-09-02T00:00:00.000Z",
      lastSeenAt: "2026-09-02T00:00:00.000Z",
    };
    const workspaceService = createMockWorkspaceService({
      configured: true,
      sessionUserId: "user-1",
      workspace: readyWorkspace,
      members: [maorMember, dana],
    });
    const handoffService = createMockHandoffService();

    render(
      <App workspaceService={workspaceService} handoffService={handoffService} />,
    );
    expect(await screen.findByText(he.noPrimaryAction)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.newRequest }));
    expect(screen.getByRole("button", { name: he.send })).toBeInTheDocument();

    handoffService.emitIncoming([
      {
        id: "handoff-1",
        workspaceId: "workspace-1",
        senderMemberId: "member-2",
        recipientMemberId: "member-1",
        originalFilename: "דוח.docx",
        status: "sent",
        createdAt: "2026-09-02T00:00:00.000Z",
        updatedAt: "2026-09-02T00:00:00.000Z",
        fileSize: 2048,
        blake3: "ab".repeat(32),
        storagePath: "workspace/handoff/v1/object",
        instruction: null,
        dueOn: null,
        versions: [],
        returnFileSize: null,
        returnBlake3: null,
        returnStoragePath: null,
        events: [],
      },
    ]);

    fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${he.primaryAction}\\s`) }));
    expect(await screen.findByText("דוח.docx")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.openAndHandle })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("storagePath");
    expect(document.body.textContent).not.toContain("signedUrl");
  });

  it("keeps already-loaded cards when a later snapshot fails", async () => {
    mockTauriSnapshot(savedDevice);
    const dana = {
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      deviceId: "22222222-2222-4222-8222-222222222222",
      displayName: "דנה",
      joinedAt: "2026-09-02T00:00:00.000Z",
      lastSeenAt: "2026-09-02T00:00:00.000Z",
    };
    const workspaceService = createMockWorkspaceService({
      configured: true,
      sessionUserId: "user-1",
      workspace: readyWorkspace,
      members: [maorMember, dana],
    });
    const handoffService = createMockHandoffService({
      handoffs: [
        {
          id: "handoff-1",
          workspaceId: "workspace-1",
          senderMemberId: "member-2",
          recipientMemberId: "member-1",
          originalFilename: "דוח.docx",
          status: "sent",
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
          fileSize: 2048,
          blake3: "ab".repeat(32),
          storagePath: "workspace/handoff/v1/object",
          instruction: null,
          dueOn: null,
          versions: [],
          returnFileSize: null,
          returnBlake3: null,
          returnStoragePath: null,
          events: [],
        },
      ],
    });

    render(
      <App workspaceService={workspaceService} handoffService={handoffService} />,
    );
    fireEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${he.primaryAction}\\s`) }));
    expect(await screen.findByText("דוח.docx")).toBeInTheDocument();
    handoffService.failNextSnapshot();
    handoffService.notifyIncoming();
    expect(await screen.findByText("דוח.docx")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: he.openAndHandle })).not.toBeInTheDocument();
  });

  it("subscribes to incoming handoffs from the app shell", () => {
    const app = readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf8");
    expect(app).toContain("subscribeToIncomingHandoffs");
    expect(app).toContain("subscribeToOutgoingHandoffs");
    expect(app).toContain("subscribeToHandoffEvents");
    expect(app).toContain("subscribeToWorkspaceMembers");
    expect(app).toContain("createHandoffSyncController");
    expect(app).toContain("notifyEvent");
    expect(app).toContain("sync.start()");
    expect(app).toContain("markUnsubscribed");
    expect(app).toContain("syncRef.current?.retry()");
  });

  it("uses createHandoffV2, clears selection after send, and never marks return received", async () => {
    const dana = {
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      deviceId: "22222222-2222-4222-8222-222222222222",
      displayName: "דנה",
      joinedAt: "2026-09-02T00:00:00.000Z",
      lastSeenAt: "2026-09-02T00:00:00.000Z",
    };
    const cancelled: string[] = [];
    mockedInvoke.mockImplementation(async (command, payload) => {
      if (command === "get_snapshot") {
        return { localDevice: savedDevice };
      }
      if (command === "inbox_local_state" || command === "get_pending_local_statuses") {
        return [];
      }
      if (command === "get_autostart_state" || command === "set_autostart_enabled") {
        return { enabled: false };
      }
      if (command === "pick_send_file") {
        return {
          selectionId: "sel-1",
          originalFilename: "דוח.docx",
          size: 12,
          blake3: "ab".repeat(32),
        };
      }
      if (command === "cancel_send_selection") {
        cancelled.push(String((payload as { selectionId: string }).selectionId));
        return null;
      }
      if (command === "list_resume_uploads") {
        return [];
      }
      if (command === "tus_upload_initial_v2") {
        throw new CloudError("send_failed");
      }
      return null;
    });
    const handoffService = createMockHandoffService();
    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          workspace: readyWorkspace,
          members: [maorMember, dana],
        })}
        handoffService={handoffService}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: he.newRequest }));
    expect(screen.getByRole("button", { name: he.send })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.chooseFile }));
    expect(await screen.findByText("דוח.docx")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(he.instructionLabel), {
      target: { value: "נא לבדוק" },
    });
    fireEvent.click(screen.getByRole("button", { name: he.send }));
    await waitFor(() => {
      expect(handoffService.createV2Calls).toBe(1);
    });
    expect(handoffService.createHandoffCalls).toBe(0);
    expect(handoffService.lastCreatedV2).toEqual({
      recipientMemberId: "member-2",
      originalFilename: "דוח.docx",
      requestedAction: "approval",
      instruction: "נא לבדוק",
      dueOn: null,
      clientRequestId: handoffService.lastCreatedV2?.clientRequestId,
    });
    expect(handoffService.failV2InitialCalls).toEqual([]);
    expect(handoffService.failHandoffCalls).toEqual([]);
    await waitFor(() => {
      expect(cancelled).toContain("sel-1");
    });
    expect(handoffService.markReturnReceivedCalls).toEqual([]);
    const app = readFileSync(path.join(process.cwd(), "src/App.tsx"), "utf8");
    expect(app).toContain("sendHandoffV2");
    expect(app).not.toContain("createHandoff(");
    expect(app).not.toContain("markReturnReceived");
  });

  it("keeps the selection when createHandoffV2 fails", async () => {
    const dana = {
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      deviceId: "22222222-2222-4222-8222-222222222222",
      displayName: "דנה",
      joinedAt: "2026-09-02T00:00:00.000Z",
      lastSeenAt: "2026-09-02T00:00:00.000Z",
    };
    const cancelled: string[] = [];
    mockedInvoke.mockImplementation(async (command, payload) => {
      if (command === "get_snapshot") {
        return { localDevice: savedDevice };
      }
      if (command === "inbox_local_state" || command === "get_pending_local_statuses") {
        return [];
      }
      if (command === "get_autostart_state") {
        return { enabled: false };
      }
      if (command === "list_resume_uploads") {
        return [];
      }
      if (command === "pick_send_file") {
        return {
          selectionId: "sel-keep",
          originalFilename: "דוח.docx",
          size: 12,
          blake3: "ab".repeat(32),
        };
      }
      if (command === "cancel_send_selection") {
        cancelled.push(String((payload as { selectionId: string }).selectionId));
        return null;
      }
      return null;
    });
    const handoffService = createMockHandoffService({
      failCreate: new CloudError("handoff_create_failed"),
    });
    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          workspace: readyWorkspace,
          members: [maorMember, dana],
        })}
        handoffService={handoffService}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: he.newRequest }));
    fireEvent.click(screen.getByRole("button", { name: he.chooseFile }));
    expect(await screen.findByText("דוח.docx")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(he.instructionLabel), {
      target: { value: "נא לבדוק" },
    });
    fireEvent.click(screen.getByRole("button", { name: he.send }));
    await waitFor(() => {
      expect(handoffService.createV2Calls).toBe(1);
    });
    expect(cancelled).toEqual([]);
    expect(screen.getByText("דוח.docx")).toBeInTheDocument();
  });

  it("clears the previous selection when picking another file or cancelling", async () => {
    const dana = {
      id: "member-2",
      workspaceId: "workspace-1",
      userId: "user-2",
      deviceId: "22222222-2222-4222-8222-222222222222",
      displayName: "דנה",
      joinedAt: "2026-09-02T00:00:00.000Z",
      lastSeenAt: "2026-09-02T00:00:00.000Z",
    };
    const cancelled: string[] = [];
    let pickCount = 0;
    mockedInvoke.mockImplementation(async (command, payload) => {
      if (command === "get_snapshot") {
        return { localDevice: savedDevice };
      }
      if (command === "inbox_local_state" || command === "get_pending_local_statuses") {
        return [];
      }
      if (command === "get_autostart_state") {
        return { enabled: false };
      }
      if (command === "list_resume_uploads") {
        return [];
      }
      if (command === "pick_send_file") {
        pickCount += 1;
        return {
          selectionId: pickCount === 1 ? "sel-a" : "sel-b",
          originalFilename: pickCount === 1 ? "ישן.docx" : "חדש.docx",
          size: 12,
          blake3: "ab".repeat(32),
        };
      }
      if (command === "cancel_send_selection") {
        cancelled.push(String((payload as { selectionId: string }).selectionId));
        return null;
      }
      return null;
    });
    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          workspace: readyWorkspace,
          members: [maorMember, dana],
        })}
        handoffService={createMockHandoffService()}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: he.newRequest }));
    fireEvent.click(screen.getByRole("button", { name: he.chooseFile }));
    expect(await screen.findByText("ישן.docx")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: he.chooseFile }));
    expect(await screen.findByText("חדש.docx")).toBeInTheDocument();
    await waitFor(() => {
      expect(cancelled).toContain("sel-a");
    });
    fireEvent.click(screen.getByRole("button", { name: he.cancel }));
    await waitFor(() => {
      expect(cancelled).toContain("sel-b");
    });
  });

  it("moves a returned handoff to completed after approval", async () => {
    mockedInvoke.mockImplementation(async (command) => {
      if (command === "get_snapshot") {
        return { localDevice: savedDevice };
      }
      if (command === "inbox_local_state" || command === "get_pending_local_statuses") {
        return [];
      }
      if (command === "get_autostart_state") {
        return { enabled: false };
      }
      return null;
    });
    const handoffService = createMockHandoffService({
      handoffs: [
        {
          id: "handoff-1",
          workspaceId: "workspace-1",
          senderMemberId: "member-1",
          recipientMemberId: "member-2",
          originalFilename: "דוח.docx",
          instruction: "בדוק",
          dueOn: null,
          status: "returned",
          createdAt: "2026-09-02T00:00:00.000Z",
          updatedAt: "2026-09-03T00:00:00.000Z",
          fileSize: 1,
          blake3: "aa",
          storagePath: "p",
          returnFileSize: 2,
          returnBlake3: "bb",
          returnStoragePath: "p2",
          versions: [
            { versionNumber: 1, storagePath: "p", fileSize: 1, blake3: "aa" },
            { versionNumber: 2, storagePath: "p2", fileSize: 2, blake3: "bb" },
          ],
          events: [],
        },
      ],
    });
    render(
      <App
        workspaceService={createMockWorkspaceService({
          configured: true,
          sessionUserId: "user-1",
          workspace: readyWorkspace,
          members: [
            maorMember,
            {
              id: "member-2",
              workspaceId: "workspace-1",
              userId: "user-2",
              deviceId: "22222222-2222-4222-8222-222222222222",
              displayName: "דנה",
              joinedAt: "2026-09-02T00:00:00.000Z",
              lastSeenAt: "2026-09-02T00:00:00.000Z",
            },
          ],
        })}
        handoffService={handoffService}
      />,
    );
    fireEvent.click(await screen.findByRole("tab", { name: new RegExp(`^${he.primaryAction}\\s`) }));
    fireEvent.click(await screen.findByText("בדוק"));
    fireEvent.click(await screen.findByRole("button", { name: he.actions }));
    fireEvent.click(await screen.findByRole("button", { name: he.approve }));
    await waitFor(() => {
      expect(handoffService.completeCalls).toEqual(["handoff-1"]);
    });
    fireEvent.click(screen.getByRole("button", { name: he.back }));
    fireEvent.click(screen.getByRole("tab", { name: new RegExp(`^${he.primaryCompleted}\\s`) }));
    expect(screen.getByText("דוח.docx")).toBeInTheDocument();
    expect(screen.getAllByText(he.handoffStatus.completed).length).toBeGreaterThan(0);
  });
});
