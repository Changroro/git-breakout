import type { RankingView } from "./repository-filters";

const THREADS_INTENT_URL = "https://www.threads.net/intent/post";
const THREADS_CHARACTER_LIMIT = 500;
const GITHUB_CARD_HOSTS = new Set([
  "opengraph.githubassets.com",
  "repository-images.githubusercontent.com",
]);

export type RepositoryShareInput = {
  fullName: string;
  imageUrl: string;
  pageUrl: string;
  rank: number;
  view: RankingView;
};

function requireShareInput(input: RepositoryShareInput): void {
  if (!/^[^/\s]+\/[^/\s]+$/.test(input.fullName)) {
    throw new TypeError("Repository share name must use owner/name format");
  }
  if (!Number.isInteger(input.rank) || input.rank < 1) {
    throw new RangeError("Share rank must be a positive integer");
  }
  const pageUrl = new URL(input.pageUrl);
  if (pageUrl.protocol !== "https:" && pageUrl.hostname !== "localhost") {
    throw new TypeError("Repository share URL must use HTTPS");
  }
  const imageUrl = new URL(input.imageUrl);
  if (imageUrl.protocol !== "https:" || !GITHUB_CARD_HOSTS.has(imageUrl.hostname)) {
    throw new TypeError("Repository share image must use a GitHub card host");
  }
}

export function buildRepositorySharePageUrl(input: RepositoryShareInput): string {
  requireShareInput(input);
  const url = new URL(input.pageUrl);
  url.searchParams.set("share_repository", input.fullName);
  url.searchParams.set("share_image", input.imageUrl);
  url.searchParams.set("share_rank", String(input.rank));
  url.searchParams.set("share_view", input.view);
  return url.toString();
}

export function repositoryShareText(input: RepositoryShareInput): string {
  const value = `${input.fullName}\n\n${buildRepositorySharePageUrl(input)}`;
  if ([...value].length > THREADS_CHARACTER_LIMIT) {
    throw new RangeError("Repository share text exceeds the Threads character limit");
  }
  return value;
}

export function threadsShareUrl(input: RepositoryShareInput): string {
  const url = new URL(THREADS_INTENT_URL);
  url.searchParams.set("text", repositoryShareText(input));
  return url.toString();
}
