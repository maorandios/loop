import { describe, expect, it } from "vitest";
import { he } from "../../copy/he";
import { presentHandoffCard } from "./cardPresentation";
import { buildDesignInbox, DESIGN_ALL_ACTIONS_ID, DESIGN_HISTORY_ICONS_ID, designPartnerMember, mergeDesignMembers } from "./designCards";
import { historyIcon, visibleHistory } from "./history";
import { projectHandoffList } from "./view";

const ME = "member-me";
const PARTNER = "member-partner";

function names(id: string): string {
  if (id === ME) {
    return "דני";
  }
  if (id === PARTNER) {
    return "דנה";
  }
  return "";
}

describe("design inbox catalog", () => {
  it("projects every status label without inconsistent stacks", () => {
    const inbox = buildDesignInbox({
      workspaceId: "workspace-1",
      meId: ME,
      partnerId: PARTNER,
    });
    const projected = projectHandoffList(inbox.handoffs, inbox.transfers, ME, names);
    expect(projected.inconsistent).toBe(false);
    expect(projected.counts.mine).toBeGreaterThan(0);
    expect(projected.counts.watching).toBeGreaterThan(0);
    expect(projected.counts.done).toBeGreaterThan(0);

    const labels = new Set(
      projected.cards.map((card) => presentHandoffCard(card, ME, names).statusLabel),
    );
    expect([...labels]).toEqual(
      expect.arrayContaining([
        he.actionApproval,
        he.actionReview,
        he.actionUpdate,
        he.statusNeedFile,
        he.statusInProgress,
        he.statusReturnedToYou,
        he.statusRejected,
        he.statusCompleted,
        he.statusCancelled,
        he.statusSendFailed,
      ]),
    );
  });

  it("adds a synthetic partner only when the roster is just me", () => {
    const me = {
      ...designPartnerMember("workspace-1", "דני"),
      id: ME,
    };
    const merged = mergeDesignMembers("workspace-1", ME, [me]);
    expect(merged).toHaveLength(2);
    expect(merged.some((member) => member.id !== ME)).toBe(true);
    expect(merged.find((member) => member.id !== ME)?.email).toBe("dana@drops.app");

    const withLive = mergeDesignMembers("workspace-1", ME, [
      me,
      { ...designPartnerMember("workspace-1"), id: PARTNER },
    ]);
    expect(withLive.map((member) => member.id)).toEqual([ME, PARTNER]);
  });

  it("includes a dummy card with every history icon", () => {
    const inbox = buildDesignInbox({
      workspaceId: "workspace-1",
      meId: ME,
      partnerId: PARTNER,
    });
    const showcase = inbox.handoffs.find((row) => row.id === DESIGN_HISTORY_ICONS_ID);
    expect(showcase).toBeTruthy();
    const lines = visibleHistory(showcase!, { requestedAction: "approval" });
    const icons = lines.map((line) => historyIcon(line.eventType));
    expect(new Set(icons).size).toBe(icons.length);
    expect(icons).toEqual([
      "arrowUpload",
      "open",
      "document",
      "arrowDownload",
      "checkmarkCircle",
      "checkmark",
      "attach",
      "mail",
      "dismissCircle",
      "arrowSync",
      "mailInboxCheckmark",
      "prohibited",
      "errorCircle",
    ]);
    expect(lines.some((line) => line.versionNumber != null)).toBe(false);
  });

  it("includes a dummy card for previewing every action", () => {
    const inbox = buildDesignInbox({
      workspaceId: "workspace-1",
      meId: ME,
      partnerId: PARTNER,
    });
    expect(inbox.handoffs.some((row) => row.id === DESIGN_ALL_ACTIONS_ID)).toBe(true);
  });
});
