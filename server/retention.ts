const DAY_MS = 86_400_000;

export type RetentionPolicy = {
  graceDays: number;
  growthDays: number;
  pushDays: number;
  repositoryLimit: number;
};

export type RepositoryRetentionCandidate = {
  fullName: string;
  firstSeenAt: string;
  latestCapturedAt: string;
  latestPushedAt: string | null;
  latestRank: number;
  latestStars: number;
  growthComparisonStars: number | null;
};

function requireTimestamp(value: string, field: string): number {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return timestamp;
}

function requirePositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive integer`);
  }
}

export function selectRetainedRepositoryNames(
  repositories: readonly RepositoryRetentionCandidate[],
  referenceAt: string,
  policy: RetentionPolicy,
): string[] {
  const referenceTimestamp = requireTimestamp(referenceAt, "Retention referenceAt");
  requirePositiveInteger(policy.graceDays, "Retention graceDays");
  requirePositiveInteger(policy.growthDays, "Retention growthDays");
  requirePositiveInteger(policy.pushDays, "Retention pushDays");
  requirePositiveInteger(policy.repositoryLimit, "Retention repositoryLimit");

  const seen = new Set<string>();
  const eligible = repositories.filter((repository) => {
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository.fullName)) {
      throw new TypeError(`Retention repository ${repository.fullName} must use owner/name format`);
    }
    const key = repository.fullName.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`Retention repositories contain duplicate ${repository.fullName}`);
    }
    seen.add(key);
    requirePositiveInteger(repository.latestRank, `Retention rank for ${repository.fullName}`);
    if (!Number.isInteger(repository.latestStars) || repository.latestStars < 0) {
      throw new RangeError(`Retention stars for ${repository.fullName} must be a non-negative integer`);
    }
    if (
      repository.growthComparisonStars !== null
      && (!Number.isInteger(repository.growthComparisonStars) || repository.growthComparisonStars < 0)
    ) {
      throw new RangeError(
        `Retention comparison stars for ${repository.fullName} must be a non-negative integer`,
      );
    }
    const firstSeenTimestamp = requireTimestamp(
      repository.firstSeenAt,
      `Retention firstSeenAt for ${repository.fullName}`,
    );
    const latestCapturedTimestamp = requireTimestamp(
      repository.latestCapturedAt,
      `Retention latestCapturedAt for ${repository.fullName}`,
    );
    const latestPushedTimestamp = repository.latestPushedAt === null
      ? null
      : requireTimestamp(
        repository.latestPushedAt,
        `Retention latestPushedAt for ${repository.fullName}`,
      );
    if (
      firstSeenTimestamp > latestCapturedTimestamp
      || latestCapturedTimestamp > referenceTimestamp
      || (latestPushedTimestamp !== null && latestPushedTimestamp > referenceTimestamp)
    ) {
      throw new RangeError(`Retention timestamps for ${repository.fullName} are inconsistent`);
    }
    const withinGrace = referenceTimestamp - firstSeenTimestamp <= policy.graceDays * DAY_MS;
    const recentlyPushed = latestPushedTimestamp !== null
      && referenceTimestamp - latestPushedTimestamp <= policy.pushDays * DAY_MS;
    const gainedStars = repository.growthComparisonStars !== null
      && repository.latestStars > repository.growthComparisonStars;
    return withinGrace || recentlyPushed || gainedStars;
  });

  return eligible
    .sort((left, right) =>
      left.latestRank - right.latestRank || left.fullName.localeCompare(right.fullName)
    )
    .slice(0, policy.repositoryLimit)
    .map((repository) => repository.fullName);
}
