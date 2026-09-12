import { expect, it } from "vitest";
import { rankingResponse } from "./ranking-response.ts";
import { buildLocalRankingPage } from "./local-ranking.ts";
import { rankRepositories } from "../src/lib/ranking.ts";
import { sampleRepositories, SAMPLE_CAPTURED_AT } from "../src/data/repositories.ts";

it("omits only explicitly reusable facets without changing repository or evidence data", () => {
  const page = buildLocalRankingPage({
    snapshot: { id: "fixture", captured_at: SAMPLE_CAPTURED_AT, source: "fixture", repositories: rankRepositories(sampleRepositories, SAMPLE_CAPTURED_AT) },
    page: 1, pageSize: 10, filters: { language: null, topic: null }, view: "momentum", period: null,
  });
  page.topics = Array.from({ length: 500 }, (_, index) => ({ value: `topic-${index}`, label: `topic-${index}`, count: 10 }));
  const compact = rankingResponse(page, "omit");
  expect(compact).not.toHaveProperty("languages");
  expect(compact).not.toHaveProperty("topics");
  expect(compact).toMatchObject({ id: page.id, repositories: page.repositories, track_record: page.track_record, facets_omitted: true });
  expect(Buffer.byteLength(JSON.stringify(page)) - Buffer.byteLength(JSON.stringify(compact))).toBeGreaterThan(25000);
  expect(rankingResponse(page, null)).toBe(page);
  expect(() => rankingResponse(page, "anything")).toThrow("facets");
});
