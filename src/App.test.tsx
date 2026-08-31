import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  formatCompactNumber,
  InitialLoadingState,
  rankingViewCopy,
  SiteFooter,
} from "./App";

describe("ranking view guidance", () => {
  it("explains each ranking model in plain language", () => {
    expect(rankingViewCopy("momentum").description).toContain("Overall strength");
    expect(rankingViewCopy("breakout").description).toContain("Rising unusually fast");
    expect(rankingViewCopy("current").description).toContain("strongest attention right now");
  });

  it("formats compact values with locale-neutral English units", () => {
    expect(formatCompactNumber(950)).toBe("950");
    expect(formatCompactNumber(35_000)).toBe("35k");
    expect(formatCompactNumber(1_200_000)).toBe("1.2m");
    expect(() => formatCompactNumber(Number.NaN)).toThrow("must be finite");
  });
});

describe("InitialLoadingState", () => {
  it("renders the ranking shell without exposing an internal loading message", () => {
    const markup = renderToStaticMarkup(<InitialLoadingState />);

    expect(markup).toContain('aria-label="Loading repository rankings"');
    expect(markup).toContain("loading-skeleton-row");
    expect(markup).not.toContain("Loading ranking history");
  });
});

describe("SiteFooter", () => {
  it("links to the owner GitHub profile and email address", () => {
    const markup = renderToStaticMarkup(<SiteFooter />);

    expect(markup).toContain('href="https://github.com/Changroro"');
    expect(markup).toContain('href="mailto:chbae624@gmail.com"');
  });
});
