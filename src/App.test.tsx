import { rankRepositories } from "./lib/ranking";
import { sampleRepositories, SAMPLE_CAPTURED_AT } from "./data/repositories";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DiscoveryEvidenceBadge,
  RepositoryShareAction,
  RankingPage,
  RepositoryScoreEvidence,
  ServiceFreshnessNotice,
  buildArchiveHref,
  formatCompactNumber,
  formatObservedLeadDuration,
  HeaderTrafficBadge,
  InitialLoadingState,
  LanguageSwitcher,
  RANKING_VIEW_ORDER,
  rankingRequestKey,
  parseRankingWithFacets,
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
import type { RankingPageResponse } from "./lib/history";

describe("ranking view guidance", () => {
  it("orders the ranking views around discovery first", () => {
    expect(RANKING_VIEW_ORDER).toEqual(["breakout", "resurgence", "momentum", "current", "github"]);
  });

  it("explains each ranking model in plain language", () => {
    expect(rankingViewCopy("momentum").description).toContain("Durable overall strength");
    expect(rankingViewCopy("breakout").description).toContain("GitHub retained-star acquisition baseline");
    expect(rankingViewCopy("resurgence").description).toContain("seven quiet days");
    expect(rankingViewCopy("breakout", "en", false).title).toBe("Earlier breakout");
    expect(rankingViewCopy("breakout", "ko", true).title).toBe("신규 발굴");
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
  it("reuses omitted facets only for the same known snapshot", () => {
    const page: RankingPageResponse = {
      schema_version: "1.0", id: "known", captured_at: SAMPLE_CAPTURED_AT, source: "fixture",
      repositories: [], repository_count: 3, matching_count: 0, page: 1, page_size: 10,
      intelligence_available: false, track_record: emptyTrackRecord(),
      languages: [{ value: "rust", label: "Rust", count: 3 }],
      topics: [{ value: "cli", label: "cli", count: 2 }],
    };
    const { languages: _languages, topics: _topics, ...rest } = page;
    const compact = { ...rest, facets_omitted: true };
    expect(parseRankingWithFacets(compact, page).languages).toEqual(page.languages);
    expect(parseRankingWithFacets(compact, page).topics).toEqual(page.topics);
    expect(() => parseRankingWithFacets(compact, null)).toThrow("same previously loaded snapshot");
    expect(() => parseRankingWithFacets({ ...compact, id: "other" }, page)).toThrow("same previously loaded snapshot");
  });

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

  it("falls back only for an empty legacy view, preserving new discovery and resurgence views", () => {
    expect(shouldFallbackToMomentum({ isLatestSnapshot: true, view: "breakout", filters: { language: null, topic: null }, matchingCount: 0, classificationAvailable: true })).toBe(false);
    expect(shouldFallbackToMomentum({ isLatestSnapshot: true, view: "resurgence", filters: { language: null, topic: null }, matchingCount: 0 })).toBe(false);
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
    expect(markup).toContain("trend-intelligence-v7-shadow");
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

it("recognizes the same loaded ranking despite URL ordering or sharing metadata", () => {
  expect(rankingRequestKey("snapshot", "")).toBe(rankingRequestKey("snapshot", "?snapshot=snapshot&page=1&share_rank=3"));
  expect(rankingRequestKey("snapshot", "?view=resurgence")).not.toBe(rankingRequestKey("snapshot", "?view=breakout"));
});

it("identifies the evaluation date of hindsight track-record results", () => {
  const markup = renderToStaticMarkup(<TrackRecordSection trackRecord={emptyTrackRecord()} />);
  expect(markup).toContain("Evaluated through");
  expect(markup).toMatch(/datetime="2026-08-31T00:00:00.000Z"/i);
});

it("labels Korean discovery lead as an interval between Radar observations", () => {
  expect(translate("ko", "repository.observedBeforeDailyTitle", { lead: "18시간" }))
    .toContain("트렌딩에서 처음 관측한 시점");
  expect(translate("ko", "repository.observedBeforeDailyTitle", { lead: "18시간" }))
    .not.toContain("오르기");
});

it("keeps the repository content rendered when only sharing is invalid", () => {
  const markup = renderToStaticMarkup(<article><h2>Monthly repository</h2><RepositoryShareAction input={{
    fullName: "owner/repo", imageUrl: "https://untrusted.example/card.png", pageUrl: "https://gitbreakout.imbch.dev/", rank: 1, view: "github",
  }} /></article>);
  expect(markup).toContain("Monthly repository");
  expect(markup).toContain("Sharing unavailable for this repository");
  expect(markup).toContain('disabled=""');
  expect(markup).not.toContain("untrusted.example");
});

it.each(["breakout", "resurgence", "current", "momentum", "github"] as const)("distinguishes filtered empty results in %s from unavailable evidence", (view) => {
  const snapshot = {
    id: "sample", captured_at: "2026-08-25T00:00:00.000Z", source: "sample", schema_version: "1.0" as const,
    repository_count: 30, matching_count: 0, page: 1, page_size: 10, intelligence_available: true, classification_available: true,
    track_record: emptyTrackRecord(), languages: [], topics: [], repositories: [],
  };
  const markup = renderToStaticMarkup(<RankingPage snapshots={[snapshot]} selectedId="sample" selectedSnapshot={snapshot}
    isSnapshotLoading={false} snapshotError={null} readRepositories={new Set()} onSelect={() => undefined} onRead={() => undefined}
    locationSearch={`?view=${view}&language=rust`} onNavigate={() => undefined} />);
  expect(markup).toContain("No repositories match these filters");
  expect(markup).not.toContain("Repositories remain unranked");
  expect(markup).toContain('role="group" aria-label="Ranking model"');
  expect(markup).not.toContain('role="tab"');
});

it("shows measured windows, baseline age, missing values and component denominator", () => {
  const repository = {
    ...rankRepositories(sampleRepositories.slice(0, 1), SAMPLE_CAPTURED_AT)[0],
    trend_intelligence: {
      score_version: "trend-intelligence-v8-shadow" as const, phase: "spark" as const, confidence: "low" as const,
      star_evidence_window_hours: 6 as const, event_evidence_window_hours: null,
      current_heat: { score: null, components }, breakout: { score: 80, components },
      cohort: { key: "new", size: 2 }, event_data_captured_at: null, missing_evidence: ["fresh_github_events", "star_history_baseline"], reasons: ["broad_actor_interest"],
      evidence: { current_heat_component_count: 2, discovery_component_count: 2, star_window_elapsed_hours: 6.5, history_fetched_at: "2026-08-01T00:00:00Z", baseline_started_at: "2026-07-01T00:00:00Z", baseline_ended_at: "2026-07-31T00:00:00Z", baseline_gap_hours: 696 },
    },
  };
  const markup = renderToStaticMarkup(<I18nProvider locale="ko"><RepositoryScoreEvidence repository={repository} view="breakout" /></I18nProvider>);
  expect(markup).toContain("6.5시간");
  expect(markup).toContain("696시간");
  expect(markup).toContain("2 / 6");
  expect(markup).toContain("최신 GitHub 이벤트");
  expect(markup).toContain("확인할 수 없음");
  expect(markup).not.toContain("fresh_github_events");
  expect(markup).toContain("유지 스타 이력 조회 시각");
});

const components = { star_velocity: 0.8, peer_relative_growth: 0.8, self_relative_growth: null, star_acceleration: null, actor_acceleration: null, organic_breadth: null, event_diversity: null, persistence: null };

it("keeps unknown service status distinct from a confirmed delay", () => {
  const markup = renderToStaticMarkup(<ServiceFreshnessNotice status={null} unavailable />);
  expect(markup).toContain("could not be checked");
  expect(markup).not.toContain("is delayed");
});

it("shows service delay independently of the selected ranking snapshot", () => {
  const markup = renderToStaticMarkup(<ServiceFreshnessNotice status={{ schema_version: "1.0", status: "degraded", latest_snapshot_at: "2026-09-11T00:00:00Z", snapshot_age_seconds: 86400, expected_interval_minutes: 120, next_due_at: "2026-09-11T02:00:00Z", last_failure: null, events: { latest_completed_hour: null, missing_hours: 2, source_complete: false } }} />);
  expect(markup).toContain("Latest collection is delayed");
  expect(markup).toContain("2 event hours missing");
});

it("shows subsequent verification dates without rewriting the historical observation", () => {
  const markup = renderToStaticMarkup(<DiscoveryEvidenceBadge evaluatedAt="2026-09-10T00:00:00Z" evidence={{
    outcome: "verified", first_observed_at: "2026-09-01T00:00:00Z", first_trending_daily_at: "2026-09-02T00:00:00Z",
    first_trending_daily_rank: 2, lead_hours: 24, sources: ["github_search_created"], coverage: "complete",
  }} />);
  expect(markup).toContain("First observed in Daily");
  expect(markup).toContain("2026-09-01T00:00:00Z");
  expect(markup).toContain("2026-09-02T00:00:00Z");
  expect(markup).toContain("2026-09-10T00:00:00Z");
});
