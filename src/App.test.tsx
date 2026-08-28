import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InitialLoadingState, SiteFooter } from "./App";

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
