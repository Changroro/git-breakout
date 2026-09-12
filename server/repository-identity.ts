export type RepositoryIdentityProof = {
  repository_id: string;
  full_name: string;
  requested_names: string[];
};

export function repositoryIdentityProofs(repositories: readonly {
  repositoryId: string;
  fullName: string;
  requestedNames: readonly string[];
}[]): RepositoryIdentityProof[] {
  const ids = new Set<string>();
  const aliases = new Map<string, string>();
  return repositories.map(repository => {
    if (typeof repository.repositoryId !== "string" || repository.repositoryId.trim() === "") {
      throw new TypeError("Repository identity requires a nonempty GitHub ID");
    }
    if (ids.has(repository.repositoryId)) throw new Error("Identity proof contains a duplicate repository ID");
    ids.add(repository.repositoryId);
    if (repository.requestedNames.length === 0) throw new TypeError("Identity proof requires requested names");
    const names = [...new Set([...repository.requestedNames, repository.fullName].map(name => {
      if (!/^[^/\s]+\/[^/\s]+$/.test(name)) throw new TypeError("Identity alias must use owner/name format");
      const key = name.toLowerCase();
      const previous = aliases.get(key);
      if (previous !== undefined && previous !== repository.repositoryId) throw new Error("Identity alias has conflicting repository IDs");
      aliases.set(key, repository.repositoryId);
      return key;
    }))];
    return { repository_id: repository.repositoryId, full_name: repository.fullName, requested_names: names };
  });
}
