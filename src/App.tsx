import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type MouseEvent,
} from "react";
import * as Slider from "@radix-ui/react-slider";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  FilterIcon,
  GraphIcon,
  HistoryIcon,
  MarkGithubIcon,
  MailIcon,
  MoonIcon,
  PeopleIcon,
  RepoIcon,
  SearchIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  StarIcon,
  SunIcon,
  TelescopeIcon,
  QuestionIcon,
  XIcon,
} from "@primer/octicons-react";
import {
  parseRankingPageResponse,
  parseRepositorySearchResponse,
  parseTimelineResponse,
  resolveSnapshotId,
  type RankingPageResponse,
  type RankingPageRepository,
  type RankingSnapshotMetadata,
  type RepositorySearchResponse,
} from "./lib/history";
import {
  getVisiblePages,
  navigateRankingHref,
  type RankingNavigationMode,
} from "./lib/pagination";
import {
  buildRankingHref,
  GITHUB_TRENDING_PERIODS,
  parseGitHubTrendingPeriod,
  parseRankingView,
  parseRepositoryFilters,
  type GitHubTrendingPeriod,
  type RankingView,
  type RepositoryFilterOption,
  type RepositoryFilters,
} from "./lib/repository-filters";
import type { RankedRepository } from "./lib/ranking";
import {
  trendIntelligenceFor,
  type TrendPhase,
} from "./lib/trend-intelligence";
import {
  buildSparklinePoints,
  parseStarSeriesResponse,
  type RepositoryStarSeries,
} from "./lib/star-series";
import {
  addReadRepository,
  parseReadRepositories,
  serializeReadRepositories,
} from "./lib/repository-search";
import type {
  DiscoveryEvidence,
  TrackRecord,
  TrackRecordConversion,
} from "./lib/discovery-track-record";
import {
  parseArchivePageResponse,
  type ArchivePageResponse,
  type ArchiveRepository,
} from "./lib/archive";
import {
  I18nProvider,
  resolveInitialLocale,
  translate,
  useI18n,
  type Locale,
} from "./lib/i18n";
import { parsePublicTrafficResponse } from "./lib/public-traffic";

const PAGE_SIZE = 10;
const DEFAULT_TOPIC_LIMIT = 12;
const SEARCH_TOPIC_LIMIT = 40;
const SEARCH_RESULT_LIMIT = 10;
const READ_REPOSITORIES_STORAGE_KEY = "git-breakout:read-repositories";
const LEGACY_READ_REPOSITORIES_STORAGE_KEY = "github-trend-radar:read-repositories";
const LOCALE_STORAGE_KEY = "git-breakout:locale";
const LEGACY_LOCALE_STORAGE_KEY = "github-trend-radar:locale";

export const RANKING_VIEW_ORDER = ["breakout", "momentum", "current", "github"] as const;
const RANKING_VIEW_LABEL_KEYS = {
  breakout: "ranking.breakout",
  momentum: "ranking.momentum",
  current: "ranking.currentHeat",
  github: "ranking.githubTrending",
} as const;
const GITHUB_TRENDING_PERIOD_LABEL_KEYS = {
  daily: "ranking.githubDaily",
  weekly: "ranking.githubWeekly",
  monthly: "ranking.githubMonthly",
} as const;

type Theme = "light" | "dark";
export type AppPath = "/" | "/archive" | "/track-record";
type StarSeriesState =
  | { status: "loading"; requestKey: string }
  | { status: "ready"; requestKey: string; series: Map<string, RepositoryStarSeries> }
  | { status: "error"; requestKey: string; message: string };

type RepositorySearchState =
  | { status: "idle"; requestKey: string }
  | { status: "loading"; requestKey: string }
  | { status: "ready"; requestKey: string; response: RepositorySearchResponse }
  | { status: "error"; requestKey: string; message: string };

export type TrafficState =
  | { status: "loading" }
  | { status: "ready"; visits: number }
  | { status: "unavailable" };

export function resolveAppPath(pathname: string): AppPath {
  if (pathname === "/" || pathname === "/archive" || pathname === "/track-record") {
    return pathname;
  }
  throw new TypeError(`Unknown application path ${pathname}`);
}

export function resolveRankingRenderSearch(
  requestedSearch: string,
  loadedSearch: string | null,
  hasLoadedSnapshot: boolean,
): string {
  if (!hasLoadedSnapshot) {
    return requestedSearch;
  }
  if (loadedSearch === null) {
    throw new Error("Loaded ranking snapshot query is unavailable");
  }
  return loadedSearch;
}

export function shouldFallbackToMomentum({
  isLatestSnapshot,
  view,
  filters,
  matchingCount,
}: {
  isLatestSnapshot: boolean;
  view: RankingView;
  filters: RepositoryFilters;
  matchingCount: number;
}): boolean {
  return isLatestSnapshot
    && view === "breakout"
    && filters.language === null
    && filters.topic === null
    && matchingCount === 0;
}

export function buildArchiveHref(page: number, query: string): string {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError("Archive page must be a positive integer");
  }
  const normalizedQuery = query.trim();
  if (normalizedQuery.length > 200) {
    throw new TypeError("Archive query must contain at most 200 characters");
  }
  const parameters = new URLSearchParams({ page: String(page) });
  if (normalizedQuery !== "") {
    parameters.set("query", normalizedQuery);
  }
  return `?${parameters.toString()}`;
}

function localeTag(locale: Locale): "en-US" | "ko-KR" {
  return locale === "ko" ? "ko-KR" : "en-US";
}

function formatCapturedAt(value: string, locale: Locale = "en"): string {
  const formatter = new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: locale === "ko" ? "long" : "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  return `${formatter.format(new Date(value))} KST`;
}

export function formatCompactNumber(value: number, locale: Locale = "en"): string {
  if (!Number.isFinite(value)) {
    throw new TypeError("Compact number must be finite");
  }
  return new Intl.NumberFormat(localeTag(locale), {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value).toLowerCase();
}

function formatTimelineDate(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: "Asia/Seoul",
    month: locale === "ko" ? "long" : "short",
    day: "numeric",
  }).format(new Date(value));
}

function formatEvidenceDate(value: string, locale: Locale): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: locale === "ko" ? "long" : "short",
    day: "numeric",
  }).format(new Date(value));
}

function requestedPage(search: string): number {
  const value = new URLSearchParams(search).get("page");
  if (value === null) return 1;
  if (!/^\d+$/.test(value)) {
    throw new TypeError("page must be a positive integer");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError("page must be a positive integer");
  }
  return parsed;
}

function getInitialTheme(): Theme {
  const theme = document.documentElement.dataset.theme;
  if (theme !== "light" && theme !== "dark") {
    throw new Error("Document theme must be initialized before React renders");
  }
  return theme;
}

function ThemeButton() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const { t } = useI18n();

  function toggleTheme() {
    const nextTheme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem("theme", nextTheme);
    setTheme(nextTheme);
  }

  return (
    <button
      className="theme-button"
      type="button"
      onClick={toggleTheme}
      aria-label={theme === "light" ? t("theme.switchDark") : t("theme.switchLight")}
    >
      {theme === "light" ? <MoonIcon size={18} /> : <SunIcon size={18} />}
    </button>
  );
}

function LanguageGlobeIcon() {
  return (
    <svg
      aria-hidden="true"
      className="language-globe"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.75 12h16.5M12 3.5c2.2 2.3 3.3 5.13 3.3 8.5S14.2 18.2 12 20.5M12 3.5C9.8 5.8 8.7 8.63 8.7 12s1.1 6.2 3.3 8.5" />
    </svg>
  );
}

export function LanguageSwitcher({
  locale,
  onChange,
}: {
  locale: Locale;
  onChange: (locale: Locale) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="language-switcher" role="group" aria-label={t("language.label")}>
      <LanguageGlobeIcon />
      <button
        aria-pressed={locale === "ko"}
        className={locale === "ko" ? "language-option-active" : ""}
        onClick={() => onChange("ko")}
        type="button"
      >
        ko
      </button>
      <span aria-hidden="true" className="language-divider" />
      <button
        aria-pressed={locale === "en"}
        className={locale === "en" ? "language-option-active" : ""}
        onClick={() => onChange("en")}
        type="button"
      >
        en
      </button>
    </div>
  );
}

function requireDisplayValue<T>(value: T | null, field: string, fullName: string): T {
  if (value === null) {
    throw new TypeError(`${field} is required to display ${fullName}`);
  }
  return value;
}

function sourceLabel(source: string, locale: Locale = "en"): string {
  if (source === "sample") {
    return translate(locale, "source.sample");
  }
  if (source === "github_official") {
    return translate(locale, "source.official");
  }
  if (source === "github_combined") {
    return translate(locale, "source.combined");
  }
  if (source === "github_events_v2_shadow") {
    return translate(locale, "source.events");
  }
  throw new TypeError(`Unknown ranking source ${source}`);
}

function phaseLabel(phase: Exclude<TrendPhase, "insufficient_data">, locale: Locale): string {
  const keys = {
    spark: "phase.spark",
    breakout: "phase.breakout",
    hot: "phase.hot",
    steady: "phase.steady",
    cooling: "phase.cooling",
  } as const;
  return translate(locale, keys[phase]);
}

function repositoryViewScore(repository: RankedRepository, view: RankingView): number | null {
  if (view === "momentum") return repository.momentum.score;
  if (view === "github") return null;
  const intelligence = trendIntelligenceFor(repository);
  if (intelligence === null) return null;
  return view === "breakout"
    ? intelligence.breakout.score
    : intelligence.current_heat.score;
}

export function rankingViewCopy(
  view: RankingView,
  locale: Locale = "en",
): { title: string; description: string } {
  if (view === "breakout") {
    return {
      title: translate(locale, "ranking.breakoutTitle"),
      description: translate(locale, "ranking.breakoutDescription"),
    };
  }
  if (view === "current") {
    return {
      title: translate(locale, "ranking.currentTitle"),
      description: translate(locale, "ranking.currentDescription"),
    };
  }
  if (view === "github") {
    return {
      title: translate(locale, "ranking.githubTitle"),
      description: translate(locale, "ranking.githubDescription"),
    };
  }
  return {
    title: translate(locale, "ranking.momentumTitle"),
    description: translate(locale, "ranking.momentumDescription"),
  };
}

export function RankingViewHeading({
  title,
  description,
  buttonLabel,
  isMethodologyOpen,
  onOpenMethodology,
}: {
  title: string;
  description: string;
  buttonLabel: string;
  isMethodologyOpen: boolean;
  onOpenMethodology: () => void;
}) {
  return (
    <>
      <div className="board-title-heading">
        <h2>{title}</h2>
        <button
          aria-label={buttonLabel}
          aria-controls="ranking-methodology-dialog"
          aria-expanded={isMethodologyOpen}
          aria-haspopup="dialog"
          className="ranking-view-info-button"
          onClick={onOpenMethodology}
          type="button"
          title={description}
        ><QuestionIcon size={14} /></button>
      </div>
      <p className="visually-hidden" id="ranking-view-description">{description}</p>
    </>
  );
}

function useRepositoryStarSeries(
  snapshotId: string,
  repositories: readonly RankedRepository[],
): StarSeriesState {
  const repositoryKey = repositories.map((repository) => repository.full_name).join("\n");
  const requestKey = `${snapshotId}\n${repositoryKey}`;
  const [state, setState] = useState<StarSeriesState>({ status: "loading", requestKey });

  useEffect(() => {
    const controller = new AbortController();
    if (repositories.length === 0) {
      setState({ status: "ready", requestKey, series: new Map() });
      return () => controller.abort();
    }
    setState({ status: "loading", requestKey });

    async function load() {
      try {
        const parameters = new URLSearchParams({ snapshot: snapshotId });
        repositories.forEach((repository) => parameters.append("repository", repository.full_name));
        const response = await fetch(`/api/star-series?${parameters.toString()}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Star series request failed with status ${response.status}`);
        }
        const parsed = parseStarSeriesResponse(await response.json());
        const series = new Map(parsed.series.map((item) => [item.full_name.toLowerCase(), item]));
        if (
          series.size !== repositories.length
          || repositories.some((repository) => !series.has(repository.full_name.toLowerCase()))
        ) {
          throw new Error("Star series response does not match the visible repositories");
        }
        setState({ status: "ready", requestKey, series });
      } catch (error) {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : "Unknown star series error";
          console.error(message);
          setState({ status: "error", requestKey, message });
        }
      }
    }

    void load();
    return () => controller.abort();
  }, [requestKey]);

  return state.requestKey === requestKey ? state : { status: "loading", requestKey };
}

export function RepositoryThumbnailFallback({ repositoryName }: { repositoryName: string }) {
  const { t } = useI18n();
  return (
    <span
      aria-label={t("repository.previewFallback", { name: repositoryName })}
      className="repository-thumbnail repository-thumbnail-error"
      role="img"
    >
      <MarkGithubIcon aria-hidden="true" size={28} />
    </span>
  );
}

function RepositoryCardThumbnail({ repository }: { repository: RankedRepository }) {
  const [failed, setFailed] = useState(false);
  const { t } = useI18n();

  if (failed) {
    return <RepositoryThumbnailFallback repositoryName={repository.full_name} />;
  }

  return <img
    alt={t("repository.previewAlt", { name: repository.full_name })}
    className="repository-thumbnail"
    decoding="async"
    src={`/api/card?${new URLSearchParams({
      repository: repository.full_name,
      url: repository.open_graph_image_url,
    }).toString()}`}
    onError={() => {
      console.error(`Open Graph image failed for ${repository.full_name}`);
      setFailed(true);
    }}
  />;
}

function RepositorySearchDialog({
  open,
  snapshotId,
  repositoryCount,
  readRepositories,
  onClose,
  onRead,
}: {
  open: boolean;
  snapshotId: string;
  repositoryCount: number;
  readRepositories: ReadonlySet<string>;
  onClose: () => void;
  onRead: (fullName: string) => void;
}) {
  const { locale, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRefs = useRef<Array<HTMLAnchorElement | null>>([]);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const normalizedQuery = query.trim();
  const requestKey = `${snapshotId}\n${normalizedQuery}`;
  const [searchState, setSearchState] = useState<RepositorySearchState>({
    status: "idle",
    requestKey,
  });
  const currentSearchState = searchState.requestKey === requestKey
    ? searchState
    : { status: "idle" as const, requestKey };
  const visibleResults = currentSearchState.status === "ready"
    ? currentSearchState.response.repositories
    : [];
  const totalResults = currentSearchState.status === "ready"
    ? currentSearchState.response.total_count
    : 0;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      throw new Error("Repository search dialog is unavailable");
    }
    if (open && !dialog.open) {
      setQuery("");
      setActiveIndex(0);
      dialog.showModal();
      if (inputRef.current === null) {
        throw new Error("Repository search input is unavailable");
      }
      inputRef.current.focus();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    if (!open || normalizedQuery === "") {
      setSearchState({ status: "idle", requestKey });
      return;
    }
    const controller = new AbortController();
    setSearchState({ status: "loading", requestKey });

    async function loadSearchResults() {
      try {
        const parameters = new URLSearchParams({
          snapshot: snapshotId,
          query: normalizedQuery,
          limit: String(SEARCH_RESULT_LIMIT),
        });
        const response = await fetch(`/api/search?${parameters.toString()}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Repository search failed with status ${response.status}`);
        }
        setSearchState({
          status: "ready",
          requestKey,
          response: parseRepositorySearchResponse(await response.json()),
        });
      } catch (error) {
        if (!controller.signal.aborted) {
          setSearchState({
            status: "error",
            requestKey,
            message: error instanceof Error ? error.message : "Unknown repository search error",
          });
        }
      }
    }

    const timeoutId = window.setTimeout(() => void loadSearchResults(), 180);
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [open, requestKey]);

  function selectResult(index: number) {
    const result = visibleResults[index];
    if (result === undefined) {
      throw new RangeError(`Search result ${index} does not exist`);
    }
    const resultLink = resultRefs.current[index];
    if (resultLink === null || resultLink === undefined) {
      throw new Error(`Search result link ${index} is unavailable`);
    }
    resultLink.click();
  }

  function activateResult(index: number) {
    if (visibleResults[index] === undefined) {
      throw new RangeError(`Search result ${index} does not exist`);
    }
    const resultLink = resultRefs.current[index];
    if (resultLink === null || resultLink === undefined) {
      throw new Error(`Search result link ${index} is unavailable`);
    }
    setActiveIndex(index);
    resultLink.scrollIntoView({ block: "nearest" });
  }

  return (
    <dialog
      aria-labelledby="repository-search-title"
      className="repository-search-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="repository-search-panel">
        <h2 className="visually-hidden" id="repository-search-title">{t("header.searchRepositories")}</h2>
        <div className="repository-search-field">
          <SearchIcon size={22} />
          <input
            aria-controls="repository-search-results"
            aria-label={t("header.searchRepositories")}
            autoComplete="off"
            placeholder={t("search.placeholder", { count: formatCompactNumber(repositoryCount, locale) })}
            ref={inputRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose();
              } else if (event.key === "ArrowDown" && visibleResults.length > 0) {
                event.preventDefault();
                activateResult(Math.min(activeIndex + 1, visibleResults.length - 1));
              } else if (event.key === "ArrowUp" && visibleResults.length > 0) {
                event.preventDefault();
                activateResult(Math.max(activeIndex - 1, 0));
              } else if (event.key === "Enter" && visibleResults.length > 0) {
                event.preventDefault();
                selectResult(activeIndex);
              }
            }}
          />
          <button aria-label={t("search.close")} onClick={onClose} type="button">
            <XIcon size={18} />
          </button>
        </div>

        <div className="repository-search-body">
          {normalizedQuery === "" ? (
            <div className="repository-search-empty">
              <SearchIcon size={24} />
              <p>{t("search.prompt")}</p>
            </div>
          ) : currentSearchState.status === "loading" || currentSearchState.status === "idle" ? (
            <div className="repository-search-empty" role="status">
              <p>{t("search.searching")}</p>
            </div>
          ) : currentSearchState.status === "error" ? (
            <div className="repository-search-empty" role="alert">
              <p>{currentSearchState.message}</p>
            </div>
          ) : visibleResults.length === 0 ? (
            <div className="repository-search-empty">
              <p>{t("search.none", { query: normalizedQuery })}</p>
            </div>
          ) : (
            <>
              <p className="repository-search-count">
                {totalResults > SEARCH_RESULT_LIMIT
                  ? t("search.showing", {
                    visible: SEARCH_RESULT_LIMIT,
                    total: formatCompactNumber(totalResults, locale),
                  })
                  : t("search.resultCount", { count: formatCompactNumber(totalResults, locale) })}
              </p>
              <ol id="repository-search-results" className="repository-search-results">
                {visibleResults.map((repository, index) => {
                  const isRead = readRepositories.has(repository.full_name.toLocaleLowerCase("en-US"));
                  const stars = requireDisplayValue(
                    repository.metrics.stars,
                    "metrics.stars",
                    repository.full_name,
                  );
                  return (
                    <li key={repository.full_name}>
                      <a
                        aria-current={index === activeIndex ? "true" : undefined}
                        className={`repository-search-result ${index === activeIndex ? "repository-search-result-active" : ""} ${isRead ? "repository-search-result-read" : ""}`}
                        href={repository.url}
                        ref={(element) => { resultRefs.current[index] = element; }}
                        rel="noreferrer"
                        target="_blank"
                        onClick={() => {
                          onRead(repository.full_name);
                          onClose();
                        }}
                        onMouseEnter={() => setActiveIndex(index)}
                      >
                        <span className="repository-search-rank">#{repository.rank}</span>
                        <span className="repository-search-copy">
                          <strong>{repository.full_name}</strong>
                          <span>{repository.description ?? t("repository.noDescription")}</span>
                          <small>
                            {repository.language ?? t("repository.unknownLanguage")}
                            <span><StarIcon size={12} />{formatCompactNumber(stars, locale)}</span>
                          </small>
                        </span>
                      </a>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>

        <div className="repository-search-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> {t("search.navigate")}</span>
          <span><kbd>Enter</kbd> {t("search.open")}</span>
          <span><kbd>Esc</kbd> {t("search.closeHint")}</span>
        </div>
      </div>
    </dialog>
  );
}

function formatStarGain(series: RepositoryStarSeries, locale: Locale = "en"): string {
  if (series.points.length < 2) {
    return translate(locale, "repository.trackingStarted");
  }
  const gain = series.points[series.points.length - 1].stars - series.points[0].stars;
  return translate(locale, "repository.gainedSinceTracked", {
    gain: `${gain > 0 ? "+" : ""}${formatCompactNumber(gain, locale)}`,
  });
}

function resolveRepositorySeries(
  repositoryName: string,
  state: StarSeriesState,
): RepositoryStarSeries | null {
  if (state.status !== "ready") {
    return null;
  }
  const series = state.series.get(repositoryName.toLowerCase());
  if (series === undefined) {
    throw new Error(`Star series for ${repositoryName} is missing`);
  }
  return series;
}

export function formatObservedLeadDuration(hours: number, locale: Locale = "en"): string {
  if (!Number.isFinite(hours) || hours < 0) {
    throw new RangeError("Observed lead hours must be a finite non-negative number");
  }
  if (hours < 1) {
    return locale === "ko" ? "1시간 미만" : "<1h";
  }
  if (hours < 24) {
    return locale === "ko" ? `${Math.round(hours)}시간` : `${Math.round(hours)}h`;
  }
  const roundedDays = Math.round(hours / 24 * 10) / 10;
  const formattedDays = roundedDays.toLocaleString(localeTag(locale), { maximumFractionDigits: 1 });
  return locale === "ko" ? `${formattedDays}일` : `${formattedDays}d`;
}

export function DiscoveryEvidenceBadge({ evidence }: { evidence: DiscoveryEvidence }) {
  const { locale, t } = useI18n();
  if (evidence.outcome !== "verified") {
    return null;
  }
  if (evidence.lead_hours === null) {
    throw new TypeError("Verified discovery evidence requires lead_hours");
  }
  if (evidence.coverage !== "complete") {
    throw new TypeError("Verified discovery evidence requires complete coverage");
  }
  const lead = formatObservedLeadDuration(evidence.lead_hours, locale);
  return (
    <span
      className="discovery-evidence-badge"
      title={t("repository.observedBeforeDailyTitle", { lead })}
    >
      <ClockIcon size={11} />{t("repository.observedBeforeDaily", { lead })}
    </span>
  );
}

function RepositoryStarGrowth({
  repositoryName,
  state,
}: {
  repositoryName: string;
  state: StarSeriesState;
}) {
  const { locale, t } = useI18n();
  if (state.status === "loading") {
    return <span className="repository-growth repository-growth-status">{t("repository.loadingHistory")}</span>;
  }
  if (state.status === "error") {
    return <span className="repository-growth repository-growth-status" title={state.message}>{t("repository.historyFailed")}</span>;
  }
  const series = resolveRepositorySeries(repositoryName, state);
  if (series === null || series.points.length < 2) {
    return <span className="repository-growth repository-growth-status">{t("repository.trackingStarted")}</span>;
  }
  const first = series.points[0];
  const latest = series.points[series.points.length - 1];
  const gain = latest.stars - first.stars;
  const label = formatStarGain(series, locale);
  const sparkline = buildSparklinePoints(series.points, 108, 44, 4);
  const latestCoordinate = sparkline.split(" ").at(-1);
  if (latestCoordinate === undefined) {
    throw new Error(`Star sparkline for ${repositoryName} has no latest point`);
  }
  const latestY = latestCoordinate.split(",")[1];
  if (latestY === undefined) {
    throw new Error(`Star sparkline for ${repositoryName} has an invalid latest point`);
  }
  return (
    <span className="repository-growth">
      <svg
        aria-label={`${repositoryName} ${label}`}
        className="star-sparkline"
        role="img"
        viewBox="0 0 108 44"
      >
        <title>{`${formatCapturedAt(first.captured_at, locale)}: ${first.stars} stars; ${formatCapturedAt(latest.captured_at, locale)}: ${latest.stars} stars; change ${gain}`}</title>
        <line className="star-sparkline-baseline" x1="4" x2="104" y1="40" y2="40" />
        <polyline
          className="star-sparkline-line"
          points={sparkline}
        />
        <circle className="star-sparkline-dot" cx="104" cy={latestY} r="2.2" />
      </svg>
      <span className="star-sparkline-label">{label}</span>
    </span>
  );
}

function RankingRow({
  repository,
  displayRank,
  rankingView,
  rowIndex,
  starSeries,
  isRead,
  onRead,
}: {
  repository: RankingPageRepository;
  displayRank: number;
  rankingView: RankingView;
  rowIndex: number;
  starSeries: StarSeriesState;
  isRead: boolean;
  onRead: (fullName: string) => void;
}) {
  const { locale, t } = useI18n();
  const language = repository.language ?? "-";
  const stars = requireDisplayValue(repository.metrics.stars, "metrics.stars", repository.full_name);
  const series = resolveRepositorySeries(repository.full_name, starSeries);
  const intelligence = trendIntelligenceFor(repository);
  const viewScore = repositoryViewScore(repository, rankingView);
  const phase = intelligence?.phase === "insufficient_data" ? null : intelligence?.phase ?? null;

  return (
    <li className={`ranking-row ${isRead ? "ranking-row-read" : ""}`}>
      <div
        className="ranking-row-content"
        style={{ "--row-index": rowIndex } as CSSProperties}
      >
        <span className="rank-number" aria-label={t("repository.rank", { rank: displayRank })}>
          {displayRank}
        </span>
        <RepositoryCardThumbnail repository={repository} />
        <div className="repository-copy">
          <div className="repository-title-line">
            <a
              href={repository.url}
              target="_blank"
              rel="noreferrer"
              className="repository-name"
              onClick={() => onRead(repository.full_name)}
            >
              <RepoIcon size={16} />
              <span>{repository.full_name}</span>
            </a>
            <DiscoveryEvidenceBadge evidence={repository.discovery_evidence} />
            {rankingView === "github" || phase === null ? null : (
              <span
                className={`trend-phase trend-phase-${phase}`}
                title={intelligence?.reasons.join(", ") || phaseLabel(phase, locale)}
              >
                {phaseLabel(phase, locale)}
                {rankingView === "momentum" || viewScore === null ? null : ` ${Math.round(viewScore)}`}
              </span>
            )}
          </div>
          <p>{repository.description}</p>
          <div className="mobile-meta">
            <span>{language}</span>
            <span className="mobile-stars"><StarIcon size={12} />{formatCompactNumber(stars, locale)}</span>
            <span className="mobile-star-growth">
              {starSeries.status === "loading"
                ? t("repository.loadingHistory")
                : starSeries.status === "error"
                  ? t("repository.historyFailed")
                  : series === null ? t("repository.trackingStarted") : formatStarGain(series, locale)}
            </span>
          </div>
        </div>
        <span className="cell language">{language}</span>
        <span className="cell stars">{formatCompactNumber(stars, locale)}</span>
        <RepositoryStarGrowth repositoryName={repository.full_name} state={starSeries} />
      </div>
    </li>
  );
}

function Pagination({
  currentPage,
  totalPages,
  onPageChange,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  const { t } = useI18n();
  const visiblePages = getVisiblePages(currentPage, totalPages);

  return (
    <nav className="pagination" aria-label={t("pagination.label")}>
      {currentPage === 1 ? (
        <span className="page-link page-arrow page-disabled" aria-disabled="true">
          <ChevronLeftIcon size={16} />
        </span>
      ) : (
        <button className="page-link page-arrow" onClick={() => onPageChange(currentPage - 1)} type="button" aria-label={t("pagination.previous")}>
          <ChevronLeftIcon size={16} />
        </button>
      )}
      <div className="page-numbers">
        {visiblePages.map((page) => (
          <button
            className={`page-link page-number ${page === currentPage ? "page-current" : ""} ${Math.abs(page - currentPage) <= 1 ? "page-near" : ""}`}
            aria-current={page === currentPage ? "page" : undefined}
            onClick={() => onPageChange(page)}
            type="button"
            key={page}
          >
            {page}
          </button>
        ))}
      </div>
      {currentPage === totalPages ? (
        <span className="page-link page-arrow page-disabled" aria-disabled="true">
          <ChevronRightIcon size={16} />
        </span>
      ) : (
        <button className="page-link page-arrow" onClick={() => onPageChange(currentPage + 1)} type="button" aria-label={t("pagination.next")}>
          <ChevronRightIcon size={16} />
        </button>
      )}
    </nav>
  );
}

function activeFilterCount(filters: RepositoryFilters): number {
  return Number(filters.language !== null) + Number(filters.topic !== null);
}

function FilterOptionButton({
  option,
  selected,
  onSelect,
}: {
  option: RepositoryFilterOption;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      aria-pressed={selected}
      className={`filter-option ${selected ? "filter-option-selected" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span>{option.label}</span>
      <span className="filter-option-count">{option.count}</span>
    </button>
  );
}

function FilterPanel({
  idPrefix,
  filters,
  languageOptions,
  topicOptions,
  onChange,
}: {
  idPrefix: string;
  filters: RepositoryFilters;
  languageOptions: readonly RepositoryFilterOption[];
  topicOptions: readonly RepositoryFilterOption[];
  onChange: (filters: RepositoryFilters) => void;
}) {
  const { t } = useI18n();
  const [topicSearch, setTopicSearch] = useState("");
  const normalizedSearch = topicSearch.trim().toLocaleLowerCase("en-US");
  const matchingTopics = topicOptions.filter((option) => (
    normalizedSearch === "" || option.label.toLocaleLowerCase("en-US").includes(normalizedSearch)
  ));
  const topicLimit = normalizedSearch === "" ? DEFAULT_TOPIC_LIMIT : SEARCH_TOPIC_LIMIT;
  const visibleTopics = matchingTopics.slice(0, topicLimit);
  const selectedTopic = topicOptions.find((option) => option.value === filters.topic);
  if (
    normalizedSearch === ""
    && selectedTopic !== undefined
    && !visibleTopics.some((option) => option.value === selectedTopic.value)
  ) {
    visibleTopics.push(selectedTopic);
  }

  return (
    <div className="filter-panel">
      <section className="filter-group" aria-labelledby={`${idPrefix}-language-filter-title`}>
        <div className="filter-group-heading">
          <h3 id={`${idPrefix}-language-filter-title`}>{t("filters.language")}</h3>
          {filters.language === null ? null : (
            <button type="button" onClick={() => onChange({ ...filters, language: null })}>{t("filters.clear")}</button>
          )}
        </div>
        <div className="filter-options filter-options-language">
          {languageOptions.map((option) => (
            <FilterOptionButton
              key={option.value}
              option={option}
              selected={filters.language === option.value}
              onSelect={() => onChange({ ...filters, language: option.value })}
            />
          ))}
        </div>
      </section>

      <section className="filter-group" aria-labelledby={`${idPrefix}-topic-filter-title`}>
        <div className="filter-group-heading">
          <h3 id={`${idPrefix}-topic-filter-title`}>{t("filters.topics")}</h3>
          {filters.topic === null ? null : (
            <button type="button" onClick={() => onChange({ ...filters, topic: null })}>{t("filters.clear")}</button>
          )}
        </div>
        <label className="topic-search">
          <span>{t("filters.searchTopics")}</span>
          <span className="topic-search-field">
            <SearchIcon size={14} />
            <input
              type="search"
              value={topicSearch}
              placeholder="e.g. ai"
              onChange={(event) => setTopicSearch(event.target.value)}
            />
          </span>
        </label>
        <div className="filter-options">
          {visibleTopics.map((option) => (
            <FilterOptionButton
              key={option.value}
              option={option}
              selected={filters.topic === option.value}
              onSelect={() => onChange({ ...filters, topic: option.value })}
            />
          ))}
        </div>
        {visibleTopics.length === 0 ? (
          <p className="filter-options-empty">{t("filters.noTopics")}</p>
        ) : normalizedSearch === "" && matchingTopics.length > DEFAULT_TOPIC_LIMIT ? (
          <p className="filter-options-note">{t("filters.topTopics", { count: DEFAULT_TOPIC_LIMIT })}</p>
        ) : null}
      </section>

      {activeFilterCount(filters) === 0 ? null : (
        <button
          className="clear-filters-button"
          type="button"
          onClick={() => onChange({ language: null, topic: null })}
        >
          {t("filters.clearAll")}
        </button>
      )}
    </div>
  );
}

function DesktopFilters({
  collapsed,
  filters,
  languageOptions,
  topicOptions,
  onChange,
  onToggle,
}: {
  collapsed: boolean;
  filters: RepositoryFilters;
  languageOptions: readonly RepositoryFilterOption[];
  topicOptions: readonly RepositoryFilterOption[];
  onChange: (filters: RepositoryFilters) => void;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const count = activeFilterCount(filters);
  return (
    <aside className={`filter-sidebar ${collapsed ? "filter-sidebar-collapsed" : ""}`} aria-label={t("filters.repositoryFilters")}>
      <div className="filter-sidebar-heading">
        {collapsed ? null : (
          <span><FilterIcon size={16} />{t("filters.label")} {count === 0 ? null : <strong>{count}</strong>}</span>
        )}
        <button
          aria-label={collapsed ? t("filters.expand") : t("filters.collapse")}
          className="filter-sidebar-toggle"
          onClick={onToggle}
          type="button"
        >
          {collapsed ? <SidebarExpandIcon size={17} /> : <SidebarCollapseIcon size={17} />}
        </button>
      </div>
      {collapsed ? null : (
        <FilterPanel
          idPrefix="desktop"
          filters={filters}
          languageOptions={languageOptions}
          topicOptions={topicOptions}
          onChange={onChange}
        />
      )}
    </aside>
  );
}

function MobileFilterDialog({
  open,
  filters,
  languageOptions,
  topicOptions,
  onChange,
  onClose,
}: {
  open: boolean;
  filters: RepositoryFilters;
  languageOptions: readonly RepositoryFilterOption[];
  topicOptions: readonly RepositoryFilterOption[];
  onChange: (filters: RepositoryFilters) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      throw new Error("Mobile filter dialog is unavailable");
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      aria-labelledby="mobile-filter-title"
      className="mobile-filter-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="mobile-filter-sheet">
        <div className="mobile-filter-heading">
          <div>
            <FilterIcon size={17} />
            <h2 id="mobile-filter-title">{t("filters.label")}</h2>
          </div>
          <button aria-label={t("filters.close")} onClick={onClose} type="button"><XIcon size={18} /></button>
        </div>
        <FilterPanel
          idPrefix="mobile"
          filters={filters}
          languageOptions={languageOptions}
          topicOptions={topicOptions}
          onChange={onChange}
        />
        <button className="mobile-filter-done" onClick={onClose} type="button">{t("filters.showResults")}</button>
      </div>
    </dialog>
  );
}

function requireSelectedSnapshotIndex(
  snapshots: readonly RankingSnapshotMetadata[],
  selectedId: string,
): number {
  const selectedIndex = snapshots.findIndex((snapshot) => snapshot.id === selectedId);
  if (selectedIndex < 0) {
    throw new RangeError(`Selected snapshot ${selectedId} does not exist`);
  }
  return selectedIndex;
}

function Timeline({
  snapshots,
  selectedId,
  onSelect,
}: {
  snapshots: readonly RankingSnapshotMetadata[];
  selectedId: string;
  onSelect: (snapshotId: string) => void;
}) {
  const { locale, t } = useI18n();
  const selectedIndex = requireSelectedSnapshotIndex(snapshots, selectedId);
  const [previewIndex, setPreviewIndex] = useState(selectedIndex);
  const previewSnapshot = snapshots[previewIndex];
  const timelineProgress =
    snapshots.length === 1 ? 0 : (previewIndex / (snapshots.length - 1)) * 100;

  useEffect(() => {
    setPreviewIndex(selectedIndex);
  }, [selectedIndex]);

  function readSliderIndex(values: number[]): number {
    const index = values[0];
    if (!Number.isInteger(index) || snapshots[index] === undefined) {
      throw new RangeError(`Timeline index ${String(index)} does not exist`);
    }
    return index;
  }

  function commitSelection(values: number[]) {
    const index = readSliderIndex(values);
    setPreviewIndex(index);
    if (index !== selectedIndex) {
      onSelect(snapshots[index].id);
    }
  }

  return (
    <section className="timeline" aria-labelledby="timeline-title">
      <div className="timeline-heading">
        <div className="timeline-title">
          <HistoryIcon size={14} />
          <h2 id="timeline-title">{t("timeline.title")}</h2>
        </div>
        <span className="timeline-count">{snapshots.length === 1
          ? t("timeline.snapshot")
          : t("timeline.snapshots", { count: snapshots.length })}</span>
      </div>
      <div
        className="timeline-scrubber"
        style={{ "--timeline-progress": `${timelineProgress}%` } as CSSProperties}
      >
        <div className="timeline-tooltip" aria-hidden="true">
          <time dateTime={previewSnapshot.captured_at}>
            {formatCapturedAt(previewSnapshot.captured_at, locale)}
          </time>
        </div>
        {snapshots.length === 1 ? (
          <div className="timeline-static-track">
            <span className="timeline-tick timeline-tick-active" />
          </div>
        ) : (
          <Slider.Root
            aria-label={t("timeline.slider")}
            className="timeline-slider"
            min={0}
            max={snapshots.length - 1}
            step={1}
            value={[previewIndex]}
            onValueChange={(values) => setPreviewIndex(readSliderIndex(values))}
            onValueCommit={commitSelection}
          >
            <Slider.Track className="timeline-track">
              <Slider.Range className="timeline-range" />
              <span className="timeline-ticks" aria-hidden="true">
                {snapshots.map((snapshot, index) => (
                  <span
                    className={`timeline-tick ${index <= previewIndex ? "timeline-tick-active" : ""}`}
                    key={snapshot.id}
                    style={{ left: `${(index / (snapshots.length - 1)) * 100}%` }}
                  />
                ))}
              </span>
            </Slider.Track>
            <Slider.Thumb
              aria-label={t("timeline.slider")}
              aria-valuetext={formatCapturedAt(previewSnapshot.captured_at, locale)}
              className="timeline-thumb"
            />
          </Slider.Root>
        )}
      </div>
      <div className="timeline-boundaries" aria-hidden="true">
        <span>{formatTimelineDate(snapshots[0].captured_at, locale)}</span>
        <span>{t("timeline.latest", { date: formatTimelineDate(snapshots[snapshots.length - 1].captured_at, locale) })}</span>
      </div>
    </section>
  );
}

function MethodologyDialog({
  open,
  trackRecord,
  onClose,
}: {
  open: boolean;
  trackRecord: TrackRecord;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      throw new Error("Methodology dialog is unavailable");
    }
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      aria-labelledby="methodology-title"
      className="methodology-dialog"
      id="ranking-methodology-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="methodology-panel">
        <header className="methodology-heading">
          <div>
            <span className="methodology-eyebrow">{locale === "ko" ? "투명한 계산 방식" : "Transparent methodology"}</span>
            <h2 id="methodology-title">{t("trackRecord.methodology")}</h2>
          </div>
          <button aria-label={locale === "ko" ? "계산 방식 닫기" : "Close methodology"} onClick={onClose} type="button">
            <XIcon size={18} />
          </button>
        </header>

        <div className="methodology-body">
          {locale === "ko" ? (
            <>
              <section>
                <h3>검증된 사전 발굴</h3>
                <p>
                  GitHub 일간 트렌딩을 주 검증 기준으로 삼고 주간·월간 트렌딩 진입은 별도로 기록합니다.
                  수집 주기가 2시간이므로 선행 시간은 GitBreakout과 GitHub Trending에서 각각 처음 관측한
                  시점의 간격입니다. GitHub가 저장소를 추가한 정확한 시각과는 다를 수 있습니다.
                </p>
                <p>
                  후보는 공식 Trending과 GitHub Search, GH Archive 활동, 기존 관측 목록에서 찾습니다.
                  GitHub Search는 새로 생성되거나 최근 푸시된 저장소를 찾는 데 사용합니다. 최초 관측 출처가
                  GitHub Search나 GH Archive로 확인된 저장소만 사전 발굴 검증 대상에 포함합니다.
                </p>
                <ul>
                  <li><strong>검증 완료:</strong> 일간 트렌딩에 오르기 전에 먼저 관측한 경우입니다.</li>
                  <li><strong>평가 중:</strong> 아직 14일 평가 기간 안에 있습니다.</li>
                  <li><strong>미진입:</strong> 수집 공백 없이 14일이 지났지만 일간 트렌딩에서 관측되지 않았습니다.</li>
                  <li><strong>판단 불가:</strong> 수집 공백으로 완전한 평가를 할 수 없습니다.</li>
                  <li><strong>이미 트렌딩:</strong> 처음 관측했을 때부터 일간 트렌딩에 있었습니다.</li>
                  <li><strong>과거 데이터:</strong> 출처를 입증할 수 없어 검증 결과에서 제외합니다.</li>
                </ul>
                <p>
                  7일·14일 진입률은 평가 기간이 지난 사례 중 공식 Trending을 빠짐없이 수집한 사례만 계산합니다.
                  평가 중인 사례와 이미 트렌딩이었던 저장소, 과거 데이터, 수집 공백 사례는 계산에서 제외합니다.
                </p>
              </section>

              <section>
                <div className="methodology-section-title">
                  <h3>모멘텀</h3>
                  <code>baseline-v1</code>
                </div>
                <p>각 요소를 더해 점수를 계산하며, 실제로 관측한 성장 속도에 가장 큰 가중치를 둡니다.</p>
                <dl className="methodology-weights">
                  <div><dt>일일 관측 스타 증가</dt><dd>log1p(value) × 55</dd></div>
                  <div><dt>전체 기간 스타 속도</dt><dd>log1p(stars ÷ age days) × 28</dd></div>
                  <div><dt>스타</dt><dd>log1p(value) × 5</dd></div>
                  <div><dt>포크</dt><dd>log1p(value) × 2</dd></div>
                  <div><dt>열린 이슈</dt><dd>log1p(value) × 0.5</dd></div>
                  <div><dt>최근 푸시</dt><dd>max(0, 14 − push age days)</dd></div>
                  <div><dt>최초 관측</dt><dd>12</dd></div>
                  <div><dt>공식 Trending 신호</dt><dd>0</dd></div>
                </dl>
              </section>

              <section>
                <div className="methodology-section-title">
                  <h3>급부상과 현재 관심도</h3>
                  <code>trend-intelligence-v5-shadow</code>
                </div>
                <p>확인 가능한 구성요소의 동일 가중 평균에 100을 곱합니다. 누락된 값은 0으로 처리하지 않고 계산에서 제외합니다.</p>
                <div className="methodology-models">
                  <div>
                    <h4>급부상</h4>
                    <p>
                      처음 관측했을 때 스타가 1만 개 미만이고 당시 공식 Trending에 없었으며, 이전 수집 시점까지
                      Trending 진입 이력이 없는 저장소만 계산합니다. 실제 스타 증가가 최소 6시간 동안 관측되어야 합니다.
                      수집 공백으로 정확한 6시간 구간을 만들 수 없을 때는 2시간 이상 떨어진 두 관측값으로 계산한
                      일일 환산 속도를 저신뢰도 근거로 사용합니다.
                    </p>
                    <ul>
                      <li>스타 속도: 선택한 구간의 증가량을 24시간 기준으로 환산해 전체 신규 후보와 비교합니다.</li>
                      <li>상대 성장: 스타 증가량을 직전 스타 수로 나눈 뒤 24시간 기준으로 환산합니다.</li>
                      <li>자기 성장 가속: 7일 기준점이 있으면 최근 24시간 증가량과 이전 일평균 증가량을 비교합니다.</li>
                      <li>스타 가속: 시간당 6시간 증가율과 24시간 증가율, 또는 1시간과 6시간 증가율을 비교합니다.</li>
                      <li>참여자 가속과 참여 폭: 최신 GitHub 이벤트가 있으면 고유 참여자의 변화와 규모를 점수에 반영합니다.</li>
                    </ul>
                  </div>
                  <div>
                    <h4>현재 관심도</h4>
                    <p>전체 저장소를 기준으로 스타 증가 속도와 고유 참여자 수, 활동 종류, 단기 지속성을 비교합니다.</p>
                    <ul>
                      <li>스타 속도: 선택한 구간의 스타 증가량을 24시간 기준으로 환산합니다.</li>
                      <li>참여 폭: 선택한 이벤트 구간의 고유 참여자 수입니다.</li>
                      <li>다양성: Watch, Fork, PR·Issue·Comment, Push·Release 중 활성 범주의 비율입니다.</li>
                      <li>지속성: 단기 참여자를 장기 구간 기준으로 환산한 비율이며 최대 1입니다.</li>
                    </ul>
                  </div>
                </div>
              </section>

              <section>
                <div className="methodology-section-title">
                  <h3>GitHub 트렌딩</h3>
                  <code>직접 순위</code>
                </div>
                <p>
                  별도 점수를 계산하지 않고 수집 당시 GitHub 트렌딩 페이지의 순위를 기간별로 보여줍니다.
                  일간·주간·월간 순위는 서로 섞지 않습니다.
                </p>
              </section>

              <section>
                <h3>관측 구간, 신뢰도와 한계</h3>
                <p>
                  현재 관심도는 빠짐없이 수집된 가장 긴 구간을 24시간 → 6시간 → 1시간 순서로 사용합니다.
                  6시간 구간이나 2시간 이상 실제 관측 속도가 있는 초기 후보는 계산 점수 상위 10%만 보여줍니다. 24시간 데이터가 쌓이면
                  70점 이상인 저장소를 비율 제한 없이 보여줍니다. 7일 기준점이나 GitHub 이벤트가 없으면 신뢰도는
                  낮아지지만 후보에서 바로 제외되지는 않습니다. 4시간보다 오래된 이벤트는 이벤트 지표 계산에서 제외합니다.
                </p>
                <p>
                  모멘텀 신뢰도는 스타 관측 구간과 저장소 지표가 얼마나 완전한지에 따라 달라집니다. v5의 신뢰도는
                  24시간 스타 증가, 7일 자기 기준점, 이벤트 범위도 함께 반영합니다. 높은 신뢰도를 받으려면
                  1시간·6시간·24시간 스타 구간과 24시간 이벤트 구간, 이전 72시간 참여자 근거가 모두 있어야 합니다.
                </p>
                <p>
                  새 후보는 14일간 유지하며 이후에는 최근 7일 스타 증가 또는 30일 내 푸시가 있어야 계속 추적합니다.
                  GitHub Search의 검색 범위, API 가용성, 수집 공백, 삭제된 저장소, GitHub Trending 결과 변화에 따라 관측 범위가 달라질 수 있습니다.
                </p>
              </section>
            </>
          ) : (
            <>
          <section>
            <h3>Verified early discovery</h3>
            <p>
              GitHub Trending Daily is the primary benchmark; Weekly and Monthly appearances are
              tracked separately. Collection runs every two hours, so a lead time is the interval
              between our first observation and our first observed Trending appearance, not the
              exact moment GitHub added the repository.
            </p>
            <p>
              Candidates come from official Trending, GitHub Search for newly created or recently
              pushed repositories, GH Archive activity, and the retained observation pool. Only a
              first observation proven to come from Search or GH Archive can enter the early-discovery
              cohort.
            </p>
            <ul>
              <li><strong>Verified:</strong> observed outside Trending Daily, then later observed in Daily.</li>
              <li><strong>Pending:</strong> still inside the 14-day evaluation window.</li>
              <li><strong>Not converted:</strong> no observed Daily appearance after 14 days of complete coverage.</li>
              <li><strong>Inconclusive:</strong> a collection gap prevents a complete evaluation.</li>
              <li><strong>Already trending:</strong> Daily was already present at first observation.</li>
              <li><strong>Legacy:</strong> provenance cannot be proved, so it is excluded from verified results.</li>
            </ul>
            <p>
              Seven- and fourteen-day follow-through include only discoveries old enough for the
              window with complete official coverage. Pending, already-trending, legacy, and
              coverage-gap observations are excluded from the denominator.
            </p>
          </section>

          <section>
            <div className="methodology-section-title">
              <h3>Momentum</h3>
              <code>baseline-v1</code>
            </div>
            <p>The score is additive, with observed growth carrying the most weight:</p>
            <dl className="methodology-weights">
              <div><dt>Observed stars per day</dt><dd>log1p(value) × 55</dd></div>
              <div><dt>Lifetime star velocity</dt><dd>log1p(stars ÷ age days) × 28</dd></div>
              <div><dt>Stars</dt><dd>log1p(value) × 5</dd></div>
              <div><dt>Forks</dt><dd>log1p(value) × 2</dd></div>
              <div><dt>Open issues</dt><dd>log1p(value) × 0.5</dd></div>
              <div><dt>Recent push</dt><dd>max(0, 14 − push age days)</dd></div>
              <div><dt>First observation</dt><dd>12</dd></div>
              <div><dt>Official Trending signal</dt><dd>0</dd></div>
            </dl>
          </section>

          <section>
            <div className="methodology-section-title">
              <h3>Breakout and Current Heat</h3>
              <code>trend-intelligence-v5-shadow</code>
            </div>
            <p>
              Each score is 100 times the equal-weight mean of its known components. Missing
              components are omitted rather than replaced with zero.
            </p>
            <div className="methodology-models">
              <div>
                <h4>Breakout</h4>
                <p>
                  A repository is eligible only when it was first observed below 10k stars, was not
                  already on official Trending, and has no prior Trending episode. At least six hours
                  of observed star growth is required. During a collection gap, a daily rate calculated
                  from observations at least two hours apart supplies temporary low-confidence evidence.
                </p>
                <ul>
                  <li>Star velocity: selected star growth normalized to 24 hours across all emerging candidates.</li>
                  <li>Relative growth: star delta ÷ prior stars, normalized to 24 hours.</li>
                  <li>Self acceleration: when available, current 24h growth ÷ the preceding roughly seven-day daily average.</li>
                  <li>Star acceleration: 6h/hour − 24h/hour, or 1h − 6h/hour.</li>
                  <li>Actor acceleration and organic breadth: optional evidence from fresh GitHub events.</li>
                </ul>
              </div>
              <div>
                <h4>Current Heat</h4>
                <p>
                  Global star-velocity percentile, global unique-actor percentile, event-category
                  diversity, and short-window actor persistence measure current attention.
                </p>
                <ul>
                  <li>Star velocity: selected star delta normalized to 24 hours.</li>
                  <li>Organic breadth: unique actors in the selected event window.</li>
                  <li>Diversity: active Watch, Fork, PR/Issue/Comment, and Push/Release categories ÷ 4.</li>
                  <li>Persistence: scaled short-window actors ÷ longer-window actors, capped at 1.</li>
                </ul>
              </div>
            </div>
          </section>

          <section>
            <div className="methodology-section-title">
              <h3>GitHub Trending</h3>
              <code>direct rank</code>
            </div>
            <p>
              This view uses the GitHub Trending rank observed at collection time without applying
              another score. Daily, Weekly, and Monthly ranks remain separate.
            </p>
          </section>

          <section>
            <h3>Windows, confidence, and limits</h3>
            <p>
              Current Heat uses the longest complete window in the order 24h → 6h → 1h. Breakout shows
              only the top 10% while candidates have a six-hour window or an observed rate spanning at
              least two hours; once 24-hour evidence exists,
              every repository scoring at least 70 is shown. A missing seven-day baseline or GitHub event
              lowers confidence instead of removing the candidate. Event evidence older than four hours is excluded.
            </p>
            <p>
              Momentum confidence depends on observed star windows and repository metric
              completeness. v5 confidence also considers 24-hour star growth, a seven-day self baseline,
              and event coverage. High confidence requires complete 1h/6h/24h star windows, a 24h event
              window, and prior 72h actor evidence.
            </p>
            <p>
              Candidate retention gives new discoveries 14 days, then requires seven-day star
              growth or a push within 30 days. Search pagination, API availability, collection gaps,
              deleted repositories, and GitHub&apos;s changing Trending output can limit coverage.
            </p>
          </section>
            </>
          )}

          <footer className="methodology-meta">
            <span>{locale === "ko" ? "근거 스키마" : "Evidence schema"} {trackRecord.schema_version}</span>
            <span>{locale === "ko" ? "생성" : "Generated"} {formatCapturedAt(trackRecord.generated_at, locale)}</span>
          </footer>
        </div>
      </div>
    </dialog>
  );
}

function TrackRecordMetric({
  label,
  value,
  detail,
  collecting,
}: {
  label: string;
  value: string;
  detail: string;
  collecting: boolean;
}) {
  return (
    <div className={`track-record-metric ${collecting ? "track-record-metric-collecting" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </div>
  );
}

function conversionMetric(conversion: TrackRecordConversion, locale: Locale = "en"): {
  value: string;
  detail: string;
  collecting: boolean;
} {
  if (conversion.eligible === 0) {
    return {
      value: translate(locale, "trackRecord.collecting"),
      detail: translate(locale, "trackRecord.noEligible"),
      collecting: true,
    };
  }
  if (conversion.rate === null) {
    throw new TypeError("Eligible conversion evidence requires a rate");
  }
  return {
    value: new Intl.NumberFormat(localeTag(locale), {
      style: "percent",
      maximumFractionDigits: 0,
    }).format(conversion.rate),
    detail: translate(locale, "trackRecord.eligible", {
      converted: conversion.converted,
      eligible: conversion.eligible,
    }),
    collecting: false,
  };
}

export function TrackRecordSection({ trackRecord }: { trackRecord: TrackRecord }) {
  const { locale, t } = useI18n();
  const [isMethodologyOpen, setIsMethodologyOpen] = useState(false);
  const sevenDay = conversionMetric(trackRecord.conversion_7d, locale);
  const fourteenDay = conversionMetric(trackRecord.conversion_14d, locale);
  const verifiedReady = trackRecord.verified_count > 0;
  const medianLead = trackRecord.median_lead_hours;
  const medianReady = verifiedReady && medianLead !== null;
  const evidenceStart = trackRecord.evidence_started_at === null
    ? t("trackRecord.evidencePending")
    : t("trackRecord.evidenceSince", {
      date: formatEvidenceDate(trackRecord.evidence_started_at, locale),
    });

  return (
    <section className="track-record" aria-labelledby="track-record-title">
      <div className="track-record-heading">
        <div className="track-record-title">
          <TelescopeIcon size={17} />
          <div>
            <h2 id="track-record-title">{t("trackRecord.title")}</h2>
            <p>{t("trackRecord.subtitle")}</p>
          </div>
        </div>
        <div className="track-record-heading-meta">
          <span>{evidenceStart}</span>
          <button
            aria-controls="ranking-methodology-dialog"
            aria-expanded={isMethodologyOpen}
            aria-haspopup="dialog"
            aria-label={t("trackRecord.methodology")}
            onClick={() => setIsMethodologyOpen(true)}
            title={t("trackRecord.methodology")}
            type="button"
          >
            <QuestionIcon size={16} />
          </button>
        </div>
      </div>

      <div className="track-record-content">
        <div className="track-record-metrics">
          <TrackRecordMetric
            collecting={!verifiedReady}
            label={t("trackRecord.verifiedEarly")}
            value={verifiedReady
              ? new Intl.NumberFormat(localeTag(locale)).format(trackRecord.verified_count)
              : t("trackRecord.collecting")}
            detail={verifiedReady
              ? t("trackRecord.periods", trackRecord.period_hits)
              : t("trackRecord.excluded")}
          />
          <TrackRecordMetric
            collecting={!medianReady}
            label={t("trackRecord.medianLead")}
            value={medianReady
              ? formatObservedLeadDuration(medianLead, locale)
              : t("trackRecord.collecting")}
            detail={medianReady ? t("trackRecord.interval") : t("trackRecord.waiting")}
          />
          <TrackRecordMetric label={t("trackRecord.follow7")} {...sevenDay} />
          <TrackRecordMetric label={t("trackRecord.follow14")} {...fourteenDay} />
        </div>

        <div className="track-record-recent">
          <div className="track-record-recent-heading">
            <GraphIcon size={14} />
            <h3>{t("trackRecord.recent")}</h3>
          </div>
          {trackRecord.recent_hits.length === 0 ? (
            <p className="track-record-empty">{t("trackRecord.recentEmpty")}</p>
          ) : (
            <ol>
              {trackRecord.recent_hits.map((hit) => (
                <li key={`${hit.full_name}-${hit.first_trending_at}`}>
                  <a
                    href={`https://github.com/${hit.full_name.split("/").map(encodeURIComponent).join("/")}`}
                    rel="noreferrer"
                    target="_blank"
                  >
                    <RepoIcon size={13} />
                    <span>{hit.full_name}</span>
                  </a>
                  <span>
                    {t("trackRecord.recentHit", {
                      lead: formatObservedLeadDuration(hit.lead_hours, locale),
                      rank: hit.first_trending_rank,
                    })}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>

      <MethodologyDialog
        open={isMethodologyOpen}
        trackRecord={trackRecord}
        onClose={() => setIsMethodologyOpen(false)}
      />
    </section>
  );
}

export function SiteNavigation({
  currentPath,
  onNavigate,
}: {
  currentPath: AppPath;
  onNavigate: (event: MouseEvent<HTMLAnchorElement>, path: AppPath) => void;
}) {
  const { t } = useI18n();
  const links: Array<{ path: AppPath; label: string }> = [
    { path: "/", label: t("nav.rankings") },
    { path: "/archive", label: t("nav.archive") },
    { path: "/track-record", label: t("nav.trackRecord") },
  ];
  return (
    <nav aria-label={t("nav.primary")} className="site-navigation">
      <div className="site-navigation-inner">
        {links.map((link) => (
          <a
            aria-current={currentPath === link.path ? "page" : undefined}
            href={link.path}
            key={link.path}
            onClick={(event) => onNavigate(event, link.path)}
          >
            {link.label}
          </a>
        ))}
      </div>
    </nav>
  );
}

function TrackRecordPage({ trackRecord }: { trackRecord: TrackRecord }) {
  const { t } = useI18n();
  return (
    <main className="page-container standalone-page track-record-page">
      <section className="standalone-page-intro" aria-labelledby="track-record-page-title">
        <h1 id="track-record-page-title">{t("trackRecord.title")}</h1>
        <p>{t("trackRecord.pageDescription")}</p>
      </section>
      <TrackRecordSection trackRecord={trackRecord} />
    </main>
  );
}

function ArchiveRow({
  repository,
  isRead,
  onRead,
  onOpenSnapshot,
}: {
  repository: ArchiveRepository;
  isRead: boolean;
  onRead: (fullName: string) => void;
  onOpenSnapshot: (event: MouseEvent<HTMLAnchorElement>, snapshotId: string) => void;
}) {
  const { locale, t } = useI18n();
  const stars = requireDisplayValue(repository.metrics.stars, "metrics.stars", repository.full_name);
  return (
    <li className={`archive-row ${isRead ? "archive-row-read" : ""}`}>
      <RepositoryCardThumbnail repository={repository} />
      <div className="archive-repository-copy">
        <div className="repository-title-line">
          <a
            className="repository-name"
            href={repository.url}
            rel="noreferrer"
            target="_blank"
            onClick={() => onRead(repository.full_name)}
          >
            <RepoIcon size={14} />
            {repository.full_name}
          </a>
        </div>
        <p>{repository.description ?? t("repository.noDescription")}</p>
        <span className="archive-mobile-meta">
          {repository.language ?? t("repository.unknownLanguage")} · {formatCompactNumber(stars, locale)} {t("ranking.column.stars")} · {t("archive.lastRank", { rank: repository.rank })}
        </span>
      </div>
      <span className="archive-stat">{repository.language ?? "—"}</span>
      <span className="archive-stat"><StarIcon size={12} />{formatCompactNumber(stars, locale)}</span>
      <span className="archive-stat">#{repository.rank}</span>
      <span className="archive-last-observed">
        <time dateTime={repository.last_observed_at}>{formatCapturedAt(repository.last_observed_at, locale)}</time>
        <a
          href={`/?page=1&snapshot=${encodeURIComponent(repository.last_snapshot_id)}`}
          onClick={(event) => onOpenSnapshot(event, repository.last_snapshot_id)}
        >
          {t("archive.viewSnapshot")}
        </a>
      </span>
    </li>
  );
}

function ArchivePage({
  locationSearch,
  readRepositories,
  onRead,
  onNavigate,
  onOpenSnapshot,
}: {
  locationSearch: string;
  readRepositories: ReadonlySet<string>;
  onRead: (fullName: string) => void;
  onNavigate: (href: string, mode: RankingNavigationMode) => void;
  onOpenSnapshot: (event: MouseEvent<HTMLAnchorElement>, snapshotId: string) => void;
}) {
  const { t } = useI18n();
  const parameters = new URLSearchParams(locationSearch);
  const page = requestedPage(locationSearch);
  const query = parameters.get("query")?.trim() ?? "";
  const [queryInput, setQueryInput] = useState(query);
  const [archive, setArchive] = useState<ArchivePageResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [archiveError, setArchiveError] = useState<string | null>(null);

  useEffect(() => setQueryInput(query), [query]);

  useEffect(() => {
    const controller = new AbortController();
    setIsLoading(true);
    setArchiveError(null);
    async function loadArchive() {
      try {
        const requestParameters = new URLSearchParams({
          page: String(page),
          page_size: String(PAGE_SIZE),
        });
        if (query !== "") requestParameters.set("query", query);
        const response = await fetch(`/api/archive?${requestParameters.toString()}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Archive request failed with status ${response.status}`);
        }
        setArchive(parseArchivePageResponse(await response.json()));
      } catch (error) {
        if (!controller.signal.aborted) {
          setArchiveError(error instanceof Error ? error.message : "Unknown archive error");
        }
      } finally {
        if (!controller.signal.aborted) setIsLoading(false);
      }
    }
    void loadArchive();
    return () => controller.abort();
  }, [page, query]);

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onNavigate(buildArchiveHref(1, queryInput), "push");
  }

  const totalPages = archive === null
    ? 0
    : Math.ceil(archive.matching_count / archive.page_size);

  return (
    <main className="page-container standalone-page archive-page">
      <section className="standalone-page-intro" aria-labelledby="archive-page-title">
        <h1 id="archive-page-title">{t("archive.title")}</h1>
        <p>{t("archive.description")}</p>
      </section>

      <section aria-busy={isLoading} className={`archive-board ${isLoading ? "archive-board-loading" : ""}`}>
        <div className="archive-board-heading">
          <div>
            <h2>{t("archive.inactive")}</h2>
            <p>{t("archive.inactiveDescription")}</p>
          </div>
          <span className="result-count">
            {archive === null
              ? t("archive.loading")
              : query === ""
                ? t("ranking.repositories", { count: archive.archive_count })
                : t("ranking.filteredRepositories", {
                  matching: archive.matching_count,
                  total: archive.archive_count,
                })}
          </span>
        </div>
        <form className="archive-search" onSubmit={submitSearch} role="search">
          <label htmlFor="archive-search-input">{t("archive.searchLabel")}</label>
          <div>
            <SearchIcon size={16} />
            <input
              id="archive-search-input"
              maxLength={200}
              placeholder={t("archive.searchPlaceholder")}
              type="search"
              value={queryInput}
              onChange={(event) => setQueryInput(event.target.value)}
            />
            <button type="submit">{t("header.search")}</button>
          </div>
        </form>
        <div className="archive-column-heading" aria-hidden="true">
          <span>{t("ranking.column.card")}</span><span>{t("ranking.column.repository")}</span><span>{t("ranking.column.language")}</span><span>{t("ranking.column.stars")}</span><span>{t("archive.column.lastRank")}</span><span>{t("archive.column.lastObserved")}</span>
        </div>
        {archiveError !== null ? (
          <p className="archive-status" role="alert">{archiveError}</p>
        ) : archive === null ? (
          <div className="archive-status" role="status">{t("archive.loadingRepositories")}</div>
        ) : archive.repositories.length === 0 ? (
          <div className="archive-empty-state">
            <h3>{query === "" ? t("archive.empty") : t("archive.noResults", { query })}</h3>
            <p>{query === ""
              ? t("archive.emptyDescription")
              : t("archive.noResultsDescription")}</p>
          </div>
        ) : (
          <ol className="archive-list">
            {archive.repositories.map((repository) => (
              <ArchiveRow
                isRead={readRepositories.has(repository.full_name.toLocaleLowerCase("en-US"))}
                key={repository.full_name}
                onRead={onRead}
                onOpenSnapshot={onOpenSnapshot}
                repository={repository}
              />
            ))}
          </ol>
        )}
        {totalPages === 0 || archive === null ? null : (
          <div className="board-footer">
            <Pagination
              currentPage={archive.page}
              totalPages={totalPages}
              onPageChange={(nextPage) => onNavigate(buildArchiveHref(nextPage, query), "push")}
            />
          </div>
        )}
      </section>
    </main>
  );
}

function RankingPage({
  snapshots,
  selectedId,
  selectedSnapshot,
  isSnapshotLoading,
  snapshotError,
  readRepositories,
  onSelect,
  onRead,
  locationSearch,
  onNavigate,
}: {
  snapshots: readonly RankingSnapshotMetadata[];
  selectedId: string;
  selectedSnapshot: RankingPageResponse;
  isSnapshotLoading: boolean;
  snapshotError: string | null;
  readRepositories: ReadonlySet<string>;
  onSelect: (snapshotId: string) => void;
  onRead: (fullName: string) => void;
  locationSearch: string;
  onNavigate: (href: string, mode: RankingNavigationMode) => void;
}) {
  const { locale, t } = useI18n();
  const filters = parseRepositoryFilters(locationSearch);
  const rankingView = parseRankingView(locationSearch);
  const trendingPeriod = parseGitHubTrendingPeriod(locationSearch);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileFiltersOpen, setIsMobileFiltersOpen] = useState(false);
  const [isMethodologyOpen, setIsMethodologyOpen] = useState(false);
  const filterOptions = {
    languages: selectedSnapshot.languages,
    topics: selectedSnapshot.topics,
  };
  const totalPages = Math.ceil(selectedSnapshot.matching_count / selectedSnapshot.page_size);
  const currentPage = selectedSnapshot.page;
  const start = (currentPage - 1) * selectedSnapshot.page_size;
  const repositories = selectedSnapshot.repositories;
  const starSeries = useRepositoryStarSeries(selectedSnapshot.id, repositories);
  const filterCount = activeFilterCount(filters);
  const viewCopy = rankingViewCopy(rankingView, locale);
  const intelligenceAvailable = selectedSnapshot.intelligence_available;

  function changeFilters(nextFilters: RepositoryFilters) {
    onNavigate(
      buildRankingHref(1, selectedSnapshot.id, nextFilters, rankingView, trendingPeriod),
      "replace",
    );
  }

  function changeRankingView(nextView: RankingView) {
    if ((nextView === "breakout" || nextView === "current") && !intelligenceAvailable) {
      throw new Error(`Trend intelligence is unavailable for snapshot ${selectedSnapshot.id}`);
    }
    onNavigate(
      buildRankingHref(1, selectedSnapshot.id, filters, nextView, trendingPeriod),
      "replace",
    );
  }

  function changeTrendingPeriod(nextPeriod: GitHubTrendingPeriod) {
    onNavigate(
      buildRankingHref(1, selectedSnapshot.id, filters, "github", nextPeriod),
      "replace",
    );
  }

  function changePage(nextPage: number) {
    if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > totalPages) {
      throw new RangeError(`Page ${nextPage} must be within the ranking page range`);
    }
    onNavigate(
      buildRankingHref(nextPage, selectedSnapshot.id, filters, rankingView, trendingPeriod),
      "push",
    );
  }

  return (
    <main className="page-container">
      <section className="page-intro" aria-labelledby="page-title">
        <h1 id="page-title">{t("ranking.title")}</h1>
        <p className="last-updated">
          <HistoryIcon size={14} />
          <span>
            {t("ranking.lastUpdated")} <time dateTime={selectedSnapshot.captured_at}>
              {formatCapturedAt(selectedSnapshot.captured_at, locale)}
            </time>
          </span>
        </p>
        <Timeline snapshots={snapshots} selectedId={selectedId} onSelect={onSelect} />
      </section>

      <div className={`ranking-layout ${isSidebarCollapsed ? "ranking-layout-collapsed" : ""}`}>
        <DesktopFilters
          collapsed={isSidebarCollapsed}
          filters={filters}
          languageOptions={filterOptions.languages}
          topicOptions={filterOptions.topics}
          onChange={changeFilters}
          onToggle={() => setIsSidebarCollapsed((collapsed) => !collapsed)}
        />
        <div className="ranking-content">
          <button
            className="mobile-filter-trigger"
            onClick={() => setIsMobileFiltersOpen(true)}
            type="button"
          >
            <FilterIcon size={16} />
            {t("filters.label")}
            {filterCount === 0 ? null : <strong>{filterCount}</strong>}
          </button>
          <section
            aria-busy={isSnapshotLoading}
            className={`ranking-board ${isSnapshotLoading ? "ranking-board-loading" : ""}`}
            aria-label={t("ranking.label")}
          >
        <div className="board-heading">
          <div className="board-title">
            <RepoIcon size={18} />
            <div>
              <RankingViewHeading
                buttonLabel={t("ranking.viewInformation", { view: viewCopy.title })}
                description={viewCopy.description}
                isMethodologyOpen={isMethodologyOpen}
                onOpenMethodology={() => setIsMethodologyOpen(true)}
                title={viewCopy.title}
              />
              <p>{sourceLabel(selectedSnapshot.source, locale)}</p>
            </div>
          </div>
          <div className="board-status">
            {isSnapshotLoading ? (
              <span className="snapshot-loading" role="status">
                <span className="snapshot-loading-spinner" />{t("ranking.updating")}
              </span>
            ) : null}
            <span className="result-count">
              {rankingView === "momentum"
                ? filterCount === 0
                  ? t("ranking.repositories", { count: selectedSnapshot.repository_count })
                  : t("ranking.filteredRepositories", {
                    matching: selectedSnapshot.matching_count,
                    total: selectedSnapshot.repository_count,
                  })
                : rankingView === "github"
                  ? t("ranking.trendingRepositories", { count: selectedSnapshot.matching_count })
                  : t("ranking.scoredRepositories", { count: selectedSnapshot.matching_count })}
            </span>
          </div>
        </div>

        <div className="ranking-view-tabs" role="tablist" aria-label={t("ranking.model")}>
          {RANKING_VIEW_ORDER.map((view) => (
            <button
              aria-describedby="ranking-view-description"
              aria-selected={rankingView === view}
              className={rankingView === view ? "ranking-view-active" : ""}
              disabled={(view === "breakout" || view === "current") && !intelligenceAvailable}
              key={view}
              onClick={() => changeRankingView(view)}
              role="tab"
              type="button"
            >{t(RANKING_VIEW_LABEL_KEYS[view])}</button>
          ))}
        </div>

        {rankingView === "github" ? (
          <div className="ranking-view-options">
            <div className="trending-period-tabs" role="group" aria-label={t("ranking.githubPeriod")}>
              {GITHUB_TRENDING_PERIODS.map((period) => (
                <button
                  aria-pressed={trendingPeriod === period}
                  className={trendingPeriod === period ? "trending-period-active" : ""}
                  key={period}
                  onClick={() => changeTrendingPeriod(period)}
                  type="button"
                >{t(GITHUB_TRENDING_PERIOD_LABEL_KEYS[period])}</button>
              ))}
            </div>
          </div>
        ) : null}

        {snapshotError === null ? null : (
          <p className="snapshot-error" role="alert">{snapshotError}</p>
        )}

        <div className="column-heading" aria-hidden="true">
          <span>{t("ranking.column.rank")}</span>
          <span>{t("ranking.column.card")}</span>
          <span>{t("ranking.column.repository")}</span>
          <span>{t("ranking.column.language")}</span>
          <span className="stars-heading"><StarIcon size={12} />{t("ranking.column.stars")}</span>
          <span>{t("ranking.column.gained")}</span>
        </div>

        {repositories.length === 0 ? (
          <div className="filter-empty-state">
            <h3>{rankingView === "github"
              ? t("ranking.emptyTrending")
              : rankingView === "momentum"
                ? t("ranking.emptyFiltered")
                : rankingView === "breakout"
                  ? t("ranking.emptyBreakout")
                  : t("ranking.emptyEvidence")}</h3>
            <p>{rankingView === "github"
              ? t("ranking.tryTrendingPeriod")
              : rankingView === "momentum"
                ? t("ranking.tryFilters")
                : rankingView === "breakout"
                  ? t("ranking.waitBreakout")
                  : t("ranking.waitEvidence")}</p>
            {filterCount > 0 ? (
              <button type="button" onClick={() => changeFilters({ language: null, topic: null })}>
                {t("ranking.clearFilters")}
              </button>
            ) : rankingView === "breakout" ? (
              <button type="button" onClick={() => changeRankingView("momentum")}>
                {t("ranking.viewMomentum")}
              </button>
            ) : null}
          </div>
        ) : (
          <ol
            className="ranking-list"
            start={start + 1}
            key={`${selectedSnapshot.id}-${rankingView}-${trendingPeriod}-${currentPage}-${filters.language ?? "all"}-${filters.topic ?? "all"}`}
          >
            {repositories.map((repository, rowIndex) => (
              <RankingRow
                repository={repository}
                displayRank={rankingView === "github"
                  ? requireDisplayValue(
                    repository.official_ranks[trendingPeriod],
                    `official_ranks.${trendingPeriod}`,
                    repository.full_name,
                  )
                  : start + rowIndex + 1}
                rankingView={rankingView}
                rowIndex={rowIndex}
                starSeries={starSeries}
                isRead={readRepositories.has(repository.full_name.toLocaleLowerCase("en-US"))}
                onRead={onRead}
                key={repository.full_name}
              />
            ))}
          </ol>
        )}

        {totalPages === 0 ? null : (
          <div className="board-footer">
            <Pagination
              currentPage={currentPage}
              totalPages={totalPages}
              onPageChange={changePage}
            />
          </div>
        )}
          </section>
        </div>
      </div>
      <MobileFilterDialog
        open={isMobileFiltersOpen}
        filters={filters}
        languageOptions={filterOptions.languages}
        topicOptions={filterOptions.topics}
        onChange={changeFilters}
        onClose={() => setIsMobileFiltersOpen(false)}
      />
      <MethodologyDialog
        open={isMethodologyOpen}
        trackRecord={selectedSnapshot.track_record}
        onClose={() => setIsMethodologyOpen(false)}
      />
    </main>
  );
}

export function InitialLoadingState() {
  const { t } = useI18n();
  return (
    <main
      aria-busy="true"
      aria-label={t("loading.rankings")}
      className="page-container initial-loading-state"
    >
      <span className="visually-hidden" role="status">{t("loading.rankings")}</span>
      <section aria-hidden="true" className="loading-skeleton-intro">
        <span className="loading-skeleton-block loading-skeleton-title" />
        <span className="loading-skeleton-block loading-skeleton-meta" />
        <div className="loading-skeleton-timeline">
          <div className="loading-skeleton-timeline-heading">
            <span className="loading-skeleton-block" />
            <span className="loading-skeleton-block" />
          </div>
          <span className="loading-skeleton-block loading-skeleton-track" />
        </div>
      </section>
      <div aria-hidden="true" className="loading-skeleton-layout">
        <aside className="loading-skeleton-sidebar">
          <span className="loading-skeleton-block loading-skeleton-sidebar-heading" />
          {Array.from({ length: 7 }, (_, index) => (
            <span className="loading-skeleton-block loading-skeleton-filter" key={index} />
          ))}
        </aside>
        <section className="loading-skeleton-board">
          <div className="loading-skeleton-board-heading">
            <span className="loading-skeleton-block loading-skeleton-board-title" />
            <span className="loading-skeleton-block loading-skeleton-count" />
          </div>
          <div className="loading-skeleton-tabs">
            <span className="loading-skeleton-block" />
            <span className="loading-skeleton-block" />
            <span className="loading-skeleton-block" />
            <span className="loading-skeleton-block" />
          </div>
          {Array.from({ length: 6 }, (_, index) => (
            <div className="loading-skeleton-row" key={index}>
              <span className="loading-skeleton-block loading-skeleton-rank" />
              <span className="loading-skeleton-block loading-skeleton-thumbnail" />
              <div className="loading-skeleton-copy">
                <span className="loading-skeleton-block" />
                <span className="loading-skeleton-block" />
              </div>
              <span className="loading-skeleton-block loading-skeleton-stat" />
              <span className="loading-skeleton-block loading-skeleton-chart" />
            </div>
          ))}
        </section>
      </div>
    </main>
  );
}

export function HeaderTrafficBadge({ state }: { state: TrafficState }) {
  const { locale, t } = useI18n();
  const label = state.status === "loading"
    ? t("traffic.loading")
    : state.status === "unavailable"
      ? t("traffic.unavailable")
      : state.visits === 1
        ? t("traffic.visitToday")
        : t("traffic.visitsToday", {
          count: new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US").format(state.visits),
        });
  const value = state.status === "loading"
    ? "…"
    : state.status === "unavailable"
      ? "—"
      : new Intl.NumberFormat(locale === "ko" ? "ko-KR" : "en-US").format(state.visits);
  return (
    <span
      aria-label={label}
      aria-live="polite"
      className={`header-traffic header-traffic-${state.status}`}
      title={label}
    >
      <PeopleIcon aria-hidden="true" size={16} />
      <span>{value}</span>
    </span>
  );
}

export function SiteFooter() {
  const { t } = useI18n();
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <span className="footer-owner">Changroro</span>
        <nav aria-label={t("footer.links")} className="footer-links">
          <a href="https://github.com/Changroro" rel="noreferrer" target="_blank">
            <MarkGithubIcon size={16} />
            github.com/Changroro
          </a>
          <a href="mailto:chbae624@gmail.com">
            <MailIcon size={16} />
            chbae624@gmail.com
          </a>
        </nav>
      </div>
    </footer>
  );
}

function AppContent({
  locale,
  onLocaleChange,
}: {
  locale: Locale;
  onLocaleChange: (locale: Locale) => void;
}) {
  const { t } = useI18n();
  const [snapshots, setSnapshots] = useState<RankingSnapshotMetadata[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<RankingPageResponse | null>(null);
  const [selectedSnapshotSearch, setSelectedSnapshotSearch] = useState<string | null>(null);
  const [isSnapshotLoading, setIsSnapshotLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [traffic, setTraffic] = useState<TrafficState>({ status: "loading" });
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [readRepositories, setReadRepositories] = useState<ReadonlySet<string>>(() => (
    parseReadRepositories(
      localStorage.getItem(READ_REPOSITORIES_STORAGE_KEY)
        ?? localStorage.getItem(LEGACY_READ_REPOSITORIES_STORAGE_KEY),
    )
  ));
  const [locationPath, setLocationPath] = useState<AppPath>(() => resolveAppPath(window.location.pathname));
  const [locationSearch, setLocationSearch] = useState(window.location.search);
  const rankingLocationSearch = locationPath === "/" ? locationSearch : "";

  useEffect(() => {
    const controller = new AbortController();

    async function loadTraffic() {
      try {
        const response = await fetch("/api/traffic", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Traffic request failed with status ${response.status}`);
        }
        const result = parsePublicTrafficResponse(await response.json());
        setTraffic({ status: "ready", visits: result.visits });
      } catch (trafficError) {
        if (!controller.signal.aborted) {
          console.error(trafficError);
          setTraffic({ status: "unavailable" });
        }
      }
    }

    void loadTraffic();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();

    async function loadTimeline() {
      try {
        const response = await fetch("/api/timeline", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Timeline request failed with status ${response.status}`);
        }
        const timeline = parseTimelineResponse(await response.json());
        const requestedId = window.location.pathname === "/"
          ? new URLSearchParams(window.location.search).get("snapshot")
          : null;
        const resolvedId = resolveSnapshotId(requestedId, timeline.snapshots);
        setSnapshots(timeline.snapshots);
        setSelectedId(resolvedId);
      } catch (caughtError) {
        if (!controller.signal.aborted) {
          setError(caughtError instanceof Error ? caughtError.message : "Unknown history error");
        }
      }
    }

    void loadTimeline();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    function handlePopState() {
      const nextPath = resolveAppPath(window.location.pathname);
      const nextSearch = window.location.search;
      setLocationPath(nextPath);
      setLocationSearch(nextSearch);
      if (snapshots !== null) {
        const requestedId = nextPath === "/"
          ? new URLSearchParams(nextSearch).get("snapshot")
          : null;
        setSelectedId(resolveSnapshotId(requestedId, snapshots));
      }
    }

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [snapshots]);

  useEffect(() => {
    if (selectedId === null) {
      return;
    }
    const snapshotId = selectedId;
    setError(null);
    const controller = new AbortController();
    setIsSnapshotLoading(true);

    async function loadSnapshot() {
      try {
        const isRankingPage = locationPath === "/";
        const filters = isRankingPage
          ? parseRepositoryFilters(rankingLocationSearch)
          : { language: null, topic: null };
        const view = isRankingPage ? parseRankingView(rankingLocationSearch) : "momentum";
        const period = isRankingPage && view === "github"
          ? parseGitHubTrendingPeriod(rankingLocationSearch)
          : null;
        const page = isRankingPage ? requestedPage(rankingLocationSearch) : 1;
        const loadedSearch = isRankingPage
          ? rankingLocationSearch
          : buildRankingHref(
            1,
            snapshotId,
            { language: null, topic: null },
            "momentum",
          );
        const parameters = new URLSearchParams({
          snapshot: snapshotId,
          page: String(page),
          page_size: String(PAGE_SIZE),
          view,
        });
        if (period !== null) parameters.set("period", period);
        if (filters.language !== null) parameters.set("language", filters.language);
        if (filters.topic !== null) parameters.set("topic", filters.topic);
        const response = await fetch(`/api/ranking?${parameters.toString()}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Ranking request failed with status ${response.status}`);
        }
        const snapshot = parseRankingPageResponse(await response.json());
        if (snapshot.id !== snapshotId) {
          throw new Error(`Snapshot response ${snapshot.id} does not match ${snapshotId}`);
        }
        if (shouldFallbackToMomentum({
          isLatestSnapshot: snapshots?.at(-1)?.id === snapshotId,
          view,
          filters,
          matchingCount: snapshot.matching_count,
        })) {
          navigate(
            buildRankingHref(1, snapshotId, filters, "momentum"),
            "replace",
          );
          return;
        }
        setSelectedSnapshot(snapshot);
        setSelectedSnapshotSearch(loadedSearch);
      } catch (caughtError) {
        if (!controller.signal.aborted) {
          setError(caughtError instanceof Error ? caughtError.message : "Unknown snapshot error");
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsSnapshotLoading(false);
        }
      }
    }

    void loadSnapshot();
    return () => controller.abort();
  }, [locationPath, rankingLocationSearch, selectedId, snapshots]);

  function navigate(href: string, mode: RankingNavigationMode) {
    navigateRankingHref(window.history, href, mode);
    setLocationSearch(window.location.search);
  }

  function navigateHome(event: MouseEvent<HTMLAnchorElement>) {
    if (snapshots === null) {
      return;
    }
    const latestSnapshot = snapshots.at(-1);
    if (latestSnapshot === undefined) {
      throw new Error("Ranking timeline must contain a latest snapshot");
    }
    event.preventDefault();
    const rankingHref = buildRankingHref(
      1,
      latestSnapshot.id,
      { language: null, topic: null },
      "breakout",
    );
    window.history.pushState(null, "", `/${rankingHref}`);
    setLocationPath("/");
    setLocationSearch(window.location.search);
    setSelectedId(latestSnapshot.id);
  }

  function navigatePath(event: MouseEvent<HTMLAnchorElement>, path: AppPath) {
    if (path === "/") {
      navigateHome(event);
      return;
    }
    if (snapshots === null) {
      return;
    }
    const latestSnapshot = snapshots.at(-1);
    if (latestSnapshot === undefined) {
      throw new Error("Ranking timeline must contain a latest snapshot");
    }
    event.preventDefault();
    window.history.pushState(null, "", path);
    setLocationPath(path);
    setLocationSearch("");
    setSelectedId(latestSnapshot.id);
  }

  function selectSnapshot(snapshotId: string) {
    if (snapshots === null || !snapshots.some((snapshot) => snapshot.id === snapshotId)) {
      throw new RangeError(`Snapshot ${snapshotId} does not exist`);
    }
    navigate(
      buildRankingHref(
        1,
        snapshotId,
        parseRepositoryFilters(locationSearch),
        parseRankingView(locationSearch),
        parseGitHubTrendingPeriod(locationSearch),
      ),
      "replace",
    );
    setSelectedId(snapshotId);
  }

  function openArchivedSnapshot(event: MouseEvent<HTMLAnchorElement>, snapshotId: string) {
    if (snapshots === null || !snapshots.some((snapshot) => snapshot.id === snapshotId)) {
      throw new RangeError(`Snapshot ${snapshotId} does not exist`);
    }
    event.preventDefault();
    const href = buildRankingHref(
      1,
      snapshotId,
      { language: null, topic: null },
      "breakout",
    );
    window.history.pushState(null, "", `/${href}`);
    setLocationPath("/");
    setLocationSearch(window.location.search);
    setSelectedId(snapshotId);
  }

  function markRepositoryRead(fullName: string) {
    const nextReadRepositories = addReadRepository(readRepositories, fullName);
    localStorage.setItem(
      READ_REPOSITORIES_STORAGE_KEY,
      serializeReadRepositories(nextReadRepositories),
    );
    setReadRepositories(nextReadRepositories);
  }

  const rankingRenderSearch = resolveRankingRenderSearch(
    locationSearch,
    selectedSnapshotSearch,
    selectedSnapshot !== null,
  );

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <a
            className="brand"
            href="/"
            aria-label={t("header.home")}
            onClick={navigateHome}
          >
            <span aria-hidden="true" className="brand-mark" />
            <span>GitBreakout</span>
          </a>
          <div className="header-actions">
            <button
              aria-label={t("header.searchRepositories")}
              className="header-search-button"
              disabled={selectedSnapshot === null}
              onClick={() => setIsSearchOpen(true)}
              type="button"
            >
              <SearchIcon size={18} />
              <span>{t("header.search")}</span>
            </button>
            <HeaderTrafficBadge state={traffic} />
            <LanguageSwitcher locale={locale} onChange={onLocaleChange} />
          </div>
        </div>
        <SiteNavigation currentPath={locationPath} onNavigate={navigatePath} />
      </header>

      {error !== null && selectedSnapshot === null ? (
        <main className="page-container">
          <section className="status-panel" role="alert">
            <h1>{t("status.historyUnavailable")}</h1>
            <p>{error}</p>
          </section>
        </main>
      ) : snapshots === null || selectedId === null || selectedSnapshot === null ? (
        <InitialLoadingState />
      ) : locationPath === "/" ? (
        <RankingPage
          snapshots={snapshots}
          selectedId={selectedId}
          selectedSnapshot={selectedSnapshot}
          isSnapshotLoading={isSnapshotLoading}
          snapshotError={error}
          readRepositories={readRepositories}
          onSelect={selectSnapshot}
          onRead={markRepositoryRead}
          locationSearch={rankingRenderSearch}
          onNavigate={navigate}
        />
      ) : locationPath === "/archive" ? (
        <ArchivePage
          locationSearch={locationSearch}
          readRepositories={readRepositories}
          onRead={markRepositoryRead}
          onNavigate={navigate}
          onOpenSnapshot={openArchivedSnapshot}
        />
      ) : (
        <TrackRecordPage trackRecord={selectedSnapshot.track_record} />
      )}
      {selectedSnapshot === null ? null : (
        <RepositorySearchDialog
          open={isSearchOpen}
          snapshotId={selectedSnapshot.id}
          repositoryCount={selectedSnapshot.repository_count}
          readRepositories={readRepositories}
          onClose={() => setIsSearchOpen(false)}
          onRead={markRepositoryRead}
        />
      )}
      <ThemeButton />
      <SiteFooter />
    </div>
  );
}

export default function App() {
  const [locale, setLocale] = useState<Locale>(() => resolveInitialLocale(
    localStorage.getItem(LOCALE_STORAGE_KEY)
      ?? localStorage.getItem(LEGACY_LOCALE_STORAGE_KEY),
    navigator.languages,
  ));

  useEffect(() => {
    localStorage.setItem(LOCALE_STORAGE_KEY, locale);
    document.documentElement.lang = locale;
    document.title = locale === "ko"
      ? "GitBreakout: 떠오르는 GitHub 저장소 랭킹"
      : "GitBreakout: Rising GitHub repository rankings";
    const description = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    if (description !== null) {
      description.content = locale === "ko"
        ? "GitBreakout은 실제 성장과 활동 신호를 관측해 떠오르는 GitHub 저장소를 찾습니다."
        : "GitBreakout discovers rising GitHub repositories using observed growth, activity, and transparent ranking signals.";
    }
  }, [locale]);

  return (
    <I18nProvider locale={locale}>
      <AppContent locale={locale} onLocaleChange={setLocale} />
    </I18nProvider>
  );
}
