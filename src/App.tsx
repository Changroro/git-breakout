import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
} from "react";
import * as Slider from "@radix-ui/react-slider";
import {
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ClockIcon,
  FilterIcon,
  GraphIcon,
  HistoryIcon,
  MarkGithubIcon,
  MailIcon,
  MoonIcon,
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
  parseRankingView,
  parseRepositoryFilters,
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

const PAGE_SIZE = 10;
const DEFAULT_TOPIC_LIMIT = 12;
const SEARCH_TOPIC_LIMIT = 40;
const SEARCH_RESULT_LIMIT = 10;
const READ_REPOSITORIES_STORAGE_KEY = "github-trend-radar:read-repositories";
const numberFormatter = new Intl.NumberFormat("ko-KR", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const capturedAtFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const timelineDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  month: "short",
  day: "numeric",
});
const evidenceDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "short",
  day: "numeric",
});
const percentageFormatter = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 0,
});

type Theme = "light" | "dark";
type StarSeriesState =
  | { status: "loading"; requestKey: string }
  | { status: "ready"; requestKey: string; series: Map<string, RepositoryStarSeries> }
  | { status: "error"; requestKey: string; message: string };

type RepositorySearchState =
  | { status: "idle"; requestKey: string }
  | { status: "loading"; requestKey: string }
  | { status: "ready"; requestKey: string; response: RepositorySearchResponse }
  | { status: "error"; requestKey: string; message: string };

function formatCapturedAt(value: string): string {
  return `${capturedAtFormatter.format(new Date(value))} KST`;
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
      aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}
    >
      {theme === "light" ? <MoonIcon size={18} /> : <SunIcon size={18} />}
    </button>
  );
}

function requireDisplayValue<T>(value: T | null, field: string, fullName: string): T {
  if (value === null) {
    throw new TypeError(`${field} is required to display ${fullName}`);
  }
  return value;
}

function sourceLabel(source: string): string {
  if (source === "sample") {
    return "Sample snapshot";
  }
  if (source === "github_official") {
    return "Official GitHub Trending";
  }
  if (source === "github_combined") {
    return "Official Trending + GitHub-wide discovery";
  }
  if (source === "github_events_v2_shadow") {
    return "GitHub-wide events + transparent shadow scoring";
  }
  throw new TypeError(`Unknown ranking source ${source}`);
}

const phaseLabels: Record<Exclude<TrendPhase, "insufficient_data">, string> = {
  spark: "Spark",
  breakout: "Breakout",
  hot: "Hot",
  steady: "Steady",
  cooling: "Cooling",
};

function repositoryViewScore(repository: RankedRepository, view: RankingView): number | null {
  if (view === "momentum") return repository.momentum.score;
  const intelligence = trendIntelligenceFor(repository);
  if (intelligence === null) return null;
  return view === "breakout"
    ? intelligence.breakout.score
    : intelligence.current_heat.score;
}

function rankingViewCopy(view: RankingView): { title: string; description: string } {
  if (view === "breakout") {
    return {
      title: "Breakout signals",
      description: "Peer-relative acceleration and independent event breadth",
    };
  }
  if (view === "current") {
    return {
      title: "Current heat",
      description: "Sustained stars, independent actors, and multi-signal activity",
    };
  }
  return { title: "Repository momentum", description: "" };
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

function RepositoryCardThumbnail({ repository }: { repository: RankedRepository }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return <span className="repository-thumbnail repository-thumbnail-error">Preview unavailable</span>;
  }

  return <img
    alt={`${repository.full_name} GitHub repository preview`}
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
        <h2 className="visually-hidden" id="repository-search-title">Search repositories</h2>
        <div className="repository-search-field">
          <SearchIcon size={22} />
          <input
            aria-controls="repository-search-results"
            aria-label="Search repositories"
            autoComplete="off"
            placeholder={`Search ${numberFormatter.format(repositoryCount)} repositories...`}
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
          <button aria-label="Close search" onClick={onClose} type="button">
            <XIcon size={18} />
          </button>
        </div>

        <div className="repository-search-body">
          {normalizedQuery === "" ? (
            <div className="repository-search-empty">
              <SearchIcon size={24} />
              <p>Search by repository name, description, language, or topic.</p>
            </div>
          ) : currentSearchState.status === "loading" || currentSearchState.status === "idle" ? (
            <div className="repository-search-empty" role="status">
              <p>Searching repositories…</p>
            </div>
          ) : currentSearchState.status === "error" ? (
            <div className="repository-search-empty" role="alert">
              <p>{currentSearchState.message}</p>
            </div>
          ) : visibleResults.length === 0 ? (
            <div className="repository-search-empty">
              <p>No repositories found for “{normalizedQuery}”.</p>
            </div>
          ) : (
            <>
              <p className="repository-search-count">
                {totalResults > SEARCH_RESULT_LIMIT
                  ? `Showing ${SEARCH_RESULT_LIMIT} of ${numberFormatter.format(totalResults)} results`
                  : `${numberFormatter.format(totalResults)} results`}
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
                          <span>{repository.description ?? "No description"}</span>
                          <small>
                            {repository.language ?? "Unknown language"}
                            <span><StarIcon size={12} />{numberFormatter.format(stars)}</span>
                          </small>
                        </span>
                        {isRead ? (
                          <span className="repository-search-read"><CheckIcon size={13} />Read</span>
                        ) : null}
                      </a>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </div>

        <div className="repository-search-footer" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Open</span>
          <span><kbd>Esc</kbd> Close</span>
        </div>
      </div>
    </dialog>
  );
}

function formatStarGain(series: RepositoryStarSeries): string {
  if (series.points.length < 2) {
    return "Tracking started";
  }
  const gain = series.points[series.points.length - 1].stars - series.points[0].stars;
  return `${gain > 0 ? "+" : ""}${numberFormatter.format(gain)} since tracked`;
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

export function formatObservedLeadDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) {
    throw new RangeError("Observed lead hours must be a finite non-negative number");
  }
  if (hours < 1) {
    return "<1h";
  }
  if (hours < 24) {
    return `${Math.round(hours)}h`;
  }
  const roundedDays = Math.round(hours / 24 * 10) / 10;
  return `${roundedDays.toLocaleString("en-US", { maximumFractionDigits: 1 })}d`;
}

export function DiscoveryEvidenceBadge({ evidence }: { evidence: DiscoveryEvidence }) {
  if (evidence.outcome !== "verified") {
    return null;
  }
  if (evidence.lead_hours === null) {
    throw new TypeError("Verified discovery evidence requires lead_hours");
  }
  if (evidence.coverage !== "complete") {
    throw new TypeError("Verified discovery evidence requires complete coverage");
  }
  const lead = formatObservedLeadDuration(evidence.lead_hours);
  return (
    <span
      className="discovery-evidence-badge"
      title={`Radar first observed this repository ${lead} before Radar first observed it in GitHub Trending Daily`}
    >
      <ClockIcon size={11} />Observed {lead} before Daily
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
  if (state.status === "loading") {
    return <span className="repository-growth repository-growth-status">Loading history</span>;
  }
  if (state.status === "error") {
    return <span className="repository-growth repository-growth-status" title={state.message}>History failed</span>;
  }
  const series = resolveRepositorySeries(repositoryName, state);
  if (series === null || series.points.length < 2) {
    return <span className="repository-growth repository-growth-status">Tracking started</span>;
  }
  const first = series.points[0];
  const latest = series.points[series.points.length - 1];
  const gain = latest.stars - first.stars;
  const label = formatStarGain(series);
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
        <title>{`${formatCapturedAt(first.captured_at)}: ${first.stars} stars; ${formatCapturedAt(latest.captured_at)}: ${latest.stars} stars; change ${gain}`}</title>
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
        <span className="rank-number" aria-label={`Rank ${displayRank}`}>
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
            {isRead ? <span className="repository-read-label"><CheckIcon size={12} />Read</span> : null}
            <DiscoveryEvidenceBadge evidence={repository.discovery_evidence} />
            {phase === null ? null : (
              <span
                className={`trend-phase trend-phase-${phase}`}
                title={intelligence?.reasons.join(", ") || phaseLabels[phase]}
              >
                {phaseLabels[phase]}
                {rankingView === "momentum" || viewScore === null ? null : ` ${Math.round(viewScore)}`}
              </span>
            )}
          </div>
          <p>{repository.description}</p>
          <div className="mobile-meta">
            <span>{language}</span>
            <span className="mobile-stars"><StarIcon size={12} />{numberFormatter.format(stars)}</span>
            <span className="mobile-star-growth">
              {starSeries.status === "loading"
                ? "Loading history"
                : starSeries.status === "error"
                  ? "History failed"
                  : series === null ? "Tracking started" : formatStarGain(series)}
            </span>
          </div>
        </div>
        <span className="cell language">{language}</span>
        <span className="cell stars">{numberFormatter.format(stars)}</span>
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
  const visiblePages = getVisiblePages(currentPage, totalPages);

  return (
    <nav className="pagination" aria-label="Ranking pages">
      {currentPage === 1 ? (
        <span className="page-link page-arrow page-disabled" aria-disabled="true">
          <ChevronLeftIcon size={16} />
        </span>
      ) : (
        <button className="page-link page-arrow" onClick={() => onPageChange(currentPage - 1)} type="button" aria-label="Previous page">
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
        <button className="page-link page-arrow" onClick={() => onPageChange(currentPage + 1)} type="button" aria-label="Next page">
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
          <h3 id={`${idPrefix}-language-filter-title`}>Language</h3>
          {filters.language === null ? null : (
            <button type="button" onClick={() => onChange({ ...filters, language: null })}>Clear</button>
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
          <h3 id={`${idPrefix}-topic-filter-title`}>Topics</h3>
          {filters.topic === null ? null : (
            <button type="button" onClick={() => onChange({ ...filters, topic: null })}>Clear</button>
          )}
        </div>
        <label className="topic-search">
          <span>Search topics</span>
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
          <p className="filter-options-empty">No topics found</p>
        ) : normalizedSearch === "" && matchingTopics.length > DEFAULT_TOPIC_LIMIT ? (
          <p className="filter-options-note">Showing top {DEFAULT_TOPIC_LIMIT}. Search indexed topics.</p>
        ) : null}
      </section>

      {activeFilterCount(filters) === 0 ? null : (
        <button
          className="clear-filters-button"
          type="button"
          onClick={() => onChange({ language: null, topic: null })}
        >
          Clear all filters
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
  const count = activeFilterCount(filters);
  return (
    <aside className={`filter-sidebar ${collapsed ? "filter-sidebar-collapsed" : ""}`} aria-label="Repository filters">
      <div className="filter-sidebar-heading">
        {collapsed ? null : (
          <span><FilterIcon size={16} />Filters {count === 0 ? null : <strong>{count}</strong>}</span>
        )}
        <button
          aria-label={collapsed ? "Expand filters" : "Collapse filters"}
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
            <h2 id="mobile-filter-title">Filters</h2>
          </div>
          <button aria-label="Close filters" onClick={onClose} type="button"><XIcon size={18} /></button>
        </div>
        <FilterPanel
          idPrefix="mobile"
          filters={filters}
          languageOptions={languageOptions}
          topicOptions={topicOptions}
          onChange={onChange}
        />
        <button className="mobile-filter-done" onClick={onClose} type="button">Show results</button>
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
          <h2 id="timeline-title">History</h2>
        </div>
        <span className="timeline-count">{snapshots.length} snapshots</span>
      </div>
      <div
        className="timeline-scrubber"
        style={{ "--timeline-progress": `${timelineProgress}%` } as CSSProperties}
      >
        <div className="timeline-tooltip" aria-hidden="true">
          <time dateTime={previewSnapshot.captured_at}>
            {formatCapturedAt(previewSnapshot.captured_at)}
          </time>
        </div>
        {snapshots.length === 1 ? (
          <div className="timeline-static-track">
            <span className="timeline-tick timeline-tick-active" />
          </div>
        ) : (
          <Slider.Root
            aria-label="Historical ranking snapshot"
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
              aria-label="Historical ranking snapshot"
              aria-valuetext={formatCapturedAt(previewSnapshot.captured_at)}
              className="timeline-thumb"
            />
          </Slider.Root>
        )}
      </div>
      <div className="timeline-boundaries" aria-hidden="true">
        <span>{timelineDateFormatter.format(new Date(snapshots[0].captured_at))}</span>
        <span>Latest · {timelineDateFormatter.format(new Date(snapshots[snapshots.length - 1].captured_at))}</span>
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
            <span className="methodology-eyebrow">Transparent methodology</span>
            <h2 id="methodology-title">How ranking and discovery evidence work</h2>
          </div>
          <button aria-label="Close methodology" onClick={onClose} type="button">
            <XIcon size={18} />
          </button>
        </header>

        <div className="methodology-body">
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
              <code>trend-intelligence-v3-shadow</code>
            </div>
            <p>
              Each score is 100 times the equal-weight mean of its known components. Missing
              components are omitted rather than replaced with zero.
            </p>
            <div className="methodology-models">
              <div>
                <h4>Breakout</h4>
                <p>
                  Peer-relative star growth, star acceleration, actor acceleration, and unique-actor
                  breadth are converted to percentiles inside the same language, age, and star-size
                  cohort.
                </p>
                <ul>
                  <li>Relative growth: star delta ÷ prior stars, normalized to 24 hours.</li>
                  <li>Star acceleration: 6h/hour − 24h/hour, or 1h − 6h/hour.</li>
                  <li>Actor acceleration: the same short-versus-long rate change for unique actors.</li>
                  <li>Organic breadth: unique actors in the selected event window.</li>
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
            <h3>Windows, confidence, and limits</h3>
            <p>
              Star and event evidence use the longest complete window in the order 24h → 6h → 1h.
              v3 requires positive observed star growth, rejects events older than four hours, and
              requires at least eight comparable repositories for Breakout.
            </p>
            <p>
              Momentum confidence depends on observed star windows and repository metric
              completeness. v3 confidence also depends on event coverage and cohort size; high
              confidence requires a cohort of at least 20, complete 1h/6h/24h star windows, a 24h
              event window, and prior 72h actor evidence.
            </p>
            <p>
              Candidate retention gives new discoveries 14 days, then requires seven-day star
              growth or a push within 30 days. Search pagination, API availability, collection gaps,
              deleted repositories, and GitHub&apos;s changing Trending output can limit coverage.
            </p>
          </section>

          <footer className="methodology-meta">
            <span>Evidence schema {trackRecord.schema_version}</span>
            <span>Generated {formatCapturedAt(trackRecord.generated_at)}</span>
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

function conversionMetric(conversion: TrackRecordConversion): {
  value: string;
  detail: string;
  collecting: boolean;
} {
  if (conversion.eligible === 0) {
    return {
      value: "Collecting evidence",
      detail: "No eligible discoveries yet",
      collecting: true,
    };
  }
  if (conversion.rate === null) {
    throw new TypeError("Eligible conversion evidence requires a rate");
  }
  return {
    value: percentageFormatter.format(conversion.rate),
    detail: `${conversion.converted} of ${conversion.eligible} eligible discoveries`,
    collecting: false,
  };
}

export function TrackRecordSection({ trackRecord }: { trackRecord: TrackRecord }) {
  const [isMethodologyOpen, setIsMethodologyOpen] = useState(false);
  const sevenDay = conversionMetric(trackRecord.conversion_7d);
  const fourteenDay = conversionMetric(trackRecord.conversion_14d);
  const verifiedReady = trackRecord.verified_count > 0;
  const medianLead = trackRecord.median_lead_hours;
  const medianReady = verifiedReady && medianLead !== null;
  const evidenceStart = trackRecord.evidence_started_at === null
    ? "Evidence window is not established"
    : `Evidence since ${evidenceDateFormatter.format(new Date(trackRecord.evidence_started_at))}`;

  return (
    <section className="track-record" aria-labelledby="track-record-title">
      <div className="track-record-heading">
        <div className="track-record-title">
          <TelescopeIcon size={17} />
          <div>
            <h2 id="track-record-title">Track Record</h2>
            <p>Observed before official GitHub Trending</p>
          </div>
        </div>
        <div className="track-record-heading-meta">
          <span>{evidenceStart}</span>
          <button
            aria-controls="ranking-methodology-dialog"
            aria-expanded={isMethodologyOpen}
            aria-haspopup="dialog"
            aria-label="How ranking and discovery evidence work"
            onClick={() => setIsMethodologyOpen(true)}
            title="How ranking and discovery evidence work"
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
            label="Verified early"
            value={verifiedReady ? numberFormatter.format(trackRecord.verified_count) : "Collecting evidence"}
            detail={verifiedReady
              ? `${trackRecord.period_hits.daily} Daily · ${trackRecord.period_hits.weekly} Weekly · ${trackRecord.period_hits.monthly} Monthly`
              : "Legacy and unproven observations are excluded"}
          />
          <TrackRecordMetric
            collecting={!medianReady}
            label="Median observed lead"
            value={medianReady
              ? formatObservedLeadDuration(medianLead)
              : "Collecting evidence"}
            detail={medianReady ? "Observation interval, not exact entry time" : "Waiting for verified Daily entries"}
          />
          <TrackRecordMetric label="7-day follow-through" {...sevenDay} />
          <TrackRecordMetric label="14-day follow-through" {...fourteenDay} />
        </div>

        <div className="track-record-recent">
          <div className="track-record-recent-heading">
            <GraphIcon size={14} />
            <h3>Recent verified</h3>
          </div>
          {trackRecord.recent_hits.length === 0 ? (
            <p className="track-record-empty">Verified outcomes will appear as evidence matures.</p>
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
                    Observed {formatObservedLeadDuration(hit.lead_hours)} before Daily · Daily #{hit.first_trending_rank}
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
  const filters = parseRepositoryFilters(locationSearch);
  const rankingView = parseRankingView(locationSearch);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileFiltersOpen, setIsMobileFiltersOpen] = useState(false);
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
  const viewCopy = rankingViewCopy(rankingView);
  const intelligenceAvailable = selectedSnapshot.intelligence_available;

  function changeFilters(nextFilters: RepositoryFilters) {
    onNavigate(
      buildRankingHref(1, selectedSnapshot.id, nextFilters, rankingView),
      "replace",
    );
  }

  function changeRankingView(nextView: RankingView) {
    if (nextView !== "momentum" && !intelligenceAvailable) {
      throw new Error(`Trend intelligence is unavailable for snapshot ${selectedSnapshot.id}`);
    }
    onNavigate(
      buildRankingHref(1, selectedSnapshot.id, filters, nextView),
      "replace",
    );
  }

  function changePage(nextPage: number) {
    if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > totalPages) {
      throw new RangeError(`Page ${nextPage} must be within the ranking page range`);
    }
    onNavigate(
      buildRankingHref(nextPage, selectedSnapshot.id, filters, rankingView),
      "push",
    );
  }

  return (
    <main className="page-container">
      <section className="page-intro" aria-labelledby="page-title">
        <h1 id="page-title">GitHub Momentum</h1>
        <p className="last-updated">
          <HistoryIcon size={14} />
          <span>
            Last updated <time dateTime={selectedSnapshot.captured_at}>
              {formatCapturedAt(selectedSnapshot.captured_at)}
            </time>
          </span>
        </p>
        <Timeline snapshots={snapshots} selectedId={selectedId} onSelect={onSelect} />
      </section>

      <TrackRecordSection trackRecord={selectedSnapshot.track_record} />

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
            Filters
            {filterCount === 0 ? null : <strong>{filterCount}</strong>}
          </button>
          <section
            aria-busy={isSnapshotLoading}
            className={`ranking-board ${isSnapshotLoading ? "ranking-board-loading" : ""}`}
            aria-label="Repository ranking"
          >
        <div className="board-heading">
          <div className="board-title">
            <RepoIcon size={18} />
            <div>
              <h2>{viewCopy.title}</h2>
              <p>{viewCopy.description || sourceLabel(selectedSnapshot.source)}</p>
            </div>
          </div>
          <div className="board-status">
            {isSnapshotLoading ? (
              <span className="snapshot-loading" role="status">
                <span className="snapshot-loading-spinner" />Updating snapshot
              </span>
            ) : null}
            <span className="result-count">
              {rankingView === "momentum"
                ? filterCount === 0
                  ? `${selectedSnapshot.repository_count} repositories`
                  : `${selectedSnapshot.matching_count} of ${selectedSnapshot.repository_count} repositories`
                : `${selectedSnapshot.matching_count} scored repositories`}
            </span>
          </div>
        </div>

        <div className="ranking-view-tabs" role="tablist" aria-label="Ranking model">
          <button
            aria-selected={rankingView === "momentum"}
            className={rankingView === "momentum" ? "ranking-view-active" : ""}
            onClick={() => changeRankingView("momentum")}
            role="tab"
            type="button"
          >Momentum</button>
          <button
            aria-selected={rankingView === "breakout"}
            className={rankingView === "breakout" ? "ranking-view-active" : ""}
            disabled={!intelligenceAvailable}
            onClick={() => changeRankingView("breakout")}
            role="tab"
            type="button"
          >Breakout</button>
          <button
            aria-selected={rankingView === "current"}
            className={rankingView === "current" ? "ranking-view-active" : ""}
            disabled={!intelligenceAvailable}
            onClick={() => changeRankingView("current")}
            role="tab"
            type="button"
          >Current heat</button>
        </div>

        {snapshotError === null ? null : (
          <p className="snapshot-error" role="alert">{snapshotError}</p>
        )}

        <div className="column-heading" aria-hidden="true">
          <span>Rank</span>
          <span>Card</span>
          <span>Repository</span>
          <span>Language</span>
          <span className="stars-heading"><StarIcon size={12} />Stars</span>
          <span>Stars gained</span>
        </div>

        {repositories.length === 0 ? (
          <div className="filter-empty-state">
            <h3>{rankingView === "momentum"
              ? "No repositories match these filters"
              : "Trend evidence is not ready for this view"}</h3>
            <p>{rankingView === "momentum"
              ? "Try another language or topic."
              : "Repositories remain unranked until fresh GitHub events and peer history are available."}</p>
            {filterCount === 0 ? null : (
              <button type="button" onClick={() => changeFilters({ language: null, topic: null })}>
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <ol
            className="ranking-list"
            start={start + 1}
            key={`${selectedSnapshot.id}-${rankingView}-${currentPage}-${filters.language ?? "all"}-${filters.topic ?? "all"}`}
          >
            {repositories.map((repository, rowIndex) => (
              <RankingRow
                repository={repository}
                displayRank={start + rowIndex + 1}
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
    </main>
  );
}

export function InitialLoadingState() {
  return (
    <main
      aria-busy="true"
      aria-label="Loading repository rankings"
      className="page-container initial-loading-state"
    >
      <span className="visually-hidden" role="status">Loading repository rankings</span>
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
      <section aria-hidden="true" className="loading-skeleton-track-record">
        <div className="loading-skeleton-track-record-heading">
          <span className="loading-skeleton-block" />
          <span className="loading-skeleton-block" />
        </div>
        <div className="loading-skeleton-track-record-metrics">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index}>
              <span className="loading-skeleton-block" />
              <span className="loading-skeleton-block" />
              <span className="loading-skeleton-block" />
            </div>
          ))}
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

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="footer-inner">
        <span className="footer-owner">Changroro</span>
        <nav aria-label="Creator links" className="footer-links">
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

export default function App() {
  const [snapshots, setSnapshots] = useState<RankingSnapshotMetadata[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<RankingPageResponse | null>(null);
  const [isSnapshotLoading, setIsSnapshotLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [readRepositories, setReadRepositories] = useState<ReadonlySet<string>>(() => (
    parseReadRepositories(localStorage.getItem(READ_REPOSITORIES_STORAGE_KEY))
  ));
  const [locationSearch, setLocationSearch] = useState(window.location.search);

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
        const requestedId = new URLSearchParams(window.location.search).get("snapshot");
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
      const nextSearch = window.location.search;
      setLocationSearch(nextSearch);
      if (snapshots !== null) {
        const requestedId = new URLSearchParams(nextSearch).get("snapshot");
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
        const filters = parseRepositoryFilters(locationSearch);
        const view = parseRankingView(locationSearch);
        const page = requestedPage(locationSearch);
        const parameters = new URLSearchParams({
          snapshot: snapshotId,
          page: String(page),
          page_size: String(PAGE_SIZE),
          view,
        });
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
        setSelectedSnapshot(snapshot);
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
  }, [locationSearch, selectedId]);

  function navigate(href: string, mode: RankingNavigationMode) {
    navigateRankingHref(window.history, href, mode);
    setLocationSearch(href);
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
    navigate(
      buildRankingHref(
        1,
        latestSnapshot.id,
        { language: null, topic: null },
        "momentum",
      ),
      "push",
    );
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
      ),
      "replace",
    );
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

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <a
            className="brand"
            href="?page=1"
            aria-label="AI Trend Radar home"
            onClick={navigateHome}
          >
            <MarkGithubIcon size={30} />
            <span>AI Trend Radar</span>
          </a>
          <div className="header-actions">
            <button
              aria-label="Search repositories"
              className="header-search-button"
              disabled={selectedSnapshot === null}
              onClick={() => setIsSearchOpen(true)}
              type="button"
            >
              <SearchIcon size={18} />
              <span>Search</span>
            </button>
            <ThemeButton />
          </div>
        </div>
      </header>

      {error !== null && selectedSnapshot === null ? (
        <main className="page-container">
          <section className="status-panel" role="alert">
            <h1>History unavailable</h1>
            <p>{error}</p>
          </section>
        </main>
      ) : snapshots === null || selectedId === null || selectedSnapshot === null ? (
        <InitialLoadingState />
      ) : (
        <RankingPage
          snapshots={snapshots}
          selectedId={selectedId}
          selectedSnapshot={selectedSnapshot}
          isSnapshotLoading={isSnapshotLoading}
          snapshotError={error}
          readRepositories={readRepositories}
          onSelect={selectSnapshot}
          onRead={markRepositoryRead}
          locationSearch={locationSearch}
          onNavigate={navigate}
        />
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
      <SiteFooter />
    </div>
  );
}
