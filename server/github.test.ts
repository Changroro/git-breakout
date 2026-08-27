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
      { fullName: "alpha/one", ranks: { daily: 1, weekly: null, monthly: null } },
      { fullName: "beta/two", ranks: { daily: 2, weekly: null, monthly: null } },
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
        total_count: 101,
        items: Array.from({ length: count }, (_, index) => ({
          full_name: `${prefix}/repository-${(page - 1) * 100 + index + 1}`,
        })),
      });
    });

    const names = await searchGitHubRepositoryNames(
      "github-token",
      "2026-08-26T12:00:00.000Z",
      fetchMock as typeof fetch,
    );

    expect(names).toHaveLength(202);
    expect(requests).toHaveLength(4);
    expect(requests.map((request) => request.searchParams.get("page"))).toEqual([
      "1",
      "2",
      "1",
      "2",
    ]);
    expect(requests[0].searchParams.get("q")).toBe(
      "created:>=2026-08-19T12:00:00.000Z",
    );
    expect(requests[2].searchParams.get("q")).toBe(
      "pushed:>=2026-08-25T12:00:00.000Z",
    );
    expect(requests.every((request) => request.searchParams.get("per_page") === "100")).toBe(true);
  });

  it("merges official, searched, and previously observed repositories", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://github.com/trending")) {
        return new Response(trendingHtml(["alpha/one"]), { status: 200 });
      }
      if (url.startsWith("https://api.github.com/search/repositories")) {
        const query = new URL(url).searchParams.get("q");
        return Response.json({
          total_count: 2,
          items: query?.startsWith("created:")
            ? [{ full_name: "beta/two" }, { full_name: "ALPHA/ONE" }]
            : [{ full_name: "gamma/three" }, { full_name: "beta/two" }],
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
      previouslyObservedNames: ["delta/four", "BETA/TWO"],
      fetchImplementation: fetchMock as typeof fetch,
    });

    expect(repositories.map((repository) => repository.fullName)).toEqual([
      "alpha/one",
      "beta/two",
      "gamma/three",
      "delta/four",
    ]);
    expect(repositories[0].officialRanks).toEqual({ daily: 1, weekly: 1, monthly: 1 });
    expect(repositories.slice(1).every((repository) =>
      Object.values(repository.officialRanks).every((rank) => rank === null)
    )).toBe(true);
  });

  it("uses the canonical repository name returned after a rename", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://github.com/trending")) {
        return new Response(trendingHtml(["old-owner/old-name"]), { status: 200 });
      }
      if (url.startsWith("https://api.github.com/search/repositories")) {
        return Response.json({
          total_count: 1,
          items: [{ full_name: "new-owner/new-name" }],
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
      previouslyObservedNames: [],
      fetchImplementation: fetchMock as typeof fetch,
    });

    expect(repositories).toHaveLength(1);
    expect(repositories[0].fullName).toBe("new-owner/new-name");
    expect(repositories[0].officialRanks).toEqual({ daily: 1, weekly: 1, monthly: 1 });
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
          total_count: 1,
          items: [{ full_name: "gone/repository" }],
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
      previouslyObservedNames: [],
      fetchImplementation: fetchMock as typeof fetch,
    });

    expect(repositories.map((repository) => repository.fullName)).toEqual(["alpha/one"]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("gone/repository"));
    stderr.mockRestore();
  });
});
