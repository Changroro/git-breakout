import { describe, expect, it } from "vitest";
import {
  parseHistoryResponse,
  parseRankingPageResponse,
  parseRepositorySearchResponse,
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
    expect(() => parseHistoryResponse({
      schema_version: "1.0",
      snapshots: [{
        id: "snapshot",
        captured_at: "2026-08-27T01:17:00.000Z",
        source: "github_combined",
        repositories: [{
          full_name: "owner/repository",
          open_graph_image_url: "https://opengraph.githubassets.com/example/owner/repository",
        }],
      }],
    })).toThrow("observation_sources must be a non-empty array");
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

  it("parses one server-ranked page and its filter facets", () => {
    expect(parseRankingPageResponse({
      schema_version: "1.0",
      id: "snapshot",
      captured_at: "2026-08-27T01:17:00.000Z",
      source: "github_combined",
      repository_count: 2500,
      matching_count: 42,
      page: 2,
      page_size: 10,
      intelligence_available: true,
      track_record: {
        schema_version: "1.0",
        evidence_started_at: "2026-08-27T00:00:00.000Z",
        generated_at: "2026-08-27T01:17:00.000Z",
        verified_count: 0,
        median_lead_hours: null,
        conversion_7d: { converted: 0, eligible: 0, rate: null },
        conversion_14d: { converted: 0, eligible: 0, rate: null },
        period_hits: { daily: 0, weekly: 0, monthly: 0 },
        recent_hits: [],
      },
      languages: [{ value: "typescript", label: "TypeScript", count: 20 }],
      topics: [{ value: "ai", label: "ai", count: 12 }],
      repositories: [{
        full_name: "owner/repository",
        open_graph_image_url: "https://opengraph.githubassets.com/example/owner/repository",
        observation_sources: null,
        discovery_evidence: {
          outcome: "pending",
          first_observed_at: "2026-08-27T01:17:00.000Z",
          first_trending_daily_at: null,
          first_trending_daily_rank: null,
          lead_hours: null,
          sources: ["github_search_created"],
          coverage: "complete",
        },
      }],
    })).toMatchObject({ page: 2, matching_count: 42, repository_count: 2500 });
  });

  it("parses bounded repository search results", () => {
    expect(parseRepositorySearchResponse({
      schema_version: "1.0",
      total_count: 1,
      repositories: [{
        full_name: "owner/repository",
        open_graph_image_url: "https://opengraph.githubassets.com/example/owner/repository",
        observation_sources: null,
      }],
    }).total_count).toBe(1);
    expect(() => parseRepositorySearchResponse({
      schema_version: "1.0",
      total_count: 0,
      repositories: [{
        full_name: "owner/repository",
        open_graph_image_url: "https://opengraph.githubassets.com/example/owner/repository",
        observation_sources: null,
      }],
    })).toThrow("cannot exceed total_count");
  });
});
