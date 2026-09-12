import type { RankingPageResponse } from "../src/lib/history.ts";

export function rankingResponse(page: RankingPageResponse, facets: string | null) {
  if (facets !== null && facets !== "omit") throw new TypeError("facets must be omit when provided");
  if (facets === null) return page;
  const { languages: _languages, topics: _topics, ...result } = page;
  return { ...result, facets_omitted: true as const };
}
