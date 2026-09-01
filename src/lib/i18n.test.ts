import { describe, expect, it } from "vitest";
import { resolveInitialLocale, translate } from "./i18n";

describe("i18n", () => {
  it("prefers a saved locale and otherwise follows Korean browser preferences", () => {
    expect(resolveInitialLocale("en", ["ko-KR"])).toBe("en");
    expect(resolveInitialLocale(null, ["ko-KR", "en-US"])).toBe("ko");
    expect(resolveInitialLocale(null, ["en-US"])).toBe("en");
  });

  it("interpolates localized dynamic values", () => {
    expect(translate("ko", "ranking.filteredRepositories", {
      matching: 12,
      total: 30,
    })).toBe("전체 30개 중 12개");
    expect(translate("en", "archive.noResults", { query: "rust" })).toBe(
      "No results for “rust”",
    );
  });
});
