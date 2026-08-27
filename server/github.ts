import { load } from "cheerio";
import type { OfficialRanks, RepositoryMetrics } from "../src/lib/ranking.ts";

export type TrendingPeriod = "daily" | "weekly" | "monthly";

export type OfficialRepository = {
  fullName: string;
  ranks: OfficialRanks;
};

export type GitHubRepositorySnapshot = {
  fullName: string;
  url: string;
  openGraphImageUrl: string;
  description: string | null;
  language: string | null;
  topics: string[];
  createdAt: string;
  pushedAt: string;
  metrics: RepositoryMetrics;
  officialRanks: OfficialRanks;
};

type GraphqlRepository = {
  nameWithOwner: string;
  url: string;
  openGraphImageUrl: string;
  description: string | null;
  createdAt: string;
  pushedAt: string;
  stargazerCount: number;
  forkCount: number;
  watchers: { totalCount: number };
  issues: { totalCount: number };
  primaryLanguage: { name: string } | null;
  repositoryTopics: { nodes: Array<{ topic: { name: string } }> };
};

type GraphqlResponse = {
  data?: Record<string, GraphqlRepository | null>;
  errors?: Array<{ type?: unknown; path?: unknown; message?: unknown }>;
};

type SearchResponse = {
  total_count?: unknown;
  items?: unknown;
};

const PERIODS: readonly TrendingPeriod[] = ["daily", "weekly", "monthly"];
const GRAPHQL_BATCH_SIZE = 20;
const SEARCH_PAGE_SIZE = 100;
const SEARCH_RESULT_LIMIT = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;

function emptyRanks(): OfficialRanks {
  return { daily: null, weekly: null, monthly: null };
}

function validateFullName(value: string): void {
  const segments = value.split("/");
  if (
    value.trim() !== value ||
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0)
  ) {
    throw new TypeError(`Repository ${value} must use owner/name format`);
  }
}

function requireResponseOk(response: Response, source: string): void {
  if (response.ok) {
    return;
  }
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const resetAt = resetHeader === null ? null : new Date(Number(resetHeader) * 1000);
  const resetMessage = resetAt !== null && Number.isFinite(resetAt.getTime())
    ? `; rate limit resets at ${resetAt.toISOString()}`
    : "";
  throw new Error(`${source} request failed with status ${response.status}${resetMessage}`);
}

export function parseOfficialTrending(html: string, period: TrendingPeriod): OfficialRepository[] {
  const document = load(html);
  const repositories: OfficialRepository[] = [];
  const seen = new Set<string>();

  document("article.Box-row h2 a").each((_, element) => {
    const href = document(element).attr("href");
    if (href === undefined) {
      throw new TypeError(`GitHub Trending ${period} contains a repository link without href`);
    }
    const segments = href.split("/").filter(Boolean);
    if (segments.length !== 2) {
      throw new TypeError(`GitHub Trending ${period} contains an invalid repository href: ${href}`);
    }
    const fullName = `${segments[0]}/${segments[1]}`;
    const key = fullName.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`GitHub Trending ${period} contains duplicate repository ${fullName}`);
    }
    seen.add(key);
    const ranks = emptyRanks();
    ranks[period] = repositories.length + 1;
    repositories.push({ fullName, ranks });
  });

  if (repositories.length === 0) {
    throw new Error(`GitHub Trending ${period} returned no repository rows`);
  }
  return repositories;
}

async function fetchTrendingPeriod(
  period: TrendingPeriod,
  fetchImplementation: typeof fetch,
): Promise<OfficialRepository[]> {
  const response = await fetchImplementation(`https://github.com/trending?since=${period}`, {
    headers: {
      Accept: "text/html",
      "User-Agent": "ai-trend-radar/0.0.0",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  requireResponseOk(response, `GitHub Trending ${period}`);
  return parseOfficialTrending(await response.text(), period);
}

function mergeOfficialRepositories(
  periodResults: readonly OfficialRepository[][],
): OfficialRepository[] {
  const merged = new Map<string, OfficialRepository>();
  periodResults.forEach((repositories) => {
    repositories.forEach((repository) => {
      const key = repository.fullName.toLowerCase();
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, {
          fullName: repository.fullName,
          ranks: { ...repository.ranks },
        });
        return;
      }
      PERIODS.forEach((period) => {
        const rank = repository.ranks[period];
        if (rank !== null) {
          existing.ranks[period] = rank;
        }
      });
    });
  });
  return [...merged.values()];
}

async function fetchOfficialRepositories(
  fetchImplementation: typeof fetch,
): Promise<OfficialRepository[]> {
  return mergeOfficialRepositories(
    await Promise.all(PERIODS.map((period) => fetchTrendingPeriod(period, fetchImplementation))),
  );
}

function parseSearchResponse(payload: SearchResponse, query: string): {
  totalCount: number;
  names: string[];
} {
  if (
    !Number.isInteger(payload.total_count) ||
    (payload.total_count as number) < 0 ||
    !Array.isArray(payload.items)
  ) {
    throw new TypeError(`GitHub Search returned an invalid response for ${query}`);
  }
  const names = payload.items.map((item) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("full_name" in item) ||
      typeof item.full_name !== "string"
    ) {
      throw new TypeError(`GitHub Search returned an invalid repository for ${query}`);
    }
    validateFullName(item.full_name);
    return item.full_name;
  });
  return { totalCount: payload.total_count as number, names };
}

async function searchRepositoryNames(
  query: string,
  token: string,
  fetchImplementation: typeof fetch,
): Promise<string[]> {
  const names: string[] = [];
  let page = 1;
  let expectedCount: number | null = null;

  while (names.length < (expectedCount ?? SEARCH_RESULT_LIMIT)) {
    const url = new URL("https://api.github.com/search/repositories");
    url.search = new URLSearchParams({
      q: query,
      sort: "stars",
      order: "desc",
      per_page: String(SEARCH_PAGE_SIZE),
      page: String(page),
    }).toString();
    const response = await fetchImplementation(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "ai-trend-radar/0.0.0",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    requireResponseOk(response, `GitHub Search ${query}`);
    const result = parseSearchResponse(await response.json() as SearchResponse, query);
    expectedCount ??= Math.min(result.totalCount, SEARCH_RESULT_LIMIT);
    if (result.names.length === 0 && names.length < expectedCount) {
      throw new Error(`GitHub Search pagination ended early for ${query}`);
    }
    names.push(...result.names.slice(0, expectedCount - names.length));
    page += 1;
  }

  return names;
}

export async function searchGitHubRepositoryNames(
  token: string,
  capturedAt: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<string[]> {
  if (token.trim() === "") {
    throw new TypeError("GITHUB_TOKEN is required");
  }
  const capturedTimestamp = Date.parse(capturedAt);
  if (!Number.isFinite(capturedTimestamp)) {
    throw new TypeError("capturedAt must be a valid ISO-8601 timestamp");
  }
  const createdAfter = new Date(capturedTimestamp - 7 * 86_400_000).toISOString();
  const pushedAfter = new Date(capturedTimestamp - 86_400_000).toISOString();
  const names = [
    ...await searchRepositoryNames(`created:>=${createdAfter}`, token, fetchImplementation),
    ...await searchRepositoryNames(`pushed:>=${pushedAfter}`, token, fetchImplementation),
  ];
  const seen = new Set<string>();
  return names.filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function mergeRepositoryCandidates(
  official: readonly OfficialRepository[],
  searchedNames: readonly string[],
  previouslyObservedNames: readonly string[],
): OfficialRepository[] {
  const merged = new Map<string, OfficialRepository>();
  official.forEach((repository) => {
    merged.set(repository.fullName.toLowerCase(), {
      fullName: repository.fullName,
      ranks: { ...repository.ranks },
    });
  });
  [...searchedNames, ...previouslyObservedNames].forEach((fullName) => {
    validateFullName(fullName);
    const key = fullName.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, { fullName, ranks: emptyRanks() });
    }
  });
  return [...merged.values()];
}

function createMetadataQuery(repositories: readonly OfficialRepository[]): {
  query: string;
  variables: Record<string, string>;
} {
  const definitions: string[] = [];
  const selections: string[] = [];
  const variables: Record<string, string> = {};

  repositories.forEach((repository, index) => {
    const [owner, name] = repository.fullName.split("/", 2);
    if (owner === undefined || name === undefined) {
      throw new TypeError(`Repository ${repository.fullName} must use owner/name format`);
    }
    definitions.push(`$owner${index}: String!`, `$name${index}: String!`);
    variables[`owner${index}`] = owner;
    variables[`name${index}`] = name;
    selections.push(`
      repository${index}: repository(owner: $owner${index}, name: $name${index}) {
        nameWithOwner
        url
        openGraphImageUrl
        description
        createdAt
        pushedAt
        stargazerCount
        forkCount
        watchers { totalCount }
        issues(states: OPEN) { totalCount }
        primaryLanguage { name }
        repositoryTopics(first: 20) { nodes { topic { name } } }
      }
    `);
  });

  return {
    query: `query TrendingMetadata(${definitions.join(", ")}) {${selections.join("\n")}}`,
    variables,
  };
}

function validateGraphqlRepository(value: GraphqlRepository, requestedName: string): void {
  const repositoryUrl = URL.parse(value.url);
  let canonicalNameIsValid = true;
  try {
    validateFullName(value.nameWithOwner);
  } catch {
    canonicalNameIsValid = false;
  }
  if (
    !canonicalNameIsValid ||
    repositoryUrl?.protocol !== "https:" ||
    repositoryUrl.pathname.toLowerCase() !== `/${value.nameWithOwner.toLowerCase()}` ||
    URL.parse(value.openGraphImageUrl)?.protocol !== "https:" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Number.isFinite(Date.parse(value.pushedAt)) ||
    !Number.isInteger(value.stargazerCount) ||
    !Number.isInteger(value.forkCount) ||
    !Number.isInteger(value.watchers.totalCount) ||
    !Number.isInteger(value.issues.totalCount)
  ) {
    throw new TypeError(`GitHub GraphQL returned invalid metadata for ${requestedName}`);
  }
}

function mergeCanonicalMetadata(
  repositories: readonly GitHubRepositorySnapshot[],
): GitHubRepositorySnapshot[] {
  const merged = new Map<string, GitHubRepositorySnapshot>();
  repositories.forEach((repository) => {
    const key = repository.fullName.toLowerCase();
    const existing = merged.get(key);
    if (existing === undefined) {
      merged.set(key, { ...repository, officialRanks: { ...repository.officialRanks } });
      return;
    }
    PERIODS.forEach((period) => {
      const existingRank = existing.officialRanks[period];
      const incomingRank = repository.officialRanks[period];
      if (existingRank !== null && incomingRank !== null && existingRank !== incomingRank) {
        throw new Error(`Canonical repository ${repository.fullName} has conflicting ${period} ranks`);
      }
      if (incomingRank !== null) {
        existing.officialRanks[period] = incomingRank;
      }
    });
  });
  return [...merged.values()];
}

async function fetchMetadataBatch(
  repositories: readonly OfficialRepository[],
  token: string,
  fetchImplementation: typeof fetch,
): Promise<GitHubRepositorySnapshot[]> {
  const request = createMetadataQuery(repositories);
  const response = await fetchImplementation("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "ai-trend-radar/0.0.0",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  requireResponseOk(response, "GitHub GraphQL");
  const payload = await response.json() as GraphqlResponse;
  if (payload.data === undefined) {
    throw new TypeError("GitHub GraphQL response is missing data");
  }
  const unavailableIndexes = new Set<number>();
  const fatalErrors: string[] = [];
  payload.errors?.forEach((error) => {
    const path = Array.isArray(error.path) ? error.path : [];
    const match = path.length === 1 && typeof path[0] === "string"
      ? /^repository(\d+)$/.exec(path[0])
      : null;
    const index = match === null ? Number.NaN : Number(match[1]);
    const repository = repositories[index];
    const message = typeof error.message === "string" ? error.message : String(error.message);
    if (
      error.type === "NOT_FOUND" &&
      repository !== undefined &&
      payload.data?.[`repository${index}`] === null &&
      message === `Could not resolve to a Repository with the name '${repository.fullName}'.`
    ) {
      unavailableIndexes.add(index);
      process.stderr.write(`Skipping unavailable GitHub repository ${repository.fullName}: ${message}\n`);
      return;
    }
    fatalErrors.push(message);
  });
  if (fatalErrors.length > 0) {
    throw new Error(`GitHub GraphQL failed: ${fatalErrors.join("; ")}`);
  }

  return repositories.flatMap((repository, index) => {
    if (unavailableIndexes.has(index)) {
      return [];
    }
    const metadata = payload.data?.[`repository${index}`];
    if (metadata === null || metadata === undefined) {
      throw new Error(`GitHub repository ${repository.fullName} is unavailable`);
    }
    validateGraphqlRepository(metadata, repository.fullName);
    return [{
      fullName: metadata.nameWithOwner,
      url: metadata.url,
      openGraphImageUrl: metadata.openGraphImageUrl,
      description: metadata.description,
      language: metadata.primaryLanguage?.name ?? null,
      topics: metadata.repositoryTopics.nodes.map(({ topic }) => topic.name),
      createdAt: metadata.createdAt,
      pushedAt: metadata.pushedAt,
      metrics: {
        stars: metadata.stargazerCount,
        forks: metadata.forkCount,
        watchers: metadata.watchers.totalCount,
        open_issues: metadata.issues.totalCount,
      },
      officialRanks: { ...repository.ranks },
    }];
  });
}

export async function fetchGitHubTrendingRepositories(
  token: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<GitHubRepositorySnapshot[]> {
  if (token.trim() === "") {
    throw new TypeError("GITHUB_TOKEN is required");
  }
  const official = await fetchOfficialRepositories(fetchImplementation);
  const metadata: GitHubRepositorySnapshot[] = [];
  for (let start = 0; start < official.length; start += GRAPHQL_BATCH_SIZE) {
    metadata.push(
      ...await fetchMetadataBatch(
        official.slice(start, start + GRAPHQL_BATCH_SIZE),
        token,
        fetchImplementation,
      ),
    );
  }
  return mergeCanonicalMetadata(metadata);
}

export async function fetchGitHubRepositories({
  token,
  capturedAt,
  previouslyObservedNames,
  fetchImplementation = fetch,
}: {
  token: string;
  capturedAt: string;
  previouslyObservedNames: readonly string[];
  fetchImplementation?: typeof fetch;
}): Promise<GitHubRepositorySnapshot[]> {
  if (token.trim() === "") {
    throw new TypeError("GITHUB_TOKEN is required");
  }
  if (!Number.isFinite(Date.parse(capturedAt))) {
    throw new TypeError("capturedAt must be a valid ISO-8601 timestamp");
  }
  const official = await fetchOfficialRepositories(fetchImplementation);
  const searchedNames = await searchGitHubRepositoryNames(token, capturedAt, fetchImplementation);
  const candidates = mergeRepositoryCandidates(official, searchedNames, previouslyObservedNames);
  const metadata: GitHubRepositorySnapshot[] = [];
  for (let start = 0; start < candidates.length; start += GRAPHQL_BATCH_SIZE) {
    metadata.push(
      ...await fetchMetadataBatch(
        candidates.slice(start, start + GRAPHQL_BATCH_SIZE),
        token,
        fetchImplementation,
      ),
    );
  }
  return mergeCanonicalMetadata(metadata);
}
