export type SearchableRepository = {
  full_name: string;
  description: string | null;
  language: string | null;
  topics: readonly string[];
};

const REPOSITORY_NAME_PATTERN = /^[^/\s]+\/[^/\s]+$/;

function normalizeRepositoryName(value: string): string {
  const normalized = value.toLocaleLowerCase("en-US");
  if (!REPOSITORY_NAME_PATTERN.test(normalized)) {
    throw new TypeError(`Repository ${value} must use owner/name format`);
  }
  return normalized;
}

export function searchRepositories<T extends SearchableRepository>(
  repositories: readonly T[],
  query: string,
): T[] {
  const terms = query
    .trim()
    .toLocaleLowerCase("en-US")
    .split(/\s+/)
    .filter((term) => term !== "");
  if (terms.length === 0) {
    return [];
  }

  return repositories.filter((repository) => {
    const searchableText = [
      repository.full_name,
      repository.description,
      repository.language,
      ...repository.topics,
    ]
      .filter((value): value is string => value !== null)
      .join(" ")
      .toLocaleLowerCase("en-US");
    return terms.every((term) => searchableText.includes(term));
  });
}

export function parseReadRepositories(value: string | null): Set<string> {
  if (value === null) {
    return new Set();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new TypeError("Read repositories must contain valid JSON", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError("Read repositories must be a JSON array");
  }

  const names = parsed.map((name) => {
    if (typeof name !== "string") {
      throw new TypeError("Read repositories must contain repository names");
    }
    return normalizeRepositoryName(name);
  });
  if (new Set(names).size !== names.length) {
    throw new TypeError("Read repositories must not contain duplicates");
  }
  return new Set(names);
}

export function serializeReadRepositories(names: ReadonlySet<string>): string {
  return JSON.stringify([...names].map(normalizeRepositoryName).sort());
}

export function addReadRepository(
  names: ReadonlySet<string>,
  fullName: string,
): Set<string> {
  return new Set([...names, normalizeRepositoryName(fullName)]);
}
