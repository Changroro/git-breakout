import { describe, expect, it } from "vitest";
import {
  aggregateGhArchiveLines,
  formatGhArchiveUrl,
  selectEventCandidateBuckets,
} from "./gh-archive.ts";

const BUCKET_AT = "2026-08-28T10:00:00.000Z";

function event(type: string, actorId: number, repository = "owner/repository"): string {
  return JSON.stringify({
    type,
    actor: { id: actorId, login: `actor-${actorId}` },
    repo: { name: repository },
    payload: type === "WatchEvent" ? { action: "started" } : {},
  });
}

describe("GH Archive aggregation", () => {
  it("aggregates relevant event types and distinct actors per repository", () => {
    const buckets = aggregateGhArchiveLines([
      event("WatchEvent", 1),
      event("WatchEvent", 1),
      event("ForkEvent", 2),
      event("PullRequestEvent", 3),
      event("IssuesEvent", 4),
      event("IssueCommentEvent", 4),
      event("PushEvent", 5),
      event("ReleaseEvent", 6),
      event("DeleteEvent", 7),
    ], BUCKET_AT);

    expect(buckets).toEqual([{
      bucket_at: BUCKET_AT,
      full_name: "owner/repository",
      watches: 2,
      forks: 1,
      pull_requests: 1,
      issues: 1,
      issue_comments: 1,
      pushes: 1,
      releases: 1,
      actor_ids: [1, 2, 3, 4, 5, 6],
    }]);
  });

  it("selects candidates deterministically by actor breadth then event diversity", () => {
    const buckets = aggregateGhArchiveLines([
      event("WatchEvent", 1, "owner/alpha"),
      event("WatchEvent", 2, "owner/alpha"),
      event("WatchEvent", 3, "owner/beta"),
      event("ForkEvent", 4, "owner/beta"),
      event("PullRequestEvent", 5, "owner/gamma"),
    ], BUCKET_AT);

    expect(selectEventCandidateBuckets(buckets, 2).map((bucket) => bucket.full_name)).toEqual([
      "owner/beta",
      "owner/alpha",
    ]);
  });

  it("formats the documented GH Archive hourly URL without zero-padding the hour", () => {
    expect(formatGhArchiveUrl(BUCKET_AT)).toBe(
      "https://data.gharchive.org/2026-08-28-10.json.gz",
    );
    expect(formatGhArchiveUrl("2026-08-28T06:00:00.000Z")).toBe(
      "https://data.gharchive.org/2026-08-28-6.json.gz",
    );
  });

  it("rejects malformed relevant events", () => {
    expect(() => aggregateGhArchiveLines([
      JSON.stringify({ type: "WatchEvent", actor: {}, repo: { name: "owner/repository" } }),
    ], BUCKET_AT)).toThrow("actor.id");
  });

  it("requires a positive candidate limit", () => {
    expect(() => selectEventCandidateBuckets([], 0)).toThrow("positive integer");
  });
});
