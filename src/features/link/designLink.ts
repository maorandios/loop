import type { LinkPickedFile, LinkSharePolicy, LinkStage } from "./externalLinkForm";

export const DESIGN_LINK_POLICY_KEY = "filerelay.designLinkPolicy";
export const DESIGN_LINK_STAGE_KEY = "filerelay.designLinkStage";
export const DESIGN_LINK_URL = "https://drops.app/l/q3-report";

export const DESIGN_COMPUTER_FILE: LinkPickedFile = {
  name: "מצגת Q3.pptx",
  size: 2_450_112,
  source: "computer",
  provider: "sharepoint",
};

export const DESIGN_CLOUD_FILE: LinkPickedFile = {
  name: "תקציב 2026.xlsx",
  size: 843_776,
  source: "cloud",
  provider: "google",
};

export const DESIGN_DROPBOX_FILE: LinkPickedFile = {
  name: "סיכום פרויקט.pdf",
  size: 1_204_224,
  source: "cloud",
  provider: "dropbox",
};

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function designLinkPolicy(override?: LinkSharePolicy): LinkSharePolicy {
  if (override) {
    return override;
  }
  if (!import.meta.env.DEV || import.meta.env.MODE === "test") {
    return "anyone";
  }
  return readStorage(DESIGN_LINK_POLICY_KEY) === "identified" ? "identified" : "anyone";
}

export function designLinkStage(override?: LinkStage): LinkStage {
  if (override) {
    return override;
  }
  if (!import.meta.env.DEV || import.meta.env.MODE === "test") {
    return "form";
  }
  const stored = readStorage(DESIGN_LINK_STAGE_KEY);
  if (stored === "uploading" || stored === "success") {
    return stored;
  }
  return "form";
}
