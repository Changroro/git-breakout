import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import * as Slider from "@radix-ui/react-slider";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  FilterIcon,
  HistoryIcon,
  MarkGithubIcon,
  MoonIcon,
  RepoIcon,
  SearchIcon,
  SidebarCollapseIcon,
  SidebarExpandIcon,
  StarIcon,
  SunIcon,
  XIcon,
} from "@primer/octicons-react";
import {
  parseRankingSnapshot,
  parseTimelineResponse,
  resolveSnapshotId,
  type RankingSnapshot,
  type RankingSnapshotMetadata,
} from "./lib/history";
import { getVisiblePages, parsePage } from "./lib/pagination";
import {
  buildRankingHref,
  buildRepositoryFilterOptions,
  filterRepositories,
  parseRepositoryFilters,
  type RepositoryFilterOption,
  type RepositoryFilters,
} from "./lib/repository-filters";
import type { RankedRepository } from "./lib/ranking";
import {
  buildSparklinePoints,
  parseStarSeriesResponse,
  type RepositoryStarSeries,
} from "./lib/star-series";

const PAGE_SIZE = 10;
const SNAPSHOT_CACHE_LIMIT = 5;
const DEFAULT_TOPIC_LIMIT = 12;
const SEARCH_TOPIC_LIMIT = 40;
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

type Theme = "light" | "dark";
type StarSeriesState =
  | { status: "loading"; requestKey: string }
  | { status: "ready"; requestKey: string; series: Map<string, RepositoryStarSeries> }
  | { status: "error"; requestKey: string; message: string };

function formatCapturedAt(value: string): string {
  return `${capturedAtFormatter.format(new Date(value))} KST`;
}

function cacheSnapshot(cache: Map<string, RankingSnapshot>, snapshot: RankingSnapshot): void {
  cache.delete(snapshot.id);
  cache.set(snapshot.id, snapshot);
  if (cache.size > SNAPSHOT_CACHE_LIMIT) {
    const oldestId = cache.keys().next().value;
    if (typeof oldestId !== "string") {
      throw new Error("Snapshot cache did not contain an eviction candidate");
    }
    cache.delete(oldestId);
  }
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
  throw new TypeError(`Unknown ranking source ${source}`);
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
  rowIndex,
  starSeries,
}: {
  repository: RankedRepository;
  rowIndex: number;
  starSeries: StarSeriesState;
}) {
  const language = repository.language ?? "-";
  const stars = requireDisplayValue(repository.metrics.stars, "metrics.stars", repository.full_name);
  const series = resolveRepositorySeries(repository.full_name, starSeries);

  return (
    <li className="ranking-row">
      <div
        className="ranking-row-content"
        style={{ "--row-index": rowIndex } as CSSProperties}
      >
        <span className="rank-number" aria-label={`Rank ${repository.rank}`}>
          {repository.rank}
        </span>
        <RepositoryCardThumbnail repository={repository} />
        <div className="repository-copy">
          <a href={repository.url} target="_blank" rel="noreferrer" className="repository-name">
            <RepoIcon size={16} />
            <span>{repository.full_name}</span>
          </a>
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
  snapshotId,
  filters,
}: {
  currentPage: number;
  totalPages: number;
  snapshotId: string;
  filters: RepositoryFilters;
}) {
  const visiblePages = getVisiblePages(currentPage, totalPages);

  return (
    <nav className="pagination" aria-label="Ranking pages">
      {currentPage === 1 ? (
        <span className="page-link page-arrow page-disabled" aria-disabled="true">
          <ChevronLeftIcon size={16} />
        </span>
      ) : (
        <a className="page-link page-arrow" href={buildRankingHref(currentPage - 1, snapshotId, filters)} aria-label="Previous page">
          <ChevronLeftIcon size={16} />
        </a>
      )}
      <div className="page-numbers">
        {visiblePages.map((page) => (
          <a
            className={`page-link page-number ${page === currentPage ? "page-current" : ""} ${Math.abs(page - currentPage) <= 1 ? "page-near" : ""}`}
            href={buildRankingHref(page, snapshotId, filters)}
            aria-current={page === currentPage ? "page" : undefined}
            key={page}
          >
            {page}
          </a>
        ))}
      </div>
      {currentPage === totalPages ? (
        <span className="page-link page-arrow page-disabled" aria-disabled="true">
          <ChevronRightIcon size={16} />
        </span>
      ) : (
        <a className="page-link page-arrow" href={buildRankingHref(currentPage + 1, snapshotId, filters)} aria-label="Next page">
          <ChevronRightIcon size={16} />
        </a>
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
          <p className="filter-options-note">Showing top {DEFAULT_TOPIC_LIMIT}. Search to find more.</p>
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

function RankingPage({
  snapshots,
  selectedId,
  selectedSnapshot,
  isSnapshotLoading,
  snapshotError,
  onSelect,
}: {
  snapshots: readonly RankingSnapshotMetadata[];
  selectedId: string;
  selectedSnapshot: RankingSnapshot;
  isSnapshotLoading: boolean;
  snapshotError: string | null;
  onSelect: (snapshotId: string) => void;
}) {
  const [filters, setFilters] = useState<RepositoryFilters>(() => (
    parseRepositoryFilters(window.location.search)
  ));
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileFiltersOpen, setIsMobileFiltersOpen] = useState(false);
  const filterOptions = useMemo(
    () => buildRepositoryFilterOptions(selectedSnapshot.repositories),
    [selectedSnapshot.repositories],
  );
  const filteredRepositories = useMemo(
    () => filterRepositories(selectedSnapshot.repositories, filters),
    [filters, selectedSnapshot.repositories],
  );
  const totalPages = Math.ceil(filteredRepositories.length / PAGE_SIZE);
  const requestedPage = new URLSearchParams(window.location.search).get("page");
  const currentPage = totalPages === 0 ? 1 : parsePage(requestedPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const repositories = filteredRepositories.slice(start, start + PAGE_SIZE);
  const starSeries = useRepositoryStarSeries(selectedSnapshot.id, repositories);
  const filterCount = activeFilterCount(filters);

  function changeFilters(nextFilters: RepositoryFilters) {
    window.history.replaceState(
      null,
      "",
      buildRankingHref(1, selectedSnapshot.id, nextFilters),
    );
    setFilters(nextFilters);
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
              <h2>Repository momentum</h2>
              <p>{sourceLabel(selectedSnapshot.source)}</p>
            </div>
          </div>
          <div className="board-status">
            {isSnapshotLoading ? (
              <span className="snapshot-loading" role="status">
                <span className="snapshot-loading-spinner" />Updating snapshot
              </span>
            ) : null}
            <span className="result-count">
              {filterCount === 0
                ? `${selectedSnapshot.repositories.length} repositories`
                : `${filteredRepositories.length} of ${selectedSnapshot.repositories.length} repositories`}
            </span>
          </div>
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
            <h3>No repositories match these filters</h3>
            <p>Try another language or topic.</p>
            <button type="button" onClick={() => changeFilters({ language: null, topic: null })}>
              Clear filters
            </button>
          </div>
        ) : (
          <ol
            className="ranking-list"
            start={start + 1}
            key={`${selectedSnapshot.id}-${currentPage}-${filters.language ?? "all"}-${filters.topic ?? "all"}`}
          >
            {repositories.map((repository, rowIndex) => (
              <RankingRow
                repository={repository}
                rowIndex={rowIndex}
                starSeries={starSeries}
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
              snapshotId={selectedSnapshot.id}
              filters={filters}
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

export default function App() {
  const [snapshots, setSnapshots] = useState<RankingSnapshotMetadata[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedSnapshot, setSelectedSnapshot] = useState<RankingSnapshot | null>(null);
  const [isSnapshotLoading, setIsSnapshotLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const snapshotCache = useRef(new Map<string, RankingSnapshot>());

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
    if (selectedId === null) {
      return;
    }
    const snapshotId = selectedId;
    const cachedSnapshot = snapshotCache.current.get(snapshotId);
    setError(null);
    if (cachedSnapshot !== undefined) {
      cacheSnapshot(snapshotCache.current, cachedSnapshot);
      setSelectedSnapshot(cachedSnapshot);
      setIsSnapshotLoading(false);
      return;
    }
    const controller = new AbortController();
    setIsSnapshotLoading(true);

    async function loadSnapshot() {
      try {
        const response = await fetch(`/api/snapshot?${new URLSearchParams({ id: snapshotId })}`, {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Snapshot request failed with status ${response.status}`);
        }
        const snapshot = parseRankingSnapshot(await response.json());
        if (snapshot.id !== snapshotId) {
          throw new Error(`Snapshot response ${snapshot.id} does not match ${snapshotId}`);
        }
        cacheSnapshot(snapshotCache.current, snapshot);
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
  }, [selectedId]);

  function selectSnapshot(snapshotId: string) {
    if (snapshots === null || !snapshots.some((snapshot) => snapshot.id === snapshotId)) {
      throw new RangeError(`Snapshot ${snapshotId} does not exist`);
    }
    window.history.replaceState(
      null,
      "",
      buildRankingHref(1, snapshotId, parseRepositoryFilters(window.location.search)),
    );
    setSelectedId(snapshotId);
  }

  return (
    <div className="app-shell">
      <header className="site-header">
        <div className="header-inner">
          <a className="brand" href="?page=1" aria-label="AI Trend Radar home">
            <MarkGithubIcon size={30} />
            <span>AI Trend Radar</span>
          </a>
          <ThemeButton />
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
        <main className="page-container">
          <p className="loading-state" role="status">Loading ranking history...</p>
        </main>
      ) : (
        <RankingPage
          snapshots={snapshots}
          selectedId={selectedId}
          selectedSnapshot={selectedSnapshot}
          isSnapshotLoading={isSnapshotLoading}
          snapshotError={error}
          onSelect={selectSnapshot}
        />
      )}
    </div>
  );
}
