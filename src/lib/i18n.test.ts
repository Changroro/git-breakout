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

  it("uses natural Korean labels for ranking and discovery concepts", () => {
    expect(translate("ko", "ranking.currentHeat")).toBe("현재 관심도");
    expect(translate("ko", "repository.observedBeforeDaily", { lead: "6시간" })).toBe(
      "일간 트렌딩보다 6시간 먼저 관측",
    );
    expect(translate("ko", "archive.inactive")).toBe("최근 수집에서 제외됨");
  });
});
