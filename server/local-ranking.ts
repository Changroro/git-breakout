import type {
  RankingPageResponse,
  RankingSnapshot,
  RepositorySearchResponse,
} from "../src/lib/history.ts";
import {
  buildRepositoryFilterOptions,
  filterRepositories,
  type RankingView,
  type RepositoryFilters,
} from "../src/lib/repository-filters.ts";
import { searchRepositories } from "../src/lib/repository-search.ts";
import { trendIntelligenceFor } from "../src/lib/trend-intelligence.ts";

const MAX_TOPIC_FACETS = 500;

function repositoriesForView(
  snapshot: RankingSnapshot,
  filters: RepositoryFilters,
  view: RankingView,
) {
  const filtered = filterRepositories(snapshot.repositories, filters);
  if (view === "momentum") {
    return filtered;
  }
  const scoreFor = view === "breakout"
    ? (repository: typeof filtered[number]) => trendIntelligenceFor(repository)?.breakout.score ?? null
    : (repository: typeof filtered[number]) => trendIntelligenceFor(repository)?.current_heat.score ?? null;
  return filtered
    .flatMap((repository) => {
      const score = scoreFor(repository);
      return score === null ? [] : [{ repository, score }];
    })
    .sort((left, right) => (
      right.score - left.score
      || left.repository.full_name.localeCompare(right.repository.full_name)
    ))
    .map(({ repository }) => repository);
}

function boundedTopics(
  topics: ReturnType<typeof buildRepositoryFilterOptions>["topics"],
  selectedTopic: string | null,
) {
  const bounded = topics.slice(0, MAX_TOPIC_FACETS);
  const normalizedTopic = selectedTopic?.trim().toLocaleLowerCase("en-US") ?? null;
  if (normalizedTopic === null || bounded.some((topic) => topic.value === normalizedTopic)) {
    return bounded;
  }
  const selected = topics.find((topic) => topic.value === normalizedTopic);
  return selected === undefined ? bounded : [...bounded, selected];
}

export function buildLocalRankingPage({
  snapshot,
  page,
  pageSize,
  filters,
  view,
}: {
  snapshot: RankingSnapshot;
  page: number;
  pageSize: number;
  filters: RepositoryFilters;
  view: RankingView;
}): RankingPageResponse {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError("Ranking page must be a positive integer");
  }
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new RangeError("Ranking page size must be between 1 and 100");
  }
  const candidates = repositoriesForView(snapshot, filters, view);
  const normalizedPage = Math.min(page, Math.max(1, Math.ceil(candidates.length / pageSize)));
  const facets = buildRepositoryFilterOptions(snapshot.repositories);
  const start = (normalizedPage - 1) * pageSize;
  return {
    schema_version: "1.0",
    id: snapshot.id,
    captured_at: snapshot.captured_at,
    source: snapshot.source,
    repository_count: snapshot.repositories.length,
    matching_count: candidates.length,
    page: normalizedPage,
    page_size: pageSize,
    intelligence_available: snapshot.repositories.some(
      (repository) => trendIntelligenceFor(repository) !== null,
    ),
    languages: facets.languages,
    topics: boundedTopics(facets.topics, filters.topic),
    repositories: candidates.slice(start, start + pageSize),
  };
}

export function buildLocalRepositorySearch(
  snapshot: RankingSnapshot,
  query: string,
  limit: number,
): RepositorySearchResponse {
  if (query.trim() === "" || query.length > 200) {
    throw new TypeError("Repository search query must contain 1 to 200 characters");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
    throw new RangeError("Repository search limit must be between 1 and 20");
  }
  const repositories = searchRepositories(snapshot.repositories, query);
  return {
    schema_version: "1.0",
    total_count: repositories.length,
    repositories: repositories.slice(0, limit),
  };
}
