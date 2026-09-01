import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Oracle web image", () => {
  it("includes Vite public assets in the build stage", () => {
    const dockerfile = readFileSync(new URL("./Dockerfile", import.meta.url), "utf8");

    expect(dockerfile).toContain("COPY public ./public");
  });

  it("compiles the remote collector entrypoints", () => {
    const serverBuild = JSON.parse(
      readFileSync(new URL("../../tsconfig.server-build.json", import.meta.url), "utf8"),
    ) as { include: string[] };

    expect(serverBuild.include).toEqual(expect.arrayContaining([
      "server/collect-remote.ts",
      "server/collect-events-remote.ts",
      "server/read-collection-schedule.ts",
    ]));
  });
});
