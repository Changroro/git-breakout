import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Oracle web image", () => {
  it("includes Vite public assets in the build stage", () => {
    const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");

    expect(dockerfile).toContain("COPY public ./public");
  });
});
