import type { HandoffRecord, HandoffVersion } from "./types";

export function latestHandoffVersion(row: HandoffRecord): HandoffVersion | null {
  if (row.versions.length > 0) {
    return row.versions.reduce((latest, version) =>
      version.versionNumber > latest.versionNumber ? version : latest,
    );
  }
  if (row.returnStoragePath && row.returnFileSize && row.returnBlake3) {
    return {
      versionNumber: 2,
      storagePath: row.returnStoragePath,
      fileSize: row.returnFileSize,
      blake3: row.returnBlake3,
    };
  }
  if (row.storagePath && row.fileSize && row.blake3) {
    return {
      versionNumber: 1,
      storagePath: row.storagePath,
      fileSize: row.fileSize,
      blake3: row.blake3,
    };
  }
  return null;
}

export function versionLabel(versionNumber: number): string {
  return `v${versionNumber}`;
}
