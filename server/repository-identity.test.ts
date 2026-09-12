import { describe, expect, it } from "vitest";
import { repositoryIdentityProofs } from "./repository-identity.ts";

describe("repository identity proofs", () => {
  it("preserves GitHub-confirmed requested aliases and the immutable ID", () => {
    expect(repositoryIdentityProofs([{ repositoryId: "R_1", fullName: "new/project", requestedNames: ["old/project", "NEW/PROJECT"] }])).toEqual([
      { repository_id: "R_1", full_name: "new/project", requested_names: ["old/project", "new/project"] },
    ]);
  });

  it("does not let the same alias identify two repositories", () => {
    expect(() => repositoryIdentityProofs([
      { repositoryId: "R_1", fullName: "new/project", requestedNames: ["old/project"] },
      { repositoryId: "R_2", fullName: "old/project", requestedNames: ["old/project"] },
    ])).toThrow("conflicting repository IDs");
  });

  it("rejects missing IDs, duplicate IDs and empty alias proofs", () => {
    expect(() => repositoryIdentityProofs([{ repositoryId: "", fullName: "a/b", requestedNames: ["a/b"] }])).toThrow("ID");
    expect(() => repositoryIdentityProofs([{ repositoryId: "R_1", fullName: "a/b", requestedNames: [] }])).toThrow("requested");
    expect(() => repositoryIdentityProofs([
      { repositoryId: "R_1", fullName: "a/b", requestedNames: ["a/b"] },
      { repositoryId: "R_1", fullName: "c/d", requestedNames: ["c/d"] },
    ])).toThrow("duplicate repository ID");
  });
});
