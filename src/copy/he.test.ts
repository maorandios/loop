import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  HANDOFF_STATUSES,
  cloudErrorHint,
  cloudErrorLabel,
  handoffStatusLabel,
  he,
  type HandoffStatus,
} from "./he";
import { CLOUD_ERROR_CODES } from "../lib/supabase/errors";

const expectedHebrew: Record<HandoffStatus, string> = {
  uploading: "מתחיל שליחה…",
  sending: "שולח…",
  sent: "נשלח",
  received: "הקובץ התקבל",
  opened: "הקובץ נפתח",
  modified: "הקובץ נערך",
  returning: "מחזיר…",
  returned: "הוחזר",
  return_received: "הקובץ המעודכן התקבל",
  revision_requested: "הוחזר לתיקון",
  completed: "הושלם",
  failed: "נכשל",
};

describe("handoff status mapping", () => {
  it("maps every internal status to Hebrew", () => {
    for (const status of HANDOFF_STATUSES) {
      expect(handoffStatusLabel(status)).toBe(expectedHebrew[status]);
    }
  });

  it("never returns the internal English status name", () => {
    for (const status of HANDOFF_STATUSES) {
      const label = handoffStatusLabel(status);
      expect(label).not.toBe(status);
      expect(label).not.toMatch(
        /uploading|sending|sent|received|opened|modified|returning|returned|return_received|revision_requested|completed|failed/,
      );
    }
  });

  it("does not include transfer percentages", () => {
    const allCopy = JSON.stringify(he);
    expect(allCopy).not.toMatch(/\d+%/);
    expect(he.uploadingFile).toBe("מעלה את הקובץ…");
  });
});

describe("document language", () => {
  it("keeps the HTML shell in Hebrew RTL", () => {
    const html = readFileSync(path.join(process.cwd(), "index.html"), "utf8");
    expect(html).toContain('lang="he"');
    expect(html).toContain('dir="rtl"');
  });
});

describe("cloud error mapping", () => {
  it("maps every cloud error code to Hebrew without leaking the code", () => {
    for (const code of CLOUD_ERROR_CODES) {
      const label = cloudErrorLabel(code);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toBe(code);
      expect(label).not.toContain(code);
      const hint = cloudErrorHint(code);
      if (hint) {
        expect(hint).not.toContain(code);
      }
    }
    expect(cloudErrorHint("auth_store_corrupt")).toBe(he.authStoreCorruptHint);
    expect(cloudErrorLabel("auth_store_corrupt")).toBe(
      "לא ניתן לקרוא את פרטי החיבור השמורים של FileRelay",
    );
  });

  it("includes the Milestone 5 Hebrew states", () => {
    expect(he.cloudConnecting).toBe("מתחבר ל־FileRelay…");
    expect(he.cannotConnectNow).toBe("לא ניתן להתחבר כרגע");
    expect(he.workspaceHowToStart).toBe("איך תרצה להתחיל?");
    expect(he.createWorkspace).toBe("צור צוות חדש");
    expect(he.joinWorkspace).toBe("הצטרף לצוות");
    expect(he.workspaceReadyTitle).toBe("הצוות מוכן");
    expect(he.waitingForMembers).toBe("ממתין לחברים נוספים");
    expect(he.waitingForMe).toBe("אינבוקס");
    expect(he.noWaitingForMe).toBe("אין בקשות באינבוקס");
    expect(he.waitingForMe).not.toBe("לטיפולי");
    expect(JSON.stringify(he)).not.toMatch(/מחכה לי|מחכה לאחרים|לטיפולי/);
    expect(he.waitingForOthers).toBe("אאוטבוקס");
    expect(he.allRequests).toBe("הכול");
    expect(he.requestsTitle).toBe("בקשות");
    expect(he.requestDetails).toBe("פרטי בקשה");
    expect(he.done).toBe("סגורות");
    expect(he.partialRequestsFailed).toBe("חלק מהבקשות לא נטענו. נסה שוב.");
    expect(he.requestCompleted).toBe("הבקשה הושלמה");
    expect(he.requestCancelled).toBe("הבקשה בוטלה");
    expect(he.sendIncomplete).toBe("השליחה לא הושלמה");
    expect(`${he.resultWaitingYourReview}${he.resultWaitingTheirReview}${he.resultWaitingNamedReview}`).not.toMatch(
      /החזיר|החזירה|ביקש|ביקשה/,
    );
    expect(he.joiningWorkspace).toBe("מתחבר לצוות…");
    expect(he.thisComputer).toBe("זה המחשב הזה");
    expect(he.tryAgain).toBe("נסה שוב");
  });

  it("includes the Milestone 6 transfer copy", () => {
    expect(he.downloadAndOpen).toBe("הורד ופתח");
    expect(he.openFolder).toBe("פתח תיקייה");
    expect(he.sendFile).toBe("שליחת קובץ");
    expect(he.fileTooLarge).toBe("הקובץ גדול מדי");
    expect(he.sendFailed).toBe("השליחה נכשלה");
    expect(he.downloadFailed).toBe("ההורדה נכשלה");
    expect(he.hashMismatch).toBe("הקובץ שהתקבל אינו תואם");
    expect(he.newFileFrom).toBe("קובץ חדש מ{name}");
    expect(he.newFileFrom).not.toMatch(/token|url|path/i);
  });

  it("keeps Windows toast copy for a mandatory installer check", () => {
    const native = readFileSync(
      path.join(process.cwd(), "src-tauri/src/copy.rs"),
      "utf8",
    );
    const transfer = readFileSync(
      path.join(process.cwd(), "src-tauri/src/transfer.rs"),
      "utf8",
    );
    expect(he.newFileFrom).toBe("קובץ חדש מ{name}");
    expect(native).toContain("new_file_from_prefix");
    expect(native).toContain("קובץ חדש מ");
    expect(transfer).toContain("notify_new_file");
    expect(transfer).toContain("HE.new_file_from_prefix");
    expect(native).toContain("file_returned_suffix");
    expect(transfer).toContain("notify_file_returned");
  });

  it("includes the Milestone 7 return-loop copy", () => {
    expect(he.handoffStatus.received).toBe("הקובץ התקבל");
    expect(he.handoffStatus.opened).toBe("הקובץ נפתח");
    expect(he.handoffStatus.modified).toBe("הקובץ נערך");
    expect(he.handoffStatus.return_received).toBe("הקובץ המעודכן התקבל");
    expect(he.returnFileTo).toBe("החזר ל{name}");
    expect(he.fileReturnedBy).toBe("{name} החזירה את הקובץ");
    expect(he.syncingChanges).toBe("מסנכרן שינויים…");
    expect(he.watchFailed).toBe("לא ניתן לעקוב אחר שינויים בקובץ הזה");
    expect(he.fileBusy).toBe("לא ניתן לקרוא את הקובץ כרגע. סגור אותו ונסה שוב.");
    expect(he.fileChangedDuringReturn).toBe("הקובץ השתנה בזמן ההחזרה. נסה שוב.");
  });
});
