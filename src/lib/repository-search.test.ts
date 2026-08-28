import { describe, expect, it } from "vitest";
import {
  addReadRepository,
  parseReadRepositories,
  searchRepositories,
  serializeReadRepositories,
} from "./repository-search";

const repositories = [
  {
    full_name: "openai/codex",
    description: "Coding agent for the terminal",
    language: "Rust",
    topics: ["ai", "developer-tools"],
  },
  {
    full_name: "browser-use/browser-use",
    description: "Browser automation for AI agents",
    language: "Python",
    topics: ["automation", "agents"],
  },
  {
    full_name: "sample/no-description",
    description: null,
    language: null,
    topics: [],
  },
];

describe("repository search", () => {
  it("matches every normalized query term across repository metadata", () => {
    expect(searchRepositories(repositories, "PYTHON agents")).toEqual([
      repositories[1],
    ]);
    expect(searchRepositories(repositories, "developer tools")).toEqual([
      repositories[0],
    ]);
  });

  it("returns no results for an empty query", () => {
    expect(searchRepositories(repositories, "   ")).toEqual([]);
  });
});

describe("read repositories", () => {
  it("persists normalized unique repository names", () => {
    const names = addReadRepository(
      new Set(["openai/codex"]),
      "Browser-Use/Browser-Use",
    );

    expect(serializeReadRepositories(names)).toBe(
      '["browser-use/browser-use","openai/codex"]',
    );
    expect(parseReadRepositories(serializeReadRepositories(names))).toEqual(names);
  });

  it("treats a missing stored value as an empty read history", () => {
    expect(parseReadRepositories(null)).toEqual(new Set());
  });

  it("rejects malformed stored values and repository names", () => {
    expect(() => parseReadRepositories('{"name":"openai/codex"}')).toThrow(
      "JSON array",
    );
    expect(() => parseReadRepositories('["not-a-repository"]')).toThrow(
      "owner/name",
    );
    expect(() => addReadRepository(new Set(), "not-a-repository")).toThrow(
      "owner/name",
    );
  });
});
