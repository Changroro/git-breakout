export type RepositoryFilters = {
  language: string | null;
  topic: string | null;
};

export type RankingView = "momentum" | "breakout" | "current";

export type RepositoryFilterOption = {
  value: string;
  label: string;
  count: number;
};

type FilterableRepository = {
  language: string | null;
  topics: readonly string[];
};

function normalizeFilterValue(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLocaleLowerCase("en-US");
  return normalized === "" ? null : normalized;
}

function sortedOptions(
  counts: Map<string, { label: string; count: number }>,
): RepositoryFilterOption[] {
  return [...counts.entries()]
    .map(([value, option]) => ({ value, ...option }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

export function buildRepositoryFilterOptions(
  repositories: readonly FilterableRepository[],
): { languages: RepositoryFilterOption[]; topics: RepositoryFilterOption[] } {
  const languageCounts = new Map<string, { label: string; count: number }>();
  const topicCounts = new Map<string, { label: string; count: number }>();

  repositories.forEach((repository) => {
    const language = normalizeFilterValue(repository.language);
    if (language !== null && repository.language !== null) {
      const existing = languageCounts.get(language);
      languageCounts.set(language, {
        label: existing?.label ?? repository.language.trim(),
        count: (existing?.count ?? 0) + 1,
      });
    }

    const repositoryTopics = new Map<string, string>();
    repository.topics.forEach((topic) => {
      const normalized = normalizeFilterValue(topic);
      if (normalized !== null && !repositoryTopics.has(normalized)) {
        repositoryTopics.set(normalized, topic.trim());
      }
    });
    repositoryTopics.forEach((label, topic) => {
      const existing = topicCounts.get(topic);
      topicCounts.set(topic, {
        label: existing?.label ?? label,
        count: (existing?.count ?? 0) + 1,
      });
    });
  });

  return {
    languages: sortedOptions(languageCounts),
    topics: sortedOptions(topicCounts),
  };
}

export function filterRepositories<T extends FilterableRepository>(
  repositories: readonly T[],
  filters: RepositoryFilters,
): T[] {
  const language = normalizeFilterValue(filters.language);
  const topic = normalizeFilterValue(filters.topic);

  return repositories.filter((repository) => {
    const matchesLanguage = language === null
      || normalizeFilterValue(repository.language) === language;
    const matchesTopic = topic === null
      || repository.topics.some((repositoryTopic) => normalizeFilterValue(repositoryTopic) === topic);
    return matchesLanguage && matchesTopic;
  });
}

export function parseRepositoryFilters(search: string): RepositoryFilters {
  const parameters = new URLSearchParams(search);
  return {
    language: normalizeFilterValue(parameters.get("language")),
    topic: normalizeFilterValue(parameters.get("topic")),
  };
}

export function parseRankingView(search: string): RankingView {
  const value = new URLSearchParams(search).get("view");
  if (value === null || value === "momentum") return "momentum";
  if (value === "breakout" || value === "current") return value;
  throw new TypeError(`Unknown ranking view ${value}`);
}

export function buildRankingHref(
  page: number,
  snapshotId: string,
  filters: RepositoryFilters,
  view: RankingView = "momentum",
): string {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError("page must be a positive integer");
  }
  if (snapshotId.trim() === "") {
    throw new TypeError("snapshotId is required");
  }

  const parameters = new URLSearchParams({ page: String(page), snapshot: snapshotId });
  if (view !== "momentum") {
    parameters.set("view", view);
  }
  const language = normalizeFilterValue(filters.language);
  const topic = normalizeFilterValue(filters.topic);
  if (language !== null) {
    parameters.set("language", language);
  }
  if (topic !== null) {
    parameters.set("topic", topic);
  }
  return `?${parameters.toString()}`;
}
