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
  errors?: Array<{ message?: unknown }>;
};

const PERIODS: readonly TrendingPeriod[] = ["daily", "weekly", "monthly"];
const GRAPHQL_BATCH_SIZE = 20;
const REQUEST_TIMEOUT_MS = 15_000;

function emptyRanks(): OfficialRanks {
  return { daily: null, weekly: null, monthly: null };
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
  if (
    value.nameWithOwner.toLowerCase() !== requestedName.toLowerCase() ||
    URL.parse(value.url)?.protocol !== "https:" ||
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
  if (payload.errors !== undefined && payload.errors.length > 0) {
    const messages = payload.errors.map((error) => String(error.message)).join("; ");
    throw new Error(`GitHub GraphQL failed: ${messages}`);
  }
  if (payload.data === undefined) {
    throw new TypeError("GitHub GraphQL response is missing data");
  }

  return repositories.map((repository, index) => {
    const metadata = payload.data?.[`repository${index}`];
    if (metadata === null || metadata === undefined) {
      throw new Error(`GitHub repository ${repository.fullName} is unavailable`);
    }
    validateGraphqlRepository(metadata, repository.fullName);
    return {
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
    };
  });
}

export async function fetchGitHubTrendingRepositories(
  token: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<GitHubRepositorySnapshot[]> {
  if (token.trim() === "") {
    throw new TypeError("GITHUB_TOKEN is required");
  }
  const official = mergeOfficialRepositories(
    await Promise.all(PERIODS.map((period) => fetchTrendingPeriod(period, fetchImplementation))),
  );
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
  return metadata;
}
