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
