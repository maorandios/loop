import { describe, expect, it } from "vitest";
import { CloudError, cloudErrorCode, toCloudError } from "./errors";

describe("cloud errors", () => {
  it("maps stable service codes without exposing raw details", () => {
    expect(cloudErrorCode(new CloudError("invalid_join_code"))).toBe("invalid_join_code");
    expect(toCloudError({ message: "invalid_join_code" }).code).toBe("invalid_join_code");
    expect(toCloudError({ message: "Failed to fetch" }).code).toBe("cloud_unavailable");
    expect(toCloudError({ message: "auth_store_corrupt" }).code).toBe("auth_store_corrupt");
    expect(toCloudError({ details: "invalid_join_code", message: "P0001" }).code).toBe(
      "invalid_join_code",
    );
    expect(toCloudError({ message: "JWT expired", status: 401 }).code).toBe(
      "anonymous_auth_failed",
    );
    expect(toCloudError({ message: "upstream", status: 503 }).code).toBe("cloud_unavailable");
    expect(toCloudError({ message: "column join_code_hash does not exist" }).code).toBe(
      "unknown_cloud_error",
    );
    expect(toCloudError(new Error("invalid_join_code")).message).not.toMatch(/column|sql|jwt/i);
    expect(toCloudError({ message: "column join_code_hash does not exist" }).message).not.toMatch(
      /column|postgres|sql/i,
    );
    expect(toCloudError("file_too_large").code).toBe("file_too_large");
    expect(toCloudError({ message: "handoff_already_finalized" }).code).toBe(
      "handoff_already_finalized",
    );
  });
});
