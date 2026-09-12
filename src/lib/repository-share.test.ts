import { describe, expect, it } from "vitest";
import {
  buildRepositorySharePageUrl,
  repositoryShareText,
  threadsShareUrl,
} from "./repository-share";

const input = {
  fullName: "owner/repository",
  imageUrl: "https://opengraph.githubassets.com/hash/owner/repository",
  pageUrl: "https://gitbreakout.imbch.dev/?view=breakout&page=1",
  rank: 3,
  view: "breakout" as const,
};

describe("repository sharing", () => {
  it("builds a ranking URL whose metadata can use the GitHub repository card", () => {
    const url = new URL(buildRepositorySharePageUrl(input));

    expect(url.searchParams.get("share_repository")).toBe("owner/repository");
    expect(url.searchParams.get("share_image")).toBe(input.imageUrl);
    expect(url.searchParams.get("share_rank")).toBe("3");
    expect(url.searchParams.get("share_view")).toBe("breakout");
  });

  it("keeps Threads copy to the repository name and card-enabled link", () => {
    const sharePageUrl = buildRepositorySharePageUrl(input);
    expect(repositoryShareText(input)).toBe(`owner/repository\n\n${sharePageUrl}`);

    const url = new URL(threadsShareUrl(input));

    expect(url.origin).toBe("https://www.threads.net");
    expect(url.pathname).toBe("/intent/post");
    expect(url.searchParams.get("text")).toBe(`owner/repository\n\n${sharePageUrl}`);
  });

  it("rejects insecure public share URLs", () => {
    expect(() => repositoryShareText({ ...input, pageUrl: "http://example.com" }))
      .toThrow("must use HTTPS");
  });
});

it("shares legitimate GitHub avatar fallback cards without crashing Monthly", () => {
  expect(() => threadsShareUrl({ ...input, imageUrl: "https://avatars.githubusercontent.com/u/130314967?v=4" })).not.toThrow();
});

it("drops unrelated filters and fragments from a bounded canonical share link", () => {
  const url = new URL(buildRepositorySharePageUrl({
    ...input,
    pageUrl: `https://gitbreakout.imbch.dev/?snapshot=known&view=breakout&language=${"x".repeat(1000)}&share_repository=other/repo#${"y".repeat(1000)}`,
  }));
  expect(url.searchParams.get("snapshot")).toBe("known");
  expect(url.searchParams.has("language")).toBe(false);
  expect(url.hash).toBe("");
  expect(() => threadsShareUrl({ ...input, pageUrl: url.toString() })).not.toThrow();
});
