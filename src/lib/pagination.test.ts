import { describe, expect, it, vi } from "vitest";
import { getVisiblePages, navigateRankingHref, parsePage } from "./pagination";

describe("parsePage", () => {
  it("accepts a page inside the available range", () => {
    expect(parsePage("3", 5)).toBe(3);
  });

  it.each([null, "0", "6", "1.5", "abc"])("returns page one for %s", (value) => {
    expect(parsePage(value, 5)).toBe(1);
  });

  it("rejects an empty result set", () => {
    expect(() => parsePage("1", 0)).toThrow(RangeError);
  });
});

describe("getVisiblePages", () => {
  it("shows every page for a short result set", () => {
    expect(getVisiblePages(2, 4)).toEqual([1, 2, 3, 4]);
  });

  it("shows at most ten consecutive pages around the current page", () => {
    expect(getVisiblePages(9, 18)).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it("keeps the final window within the available pages", () => {
    expect(getVisiblePages(18, 18)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17, 18]);
  });
});

describe("navigateRankingHref", () => {
  it("updates browser history without assigning a new document location", () => {
    const pushState = vi.fn();
    const replaceState = vi.fn();

    navigateRankingHref({ pushState, replaceState }, "?page=2&snapshot=test", "push");

    expect(pushState).toHaveBeenCalledWith(null, "", "?page=2&snapshot=test");
    expect(replaceState).not.toHaveBeenCalled();
  });

  it("rejects navigation outside the current ranking path", () => {
    const history = { pushState: vi.fn(), replaceState: vi.fn() };

    expect(() => navigateRankingHref(history, "/other", "push")).toThrow(
      "Ranking navigation href must be a query string",
    );
  });
});
