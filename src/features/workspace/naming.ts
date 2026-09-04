import { he } from "../../copy/he";

export function defaultWorkspaceName(displayName: string): string {
  return `${he.workspaceOfPrefix}${displayName.trim()}`;
}
