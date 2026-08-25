import { describe, expect, it, vi } from "vitest";
import { fetchGitHubTrendingRepositories, parseOfficialTrending } from "./github.ts";

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
});
