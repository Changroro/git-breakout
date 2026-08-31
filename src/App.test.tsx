import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DiscoveryEvidenceBadge,
  buildArchiveHref,
  formatCompactNumber,
  formatObservedLeadDuration,
  InitialLoadingState,
  rankingViewCopy,
  resolveAppPath,
  SiteNavigation,
  SiteFooter,
  TrackRecordSection,
} from "./App";
import type { DiscoveryEvidence, TrackRecord } from "./lib/discovery-track-record";

describe("ranking view guidance", () => {
  it("explains each ranking model in plain language", () => {
    expect(rankingViewCopy("momentum").description).toContain("Durable overall strength");
    expect(rankingViewCopy("breakout").description).toContain("Peer-relative acceleration");
    expect(rankingViewCopy("current").description).toContain("Absolute attention now");
  });

  it("formats compact values with locale-neutral English units", () => {
    expect(formatCompactNumber(950)).toBe("950");
    expect(formatCompactNumber(35_000)).toBe("35k");
    expect(formatCompactNumber(1_200_000)).toBe("1.2m");
    expect(() => formatCompactNumber(Number.NaN)).toThrow("must be finite");
  });
});

describe("application navigation", () => {
  it("uses bookmarkable paths for rankings, archive, and track record", () => {
    expect(resolveAppPath("/")).toBe("/");
    expect(resolveAppPath("/archive")).toBe("/archive");
    expect(resolveAppPath("/track-record")).toBe("/track-record");
    expect(() => resolveAppPath("/unknown")).toThrow("Unknown application path");
    expect(buildArchiveHref(2, " rust ")).toBe("?page=2&query=rust");
  });

  it("marks the current primary destination", () => {
    const markup = renderToStaticMarkup(
      <SiteNavigation currentPath="/archive" onNavigate={() => undefined} />,
    );

    expect(markup).toContain('aria-current="page" href="/archive"');
    expect(markup).toContain("Track Record");
  });
});

function emptyTrackRecord(): TrackRecord {
  return {
    schema_version: "1.0",
    evidence_started_at: "2026-08-28T00:00:00.000Z",
    generated_at: "2026-08-31T00:00:00.000Z",
    verified_count: 0,
    median_lead_hours: null,
    conversion_7d: { converted: 0, eligible: 0, rate: null },
    conversion_14d: { converted: 0, eligible: 0, rate: null },
    period_hits: { daily: 0, weekly: 0, monthly: 0 },
    recent_hits: [],
  };
}

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

describe("TrackRecordSection", () => {
  it("shows evidence collection instead of misleading zero rates", () => {
    const markup = renderToStaticMarkup(<TrackRecordSection trackRecord={emptyTrackRecord()} />);

    expect(markup).toContain("Track Record");
    expect(markup.match(/Collecting evidence/g)).toHaveLength(4);
    expect(markup).not.toContain("0%");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-controls="ranking-methodology-dialog"');
  });

  it("renders verified outcomes, recent repositories, and methodology details", () => {
    const record: TrackRecord = {
      ...emptyTrackRecord(),
      verified_count: 4,
      median_lead_hours: 30,
      conversion_7d: { converted: 2, eligible: 4, rate: 0.5 },
      conversion_14d: { converted: 3, eligible: 4, rate: 0.75 },
      period_hits: { daily: 4, weekly: 2, monthly: 1 },
      recent_hits: [{
        full_name: "owner/repository",
        first_observed_at: "2026-08-29T00:00:00.000Z",
        first_trending_at: "2026-08-30T06:00:00.000Z",
        first_trending_rank: 5,
        lead_hours: 30,
        sources: ["github_search_created"],
        coverage: "complete",
      }],
    };
    const markup = renderToStaticMarkup(<TrackRecordSection trackRecord={record} />);

    expect(markup).toContain("Observed 1.3d before Daily");
    expect(markup).toContain("Daily #5");
    expect(markup).toContain("log1p(value) × 55");
    expect(markup).toContain("Official Trending signal");
    expect(markup).toContain("24h → 6h → 1h");
    expect(markup).toContain("trend-intelligence-v3-shadow");
  });
});

describe("DiscoveryEvidenceBadge", () => {
  const pending: DiscoveryEvidence = {
    outcome: "pending",
    first_observed_at: "2026-08-31T00:00:00.000Z",
    first_trending_daily_at: null,
    first_trending_daily_rank: null,
    lead_hours: null,
    sources: ["github_search_created"],
    coverage: "complete",
  };

  it("renders badges only for verified early discoveries", () => {
    expect(renderToStaticMarkup(<DiscoveryEvidenceBadge evidence={pending} />)).toBe("");
    expect(renderToStaticMarkup(<DiscoveryEvidenceBadge evidence={{
      ...pending,
      outcome: "verified",
      first_trending_daily_at: "2026-08-31T18:00:00.000Z",
      first_trending_daily_rank: 9,
      lead_hours: 18.4,
      coverage: "complete",
    }} />)).toContain("Observed 18h before Daily");
  });

  it("formats observed intervals without false precision", () => {
    expect(formatObservedLeadDuration(0.4)).toBe("<1h");
    expect(formatObservedLeadDuration(18.4)).toBe("18h");
    expect(formatObservedLeadDuration(30)).toBe("1.3d");
    expect(() => formatObservedLeadDuration(-1)).toThrow("non-negative");
  });
});
