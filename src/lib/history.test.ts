import { describe, expect, it } from "vitest";
import { parseHistoryResponse, resolveSnapshotId, type RankingSnapshot } from "./history";

const snapshots = [
  { id: "first", captured_at: "2026-08-24T00:00:00.000Z", source: "test", repositories: [] },
  { id: "latest", captured_at: "2026-08-25T00:00:00.000Z", source: "test", repositories: [] },
] satisfies RankingSnapshot[];

describe("history", () => {
  it("selects a requested snapshot when it exists", () => {
    expect(resolveSnapshotId("first", snapshots)).toBe("first");
  });

  it("selects the latest snapshot for an unknown request", () => {
    expect(resolveSnapshotId("missing", snapshots)).toBe("latest");
  });

  it("rejects malformed responses", () => {
    expect(() => parseHistoryResponse({ schema_version: "1.0", snapshots: [{ id: 1 }] })).toThrow(
      "History snapshot 0 is invalid",
    );
  });
});
