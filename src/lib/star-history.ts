type UnknownRecord = Record<string, unknown>;

export interface StarHistoryPercentiles {
  stars: number;
  new_stars: number;
  pushes: number;
  contributors: number;
  issues_closed: number;
  forks: number;
}

export interface StarHistoryWeeklyActivity {
  new_stars: number;
  pushes: number;
  issues_closed: number;
}

export interface StarHistoryRepository {
  name: string;
  owner: string;
  owner_type: string;
  stars_total: number;
  description: string | null;
  language: string | null;
  topics: string[];
  license: string | null;
  homepage: string | null;
  forks_count: number;
  contributors_count: number;
  open_issues_count: number;
  created_at: string;
  archived: boolean;
  size: number;
  weekly_percentiles: StarHistoryPercentiles;
  weekly_activity: StarHistoryWeeklyActivity;
  milestones: unknown[];
}

export type StarHistoryLookup =
  | {
      status: "available";
      checked_at: string;
      repo: StarHistoryRepository;
    }
  | {
      status: "unavailable";
      checked_at: string;
      repo: null;
    };

function requireRecord(value: unknown, field: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value as UnknownRecord;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null) {
    return null;
  }
  return requireString(value, field);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new RangeError(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function requirePercentile(value: unknown, field: string): number {
  const percentile = requireNonNegativeInteger(value, field);
  if (percentile > 100) {
    throw new RangeError(`${field} must not exceed 100`);
  }
  return percentile;
}

function parsePercentiles(value: unknown): StarHistoryPercentiles {
  const record = requireRecord(value, "repo.weekly_percentiles");
  return {
    stars: requirePercentile(record.stars, "repo.weekly_percentiles.stars"),
    new_stars: requirePercentile(record.new_stars, "repo.weekly_percentiles.new_stars"),
    pushes: requirePercentile(record.pushes, "repo.weekly_percentiles.pushes"),
    contributors: requirePercentile(
      record.contributors,
      "repo.weekly_percentiles.contributors",
    ),
    issues_closed: requirePercentile(
      record.issues_closed,
      "repo.weekly_percentiles.issues_closed",
    ),
    forks: requirePercentile(record.forks, "repo.weekly_percentiles.forks"),
  };
}

function parseWeeklyActivity(value: unknown): StarHistoryWeeklyActivity {
  const record = requireRecord(value, "repo.weekly_activity");
  return {
    new_stars: requireNonNegativeInteger(record.new_stars, "repo.weekly_activity.new_stars"),
    pushes: requireNonNegativeInteger(record.pushes, "repo.weekly_activity.pushes"),
    issues_closed: requireNonNegativeInteger(
      record.issues_closed,
      "repo.weekly_activity.issues_closed",
    ),
  };
}

export function parseStarHistoryRepository(value: unknown): StarHistoryRepository {
  const wrapper = requireRecord(value, "Star History response");
  const repo = requireRecord(wrapper.repo, "repo");
  const createdAt = requireString(repo.created_at, "repo.created_at");
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new TypeError("repo.created_at must be a valid ISO-8601 timestamp");
  }
  if (!Array.isArray(repo.topics) || repo.topics.some((topic) => typeof topic !== "string")) {
    throw new TypeError("repo.topics must be an array of strings");
  }
  if (!Array.isArray(repo.milestones)) {
    throw new TypeError("repo.milestones must be an array");
  }
  if (typeof repo.archived !== "boolean") {
    throw new TypeError("repo.archived must be a boolean");
  }

  return {
    name: requireString(repo.name, "repo.name"),
    owner: requireString(repo.owner, "repo.owner"),
    owner_type: requireString(repo.owner_type, "repo.owner_type"),
    stars_total: requireNonNegativeInteger(repo.stars_total, "repo.stars_total"),
    description: requireNullableString(repo.description, "repo.description"),
    language: requireNullableString(repo.language, "repo.language"),
    topics: [...repo.topics] as string[],
    license: requireNullableString(repo.license, "repo.license"),
    homepage: requireNullableString(repo.homepage, "repo.homepage"),
    forks_count: requireNonNegativeInteger(repo.forks_count, "repo.forks_count"),
    contributors_count: requireNonNegativeInteger(
      repo.contributors_count,
      "repo.contributors_count",
    ),
    open_issues_count: requireNonNegativeInteger(
      repo.open_issues_count,
      "repo.open_issues_count",
    ),
    created_at: createdAt,
    archived: repo.archived,
    size: requireNonNegativeInteger(repo.size, "repo.size"),
    weekly_percentiles: parsePercentiles(repo.weekly_percentiles),
    weekly_activity: parseWeeklyActivity(repo.weekly_activity),
    milestones: [...repo.milestones],
  };
}

export function parseStarHistoryLookup(value: unknown): StarHistoryLookup {
  const record = requireRecord(value, "Star History lookup");
  const checkedAt = requireString(record.checked_at, "checked_at");
  if (!Number.isFinite(Date.parse(checkedAt))) {
    throw new TypeError("checked_at must be a valid ISO-8601 timestamp");
  }
  if (record.status === "unavailable") {
    if (record.repo !== null) {
      throw new TypeError("Unavailable Star History lookup must have a null repo");
    }
    return { status: "unavailable", checked_at: checkedAt, repo: null };
  }
  if (record.status !== "available") {
    throw new TypeError("Star History lookup status is invalid");
  }
  return {
    status: "available",
    checked_at: checkedAt,
    repo: parseStarHistoryRepository({ repo: record.repo }),
  };
}
