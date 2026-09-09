import { expect, it, vi } from "vitest";
import { loadRankingBootstrap } from "./ranking-bootstrap.ts";
import { sampleRepositories } from "../src/data/repositories.ts";
import { rankRepositories } from "../src/lib/ranking.ts";
import { buildLocalRankingPage } from "./local-ranking.ts";
import { parseRankingBootstrap } from "../src/lib/history.ts";

it("loads the selected page with timeline metadata in one response", async () => {
  const snapshot = { id: "new", captured_at: "2026-08-25T00:00:00.000Z", source: "fixture",
    repositories: rankRepositories(sampleRepositories, "2026-08-25T00:00:00.000Z") };
  const source = {
    readTimeline: vi.fn(() => ({ schema_version: "1.0" as const, snapshots: [{ id: snapshot.id, captured_at: snapshot.captured_at, source: snapshot.source, repository_count: snapshot.repositories.length }] })),
    readRankingPage: vi.fn((query) => buildLocalRankingPage({ snapshot, page: query.page, pageSize: query.pageSize, filters: { language: query.language, topic: query.topic }, view: query.view, period: query.period })),
  };
  const result = parseRankingBootstrap(await loadRankingBootstrap(source, new URL("http://test/api/bootstrap?view=github&period=weekly&page=2&page_size=3")));
  expect(result.ranking.id).toBe("new");
  expect(result.ranking.page).toBe(2);
  expect(result.ranking.repositories).toHaveLength(3);
  expect(source.readTimeline).toHaveBeenCalledOnce();
  expect(source.readRankingPage).toHaveBeenCalledOnce();
  expect(() => parseRankingBootstrap({ ...result, ranking: { ...result.ranking, id: "wrong" } })).toThrow();
  await expect(loadRankingBootstrap(source, new URL("http://test/api/bootstrap?page_size=0"))).rejects.toThrow("bounds");
});
