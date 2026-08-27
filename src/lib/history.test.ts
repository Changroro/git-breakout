import { describe, expect, it } from "vitest";
import {
  parseHistoryResponse,
  parseTimelineResponse,
  resolveSnapshotId,
  type RankingSnapshot,
} from "./history";

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

  it("accepts timeline metadata without repository payloads", () => {
    expect(parseTimelineResponse({
      schema_version: "1.0",
      snapshots: [{
        id: "snapshot",
        captured_at: "2026-08-27T01:17:00.000Z",
        source: "github_combined",
        repository_count: 2500,
      }],
    }).snapshots[0].repository_count).toBe(2500);
  });

  it("requires a completed timeline snapshot", () => {
    expect(() => parseTimelineResponse({ schema_version: "1.0", snapshots: [] })).toThrow(
      "At least one completed snapshot is required",
    );
  });
});
