import { describe, expect, it } from "vitest";
import { BOOTSTRAP_REPOSITORY_NAMES } from "./bootstrap-repositories.ts";

describe("bootstrap repositories", () => {
  it("contains 28 unique owner/name repositories in alphabetical order", () => {
    expect(BOOTSTRAP_REPOSITORY_NAMES).toHaveLength(28);
    expect(new Set(BOOTSTRAP_REPOSITORY_NAMES.map((name) => name.toLowerCase())).size).toBe(28);
    BOOTSTRAP_REPOSITORY_NAMES.forEach((name) => {
      expect(name).toMatch(/^[^/\s]+\/[^/\s]+$/);
    });
    expect([...BOOTSTRAP_REPOSITORY_NAMES]).toEqual(
      [...BOOTSTRAP_REPOSITORY_NAMES].sort((left, right) =>
        left.localeCompare(right, "en", { sensitivity: "base" }),
      ),
    );
  });
});
