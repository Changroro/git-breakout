import { describe, expect, it } from "vitest";
import { parseArchivePageResponse } from "./archive";

const repository = {
  full_name: "owner/repository",
  open_graph_image_url: "https://opengraph.githubassets.com/example/owner/repository",
  observation_sources: null,
  rank: 7,
  last_snapshot_id: "11111111-1111-4111-8111-111111111111",
  last_observed_at: "2026-08-30T00:00:00.000Z",
};

function response() {
  return {
    schema_version: "1.0",
    latest_snapshot_id: "22222222-2222-4222-8222-222222222222",
    latest_captured_at: "2026-08-31T00:00:00.000Z",
    archive_count: 12,
    matching_count: 1,
    page: 1,
    page_size: 10,
    repositories: [repository],
  };
}

describe("parseArchivePageResponse", () => {
  it("parses last-known repositories and archive metadata", () => {
    expect(parseArchivePageResponse(response())).toMatchObject({
      archive_count: 12,
      matching_count: 1,
      repositories: [{
        full_name: "owner/repository",
        rank: 7,
        last_snapshot_id: repository.last_snapshot_id,
        last_observed_at: repository.last_observed_at,
      }],
    });
  });

  it("rejects inconsistent counts and invalid last-observed metadata", () => {
    expect(() => parseArchivePageResponse({
      ...response(),
      matching_count: 13,
    })).toThrow("matching_count cannot exceed archive_count");
    expect(() => parseArchivePageResponse({
      ...response(),
      repositories: [{ ...repository, last_observed_at: "invalid" }],
    })).toThrow("last_observed_at");
  });
});
