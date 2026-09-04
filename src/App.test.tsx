import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DiscoveryEvidenceBadge,
  buildArchiveHref,
  formatCompactNumber,
  formatObservedLeadDuration,
  HeaderTrafficBadge,
  InitialLoadingState,
  LanguageSwitcher,
  RANKING_VIEW_ORDER,
  RankingViewHeading,
  rankingViewCopy,
  RepositoryThumbnailFallback,
  resolveRankingRenderSearch,
  resolveAppPath,
  shouldFallbackToMomentum,
  SiteNavigation,
  SiteFooter,
  TrackRecordSection,
} from "./App";
import type { DiscoveryEvidence, TrackRecord } from "./lib/discovery-track-record";
import { I18nProvider, translate } from "./lib/i18n";

describe("ranking view guidance", () => {
  it("orders the ranking views around discovery first", () => {
    expect(RANKING_VIEW_ORDER).toEqual(["breakout", "momentum", "current", "github"]);
  });

  it("explains each ranking model in plain language", () => {
    expect(rankingViewCopy("momentum").description).toContain("Durable overall strength");
    expect(rankingViewCopy("breakout").description).toContain("first observed below 10k stars");
    expect(rankingViewCopy("breakout").description).toContain("at least two hours");
    expect(rankingViewCopy("current").description).toContain("Absolute attention now");
    expect(rankingViewCopy("github").description).toContain("GitHub Trending rank");
  });

  it("formats compact values with locale-neutral English units", () => {
    expect(formatCompactNumber(950)).toBe("950");
    expect(formatCompactNumber(35_000)).toBe("35k");
    expect(formatCompactNumber(1_200_000)).toBe("1.2m");
    expect(() => formatCompactNumber(Number.NaN)).toThrow("must be finite");
  });

  it("keeps the methodology trigger in the heading without an empty description row", () => {
    const markup = renderToStaticMarkup(
      <RankingViewHeading
        buttonLabel="About Breakout signals"
        description="Breakout methodology"
        isMethodologyOpen={false}
        onOpenMethodology={() => undefined}
        title="Breakout signals"
      />,
    );

    expect(markup).toContain('<div class="board-title-heading"><h2>Breakout signals</h2><button');
    expect(markup).toContain('class="ranking-view-info-button"');
    expect(markup).toContain('id="ranking-view-description">Breakout methodology</p>');
    expect(markup).not.toContain('class="ranking-view-description"');
  });
});

describe("application navigation", () => {
  it("keeps the loaded ranking query while another view is loading", () => {
    expect(resolveRankingRenderSearch(
      "?page=1&snapshot=latest&view=github&period=daily",
      "?page=1&snapshot=latest",
      true,
    )).toBe("?page=1&snapshot=latest");
  });

  it("uses bookmarkable paths for rankings, archive, and track record", () => {
    expect(resolveAppPath("/")).toBe("/");
    expect(resolveAppPath("/archive")).toBe("/archive");
    expect(resolveAppPath("/track-record")).toBe("/track-record");
    expect(() => resolveAppPath("/unknown")).toThrow("Unknown application path");
    expect(buildArchiveHref(2, " rust ")).toBe("?page=2&query=rust");
  });

  it("falls back from an empty latest Breakout view only without filters", () => {
    expect(shouldFallbackToMomentum({
      isLatestSnapshot: true,
      view: "breakout",
      filters: { language: null, topic: null },
      matchingCount: 0,
    })).toBe(true);
    expect(shouldFallbackToMomentum({
      isLatestSnapshot: false,
      view: "breakout",
      filters: { language: null, topic: null },
      matchingCount: 0,
    })).toBe(false);
    expect(shouldFallbackToMomentum({
      isLatestSnapshot: true,
      view: "breakout",
      filters: { language: "rust", topic: null },
      matchingCount: 0,
    })).toBe(false);
  });

  it("marks the current primary destination", () => {
    const markup = renderToStaticMarkup(
      <SiteNavigation currentPath="/archive" onNavigate={() => undefined} />,
    );

    expect(markup).toContain('aria-current="page" href="/archive"');
    expect(markup).toContain("Track Record");
  });

  it("renders Korean navigation through the shared i18n provider", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="ko">
        <SiteNavigation currentPath="/archive" onNavigate={() => undefined} />
      </I18nProvider>,
    );

    expect(markup).toContain("랭킹");
    expect(markup).toContain("아카이브");
    expect(markup).toContain("발굴 성과");
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
  it("uses the spaced brand name and links to source, sponsor, owner, and email", () => {
    const markup = renderToStaticMarkup(<SiteFooter />);

    expect(translate("en", "ranking.title")).toBe("Git Breakout");
    expect(markup).toContain('href="https://github.com/Changroro/git-breakout"');
    expect(markup).toContain('aria-label="Git Breakout source code"');
    expect(markup).toContain('href="https://github.com/sponsors/Changroro"');
    expect(markup).toContain('href="https://github.com/Changroro"');
    expect(markup).toContain('href="mailto:chbae624@gmail.com"');
  });

  it("localizes the source link in Korean", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="ko">
        <SiteFooter />
      </I18nProvider>,
    );

    expect(markup).toContain('aria-label="Git Breakout 소스 코드"');
    expect(markup).toContain('aria-label="GitHub Sponsors에서 후원"');
    expect(markup).toContain(">소스 코드</a>");
  });
});

describe("minimal header controls", () => {
  it("renders compact localized visitor counts without exposing analytics details", () => {
    const english = renderToStaticMarkup(<HeaderTrafficBadge state={{ status: "ready", visits: 15 }} />);
    const korean = renderToStaticMarkup(
      <I18nProvider locale="ko">
        <HeaderTrafficBadge state={{ status: "ready", visits: 15 }} />
      </I18nProvider>,
    );

    expect(english).toContain('aria-label="15 visits today"');
    expect(korean).toContain('aria-label="오늘 방문 15회"');
    expect(english).toContain(">15</span>");
    expect(english).not.toContain("Cloudflare");
  });

  it("renders a GitHub mark instead of thumbnail failure copy", () => {
    const markup = renderToStaticMarkup(
      <RepositoryThumbnailFallback repositoryName="owner/repository" />,
    );

    expect(markup).toContain("octicon-mark-github");
    expect(markup).toContain('aria-label="owner/repository preview unavailable"');
    expect(markup).not.toContain(">Preview unavailable<");
  });

  it("renders the language control as a globe with two compact options", () => {
    const markup = renderToStaticMarkup(
      <LanguageSwitcher locale="ko" onChange={() => undefined} />,
    );

    expect(markup).toContain("language-globe");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain(">ko</button>");
    expect(markup).toContain("language-divider");
    expect(markup).toContain(">en</button>");
  });
});

describe("TrackRecordSection", () => {
  it("shows evidence collection instead of misleading zero rates", () => {
    const markup = renderToStaticMarkup(<TrackRecordSection trackRecord={emptyTrackRecord()} />);

    expect(markup).toContain("Track Record");
    expect(markup.match(/Collecting evidence/g)).toHaveLength(4);
    expect(markup).not.toContain("<strong>0%</strong>");
    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-controls="ranking-methodology-dialog"');
  });

  it("localizes evidence collection states in Korean", () => {
    const markup = renderToStaticMarkup(
      <I18nProvider locale="ko">
        <TrackRecordSection trackRecord={emptyTrackRecord()} />
      </I18nProvider>,
    );

    expect(markup).toContain("발굴 성과");
    expect(markup.match(/근거 수집 중/g)).toHaveLength(4);
    expect(markup).not.toContain("Collecting evidence");
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
    expect(markup).toContain("trend-intelligence-v5-shadow");
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
