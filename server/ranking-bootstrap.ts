import { resolveSnapshotId, type RankingBootstrap, type TimelineResponse, type RankingPageResponse } from "../src/lib/history.ts";
import { parseRankingView, parseGitHubTrendingPeriod, parseRepositoryFilters } from "../src/lib/repository-filters.ts";
import type { PublicHistoryApi } from "./public-history.ts";

type Source = {
  readTimeline(): TimelineResponse | Promise<TimelineResponse>;
  readRankingPage(query: Parameters<PublicHistoryApi["readRankingPage"]>[0]): RankingPageResponse | Promise<RankingPageResponse>;
};

export async function loadRankingBootstrap(source: Source, url: URL): Promise<RankingBootstrap> {
  const page = Number(url.searchParams.get("page") ?? "1");
  const pageSize = Number(url.searchParams.get("page_size") ?? "10");
  if (!Number.isInteger(page) || page < 1 || page > 1_000_000 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError("Invalid bootstrap page bounds");
  }
  const view = parseRankingView(url.search);
  const filters = parseRepositoryFilters(url.search);
  const timeline = await source.readTimeline();
  const snapshotId = resolveSnapshotId(url.searchParams.get("snapshot"), timeline.snapshots);
  const ranking = await source.readRankingPage({ snapshotId, page, pageSize, ...filters, view,
    period: view === "github" ? parseGitHubTrendingPeriod(url.search) : null });
  return { schema_version: "1.0", timeline, ranking };
}
