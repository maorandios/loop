import { describe, expect, it } from "vitest";
import { CloudError } from "../../lib/supabase/errors";
import { createMockWorkspaceService } from "./mock";
import { defaultWorkspaceName } from "./naming";

describe("workspace naming", () => {
  it("defaults the team name to the Hebrew possessive form", () => {
    expect(defaultWorkspaceName("מאור")).toBe("הצוות של מאור");
    expect(defaultWorkspaceName("  מאור  ")).toBe("הצוות של מאור");
  });
});

describe("mock workspace join code rotation", () => {
  it("lets the creator replace the previous in-memory code", async () => {
    const lastJoinCode = { value: "AB12-CD34" as string | null };
    const rotateCount = { value: 0 };
    const service = createMockWorkspaceService({
      sessionUserId: "user-anon-1",
      lastJoinCode,
      rotateCount,
      rotatedJoinCode: "XY98-ZT76",
    });

    await service.createWorkspace("מאור", "11111111-1111-4111-8111-111111111111");
    expect(lastJoinCode.value).toBe("AB12-CD34");

    const next = await service.rotateWorkspaceJoinCode("workspace-1");
    expect(next).toBe("XY98-ZT76");
    expect(lastJoinCode.value).toBe("XY98-ZT76");
    expect(rotateCount.value).toBe(1);
  });

  it("rejects rotation for a regular member", async () => {
    const service = createMockWorkspaceService({
      sessionUserId: "user-anon-2",
      workspace: {
        id: "workspace-1",
        name: "הצוות של מאור",
        createdBy: "user-anon-1",
        createdAt: "2026-09-02T00:00:00.000Z",
      },
    });

    await expect(service.rotateWorkspaceJoinCode("workspace-1")).rejects.toMatchObject({
      code: "join_code_rotate_failed",
    });
    expect(CloudError).toBeDefined();
  });
});

describe("mock workspace join", () => {
  it("does not add a second membership for the same user", async () => {
    const joinCount = { value: 0 };
    const service = createMockWorkspaceService({
      sessionUserId: "user-anon-2",
      joinCount,
    });

    const first = await service.joinWorkspace("AB12-CD34", "דנה", "22222222-2222-4222-8222-222222222222");
    const second = await service.joinWorkspace("ab12cd34", "דנה", "22222222-2222-4222-8222-222222222222");
    const members = await service.listWorkspaceMembers(first.workspaceId);

    expect(joinCount.value).toBe(2);
    expect(second.memberId).toBe(first.memberId);
    expect(members.filter((member) => member.userId === "user-anon-2")).toHaveLength(1);
  });
});

describe("mock member realtime cleanup", () => {
  it("keeps member listeners when boot unsubscribe runs", () => {
    const service = createMockWorkspaceService({
      sessionUserId: "user-1",
      workspace: {
        id: "workspace-1",
        name: "הצוות של מאור",
        createdBy: "user-1",
        createdAt: "2026-09-02T00:00:00.000Z",
      },
      members: [
        {
          id: "member-1",
          workspaceId: "workspace-1",
          userId: "user-1",
          deviceId: "11111111-1111-4111-8111-111111111111",
          displayName: "מאור",
          joinedAt: "2026-09-02T00:00:00.000Z",
          lastSeenAt: "2026-09-02T00:00:00.000Z",
        },
      ],
    });
    let calls = 0;
    const stop = service.subscribeToWorkspaceMembers("workspace-1", () => {
      calls += 1;
    });
    service.unsubscribe();
    service.emitMembers([
      {
        id: "member-1",
        workspaceId: "workspace-1",
        userId: "user-1",
        deviceId: "11111111-1111-4111-8111-111111111111",
        displayName: "מאור",
        joinedAt: "2026-09-02T00:00:00.000Z",
        lastSeenAt: "2026-09-02T00:00:00.000Z",
      },
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
    expect(calls).toBe(1);
    stop();
  });
});
