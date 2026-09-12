import { describe, expect, it, vi } from "vitest";
import {
  fetchGitHubRepositories,
  fetchGitHubTrendingRepositories,
  parseOfficialTrending,
  searchGitHubRepositoryNames,
} from "./github.ts";

function trendingHtml(repositories: readonly string[]): string {
  return repositories
    .map((repository) => `<article class="Box-row"><h2><a href="/${repository}">${repository}</a></h2></article>`)
    .join("");
}

function metadata(fullName: string) {
  return {
    id: `R_${fullName.toLowerCase()}`,
    isPrivate: false,
    nameWithOwner: fullName,
    url: `https://github.com/${fullName}`,
    openGraphImageUrl: `https://opengraph.githubassets.com/test/${fullName}`,
    description: `${fullName} description`,
    createdAt: "2025-01-01T00:00:00.000Z",
    pushedAt: "2026-08-25T00:00:00.000Z",
    stargazerCount: 100,
    forkCount: 10,
    watchers: { totalCount: 5 },
    issues: { totalCount: 2 },
    primaryLanguage: { name: "TypeScript" },
    repositoryTopics: { nodes: [{ topic: { name: "ai" } }] },
  };
}

describe("GitHub collection", () => {
  it("requires GitHub authentication", async () => {
    await expect(fetchGitHubTrendingRepositories(" ")).rejects.toThrow("GITHUB_TOKEN is required");
  });

  it("extracts only repository rows from official Trending HTML", () => {
    const html = `<a href="/settings">Settings</a>${trendingHtml(["alpha/one", "beta/two"])}`;

    expect(parseOfficialTrending(html, "daily")).toEqual([
      {
        fullName: "alpha/one",
        ranks: { daily: 1, weekly: null, monthly: null },
        observationSources: ["official_daily"],
      },
      {
        fullName: "beta/two",
        ranks: { daily: 2, weekly: null, monthly: null },
        observationSources: ["official_daily"],
      },
    ]);
  });

  it("fails when official Trending contains no repository rows", () => {
    expect(() => parseOfficialTrending("<main></main>", "weekly")).toThrow(
      "returned no repository rows",
    );
  });

  it("merges official ranks and fetches distinct Open Graph images", async () => {
    const periodRepositories = {
      daily: ["alpha/one", "beta/two"],
      weekly: ["beta/two", "gamma/three"],
      monthly: ["gamma/three", "alpha/one"],
    } as const;
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://github.com/trending")) {
        const period = new URL(url).searchParams.get("since");
        if (period !== "daily" && period !== "weekly" && period !== "monthly") {
          throw new Error(`Unexpected period ${String(period)}`);
        }
        return new Response(trendingHtml(periodRepositories[period]), { status: 200 });
      }
      if (url === "https://api.github.com/graphql") {
        const request = JSON.parse(String(init?.body)) as {
          variables: Record<string, string>;
        };
        const data: Record<string, ReturnType<typeof metadata>> = {};
        for (let index = 0; request.variables[`owner${index}`] !== undefined; index += 1) {
          const fullName = `${request.variables[`owner${index}`]}/${request.variables[`name${index}`]}`;
          data[`repository${index}`] = metadata(fullName);
        }
        return Response.json({ data });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const repositories = await fetchGitHubTrendingRepositories(
      "github-token",
      fetchMock as typeof fetch,
    );

    expect(repositories.map((repository) => repository.fullName)).toEqual([
      "alpha/one",
      "beta/two",
      "gamma/three",
    ]);
    expect(repositories.map((repository) => repository.openGraphImageUrl)).toEqual([
      "https://opengraph.githubassets.com/test/alpha/one",
      "https://opengraph.githubassets.com/test/beta/two",
      "https://opengraph.githubassets.com/test/gamma/three",
    ]);
    expect(repositories.map((repository) => repository.officialRanks)).toEqual([
      { daily: 1, weekly: null, monthly: 2 },
      { daily: 2, weekly: 1, monthly: null },
      { daily: null, weekly: 2, monthly: 1 },
    ]);
    expect(repositories.map((repository) => repository.observationSources)).toEqual([
      ["official_daily", "official_monthly"],
      ["official_daily", "official_weekly"],
      ["official_weekly", "official_monthly"],
    ]);
  });

  it("searches new and recently pushed repositories with pagination", async () => {
    const requests: URL[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url);
      const page = Number(url.searchParams.get("page"));
      const prefix = url.searchParams.get("q")?.startsWith("created:") ? "new" : "active";
      const count = page === 1 ? 100 : 1;
      return Response.json({
        incomplete_results: false, total_count: 101,
        items: Array.from({ length: count }, (_, index) => ({
          private: false, full_name: `${prefix}/repository-${(page - 1) * 100 + index + 1}`,
        })),
      });
    });

    const repositories = await searchGitHubRepositoryNames(
      "github-token",
      "2026-08-26T12:00:00.000Z",
      fetchMock as typeof fetch,
    );

    expect(repositories).toHaveLength(202);
    expect(repositories[0]).toEqual({
      fullName: "new/repository-1",
      observationSources: ["github_search_created"],
    });
    expect(repositories[101]).toEqual({
      fullName: "active/repository-1",
      observationSources: ["github_search_pushed"],
    });
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.searchParams.get("page"))).toEqual([
      "1",
      "2",
      "1",
      "2",
    ]);
    expect(requests[0].searchParams.get("q")).toBe(
      "created:>=2026-08-19T12:00:00.000Z is:public",
    );
    expect(requests[2].searchParams.get("q")).toBe(
      "pushed:>=2026-08-25T12:00:00.000Z is:public",
    );
    expect(requests.every((request) => request.searchParams.get("per_page") === "100")).toBe(true);
  });

  it("stops at the GitHub search page limit when one page has fewer items", async () => {
    const pages: number[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const page = Number(url.searchParams.get("page"));
      pages.push(page);
      if (page > 10) return Response.json({ message: "Only the first 1000 search results are available" }, { status: 422 });
      const prefix = url.searchParams.get("q")?.startsWith("created:") ? "new" : "active";
      return Response.json({ incomplete_results: false, total_count: 2000, items: Array.from({ length: page === 6 ? 99 : 100 }, (_, index) => ({ private: false, full_name: `${prefix}/repository-${page}-${index}` })) });
    });
    const result = await searchGitHubRepositoryNames("token", "2026-09-09T00:00:00Z", fetchMock as typeof fetch);
    expect(result).toHaveLength(1998);
    expect(Math.max(...pages)).toBe(10);
    expect(pages).toHaveLength(20);
  });

  it("merges official, search, retained, and GH Archive sources", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://github.com/trending")) {
        return new Response(trendingHtml(["alpha/one"]), { status: 200 });
      }
      if (url.startsWith("https://api.github.com/search/repositories")) {
        const query = new URL(url).searchParams.get("q");
        return Response.json({
          incomplete_results: false, total_count: 2,
          items: query?.startsWith("created:")
            ? [{ private: false, full_name: "beta/two" }, { private: false, full_name: "ALPHA/ONE" }]
            : [{ private: false, full_name: "gamma/three" }, { private: false, full_name: "beta/two" }],
        });
      }
      if (url === "https://api.github.com/graphql") {
        const request = JSON.parse(String(init?.body)) as {
          variables: Record<string, string>;
        };
        const data: Record<string, ReturnType<typeof metadata>> = {};
        for (let index = 0; request.variables[`owner${index}`] !== undefined; index += 1) {
          const fullName = `${request.variables[`owner${index}`]}/${request.variables[`name${index}`]}`;
          data[`repository${index}`] = metadata(fullName);
        }
        return Response.json({ data });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const repositories = await fetchGitHubRepositories({
      token: "github-token",
      capturedAt: "2026-08-26T12:00:00.000Z",
      retainedRepositoryNames: ["delta/four", "BETA/TWO"],
      ghArchiveRepositoryNames: ["gamma/three", "epsilon/five"],
      fetchImplementation: fetchMock as typeof fetch,
    });

    expect(repositories.map((repository) => repository.fullName)).toEqual([
      "alpha/one",
      "beta/two",
      "gamma/three",
      "delta/four",
      "epsilon/five",
    ]);
    expect(repositories[0].officialRanks).toEqual({ daily: 1, weekly: 1, monthly: 1 });
    expect(repositories.slice(1).every((repository) =>
      Object.values(repository.officialRanks).every((rank) => rank === null)
    )).toBe(true);
    expect(repositories.map((repository) => repository.observationSources)).toEqual([
      ["official_daily", "official_weekly", "official_monthly", "github_search_created"],
      ["github_search_created", "github_search_pushed", "retained"],
      ["github_search_pushed", "gh_archive"],
      ["retained"],
      ["gh_archive"],
    ]);
  });

  it("uses the canonical repository name returned after a rename", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://github.com/trending")) {
        return new Response(trendingHtml(["old-owner/old-name"]), { status: 200 });
      }
      if (url.startsWith("https://api.github.com/search/repositories")) {
        return Response.json({
          incomplete_results: false, total_count: 1,
          items: [{ private: false, full_name: "new-owner/new-name" }],
        });
      }
      if (url === "https://api.github.com/graphql") {
        const request = JSON.parse(String(init?.body)) as {
          variables: Record<string, string>;
        };
        const data: Record<string, ReturnType<typeof metadata>> = {};
        for (let index = 0; request.variables[`owner${index}`] !== undefined; index += 1) {
          data[`repository${index}`] = metadata("new-owner/new-name");
        }
        return Response.json({ data });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const repositories = await fetchGitHubRepositories({
      token: "github-token",
      capturedAt: "2026-08-26T12:00:00.000Z",
      retainedRepositoryNames: [],
      ghArchiveRepositoryNames: [],
      fetchImplementation: fetchMock as typeof fetch,
    });

    expect(repositories).toHaveLength(1);
    expect(repositories[0].fullName).toBe("new-owner/new-name");
    expect(repositories[0].repositoryId).toBe("R_new-owner/new-name");
    expect(repositories[0].requestedNames).toEqual(["old-owner/old-name", "new-owner/new-name"]);
    expect(repositories[0].officialRanks).toEqual({ daily: 1, weekly: 1, monthly: 1 });
    expect(repositories[0].observationSources).toEqual([
      "official_daily",
      "official_weekly",
      "official_monthly",
      "github_search_created",
      "github_search_pushed",
    ]);
  });

  it("excludes a repository that disappears after search", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://github.com/trending")) {
        return new Response(trendingHtml(["alpha/one"]), { status: 200 });
      }
      if (url.startsWith("https://api.github.com/search/repositories")) {
        return Response.json({
          incomplete_results: false, total_count: 1,
          items: [{ private: false, full_name: "gone/repository" }],
        });
      }
      if (url === "https://api.github.com/graphql") {
        const request = JSON.parse(String(init?.body)) as {
          variables: Record<string, string>;
        };
        const data: Record<string, ReturnType<typeof metadata> | null> = {};
        const errors: Array<{ type: string; path: string[]; message: string }> = [];
        for (let index = 0; request.variables[`owner${index}`] !== undefined; index += 1) {
          const fullName = `${request.variables[`owner${index}`]}/${request.variables[`name${index}`]}`;
          if (fullName === "gone/repository") {
            data[`repository${index}`] = null;
            errors.push({
              type: "NOT_FOUND",
              path: [`repository${index}`],
              message: "Could not resolve to a Repository with the name 'gone/repository'.",
            });
          } else {
            data[`repository${index}`] = metadata(fullName);
          }
        }
        return Response.json({ data, errors });
      }
      throw new Error(`Unexpected URL ${url}`);
    });

    const repositories = await fetchGitHubRepositories({
      token: "github-token",
      capturedAt: "2026-08-26T12:00:00.000Z",
      retainedRepositoryNames: [],
      ghArchiveRepositoryNames: [],
      fetchImplementation: fetchMock as typeof fetch,
    });

    expect(repositories.map((repository) => repository.fullName)).toEqual(["alpha/one"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("gone/repository"));
    stderr.mockRestore();
  });
});

it("fetches metadata with bounded concurrency while preserving candidate order", async () => {
  const names = Array.from({ length: 65 }, (_, index) => `owner/repo-${index}`);
  let active = 0, maximum = 0, batches = 0;
  const fetchImplementation: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://github.com/trending")) return new Response(trendingHtml([names[0]]));
    if (url.startsWith("https://api.github.com/search")) return Response.json({ incomplete_results: false, total_count: 0, items: [] });
    if (url !== "https://api.github.com/graphql") throw new Error(`Unexpected ${url}`);
    batches += 1; active += 1; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    const { variables } = JSON.parse(String(init?.body));
    const data: Record<string, ReturnType<typeof metadata>> = {};
    for (let index = 0; variables[`owner${index}`] !== undefined; index++) {
      data[`repository${index}`] = metadata(`${variables[`owner${index}`]}/${variables[`name${index}`]}`);
    }
    active -= 1;
    return Response.json({ data });
  };
  const result = await fetchGitHubRepositories({ token: "mock", capturedAt: "2026-09-09T00:00:00.000Z", retainedRepositoryNames: names, ghArchiveRepositoryNames: [], fetchImplementation });
  expect(result.map(repository => repository.fullName)).toEqual(names);
  expect(maximum).toBe(2);
  expect(batches).toBe(4);
});


describe("GitHub public source contracts", () => {
  it.each([{ items: [] }, { items: [{ full_name: "owner/partial", private: false }] }])("rejects incomplete Search results without retrying every candidate", async ({ items }) => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ total_count: items.length, incomplete_results: true, items }));
    await expect(searchGitHubRepositoryNames("token", "2026-09-11T00:00:00Z", fetchMock))
      .rejects.toThrow("GitHub Search returned incomplete results");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("accepts a complete empty Search result", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ total_count: 0, incomplete_results: false, items: [] }));
    await expect(searchGitHubRepositoryNames("token", "2026-09-11T00:00:00Z", fetchMock)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when Search completeness is unknown", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ total_count: 0, items: [] }));
    await expect(searchGitHubRepositoryNames("token", "2026-09-11T00:00:00Z", fetchMock)).rejects.toThrow("invalid response");
  });

  it("filters private Search rows without treating the filtered page as an early end", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const fetchMock = vi.fn<typeof fetch>(async input => {
        const page = Number(new URL(String(input)).searchParams.get("page"));
        return Response.json({ total_count: 101, incomplete_results: false, items: page === 1
          ? Array.from({ length: 100 }, (_, index) => ({ full_name: `owner/private-${index}`, private: true }))
          : [{ full_name: "owner/public", private: false }] });
      });
      const result = await searchGitHubRepositoryNames("token", "2026-09-11T00:00:00Z", fetchMock);
      expect(result.map(row => row.fullName)).toEqual(["owner/public"]);
      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Skipping non-public GitHub Search repository"));
    } finally { stderr.mockRestore(); }
  });

  it.each([undefined, null, "false"])("fails closed on unknown Search visibility %s", async visibility => {
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ total_count: 1, incomplete_results: false, items: [{ full_name: "owner/unknown", private: visibility }] }));
    await expect(searchGitHubRepositoryNames("token", "2026-09-11T00:00:00Z", fetchMock)).rejects.toThrow("visibility");
  });

  function metadataFetch(value: Record<string, unknown>): typeof fetch {
    return async (input, init) => {
      if (String(input).startsWith("https://github.com/trending")) return new Response(trendingHtml(["owner/repository"]));
      if (String(input).startsWith("https://api.github.com/search")) return Response.json({ total_count: 1, incomplete_results: false, items: [{ full_name: "owner/repository", private: false }] });
      const request = JSON.parse(String(init?.body));
      expect(request.query).toMatch(/\bisPrivate\b/);
      expect(request.query).toMatch(/\bid\b/);
      return Response.json({ data: { repository0: value } });
    };
  }

  it("excludes a repository made private after public Search discovery", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const result = await fetchGitHubRepositories({ token: "token", capturedAt: "2026-09-11T00:00:00Z", retainedRepositoryNames: [], ghArchiveRepositoryNames: [], fetchImplementation: metadataFetch({ ...metadata("owner/repository"), isPrivate: true }) });
      expect(result).toEqual([]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("Skipping non-public GitHub repository"));
    } finally { stderr.mockRestore(); }
  });

  it.each([undefined, null, "false"])("fails closed on unknown GraphQL visibility %s", async isPrivate => {
    await expect(fetchGitHubTrendingRepositories("token", metadataFetch({ ...metadata("owner/repository"), isPrivate }))).rejects.toThrow("visibility");
  });

  it.each([undefined, null, ""])("rejects missing immutable repository identity %s", async id => {
    await expect(fetchGitHubTrendingRepositories("token", metadataFetch({ ...metadata("owner/repository"), id }))).rejects.toThrow("metadata");
  });
});

describe("GitHub immutable identity", () => {
  function identityFetch(resolveMetadata: (requested: string) => ReturnType<typeof metadata>): typeof fetch {
    return async (input, init) => {
      const url = String(input);
      if (url.startsWith("https://github.com/trending")) return new Response(trendingHtml(["owner/old"]));
      if (url.startsWith("https://api.github.com/search")) return Response.json({ total_count: 0, incomplete_results: false, items: [] });
      const { variables } = JSON.parse(String(init?.body));
      const data: Record<string, ReturnType<typeof metadata>> = {};
      for (let index = 0; variables[`owner${index}`] !== undefined; index++) {
        const requested = `${variables[`owner${index}`]}/${variables[`name${index}`]}`;
        data[`repository${index}`] = resolveMetadata(requested);
      }
      return Response.json({ data });
    };
  }

  const fetchRepositories = (fetchImplementation: typeof fetch) => fetchGitHubRepositories({
    token: "token", capturedAt: "2026-09-11T00:00:00Z", retainedRepositoryNames: ["owner/new"], ghArchiveRepositoryNames: [], fetchImplementation,
  });

  it("rejects different immutable identities claiming one canonical name", async () => {
    await expect(fetchRepositories(identityFetch(requested => ({ ...metadata("owner/new"), id: `R_${requested}` }))))
      .rejects.toThrow("conflicting GitHub identities");
  });

  it("rejects one immutable identity claiming different canonical names in a run", async () => {
    await expect(fetchRepositories(identityFetch(requested => ({ ...metadata(requested), id: "R_same" }))))
      .rejects.toThrow("conflicting canonical names");
  });

  it("keeps a reused old name separate from the original repository at its new name", async () => {
    const result = await fetchRepositories(identityFetch(requested => ({ ...metadata(requested), id: requested === "owner/old" ? "R_replacement" : "R_original" })));
    expect(result.map(row => ({ name: row.fullName, id: row.repositoryId, requested: row.requestedNames }))).toEqual([
      { name: "owner/old", id: "R_replacement", requested: ["owner/old"] },
      { name: "owner/new", id: "R_original", requested: ["owner/new"] },
    ]);
  });
});
