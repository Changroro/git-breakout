import { useEffect, useState, type CSSProperties } from "react";
import * as Slider from "@radix-ui/react-slider";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  HistoryIcon,
  MarkGithubIcon,
  MoonIcon,
  RepoIcon,
  StarIcon,
  SunIcon,
} from "@primer/octicons-react";
import { parseHistoryResponse, resolveSnapshotId, type RankingSnapshot } from "./lib/history";
import { getVisiblePages, parsePage } from "./lib/pagination";
import type { RankedRepository } from "./lib/ranking";

const PAGE_SIZE = 10;
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

function formatCapturedAt(value: string): string {
  return `${capturedAtFormatter.format(new Date(value))} KST`;
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

function growthLabel(repository: RankedRepository) {
  const delta = repository.growth.stars_delta_24h;
  if (delta === null) {
    return repository.firstObservation ? "New" : "—";
  }
  return `+${numberFormatter.format(delta)}`;
}

function sourceLabel(source: string): string {
  if (source === "sample") {
    return "Sample snapshot";
  }
  if (source === "github_official") {
    return "Official GitHub Trending";
  }
  throw new TypeError(`Unknown ranking source ${source}`);
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

function RankingRow({
  repository,
  rowIndex,
}: {
  repository: RankedRepository;
  rowIndex: number;
}) {
  const language = repository.language ?? "—";
  const stars = requireDisplayValue(repository.metrics.stars, "metrics.stars", repository.full_name);

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
            <span className="mobile-growth">24h {growthLabel(repository)}</span>
          </div>
        </div>
        <span className="cell language">{language}</span>
        <span className="cell stars">{numberFormatter.format(stars)}</span>
        <span className={`growth ${repository.growth.stars_delta_24h === null ? "growth-unavailable" : ""}`}>
          {growthLabel(repository)}
        </span>
      </div>
    </li>
  );
}

function pageHref(page: number, snapshotId: string): string {
  const parameters = new URLSearchParams({ page: String(page), snapshot: snapshotId });
  return `?${parameters.toString()}`;
}

function Pagination({
  currentPage,
  totalPages,
  snapshotId,
}: {
  currentPage: number;
  totalPages: number;
  snapshotId: string;
}) {
  const visiblePages = getVisiblePages(currentPage, totalPages);

  return (
    <nav className="pagination" aria-label="Ranking pages">
      {currentPage === 1 ? (
        <span className="page-link page-arrow page-disabled" aria-disabled="true">
          <ChevronLeftIcon size={16} />
        </span>
      ) : (
        <a className="page-link page-arrow" href={pageHref(currentPage - 1, snapshotId)} aria-label="Previous page">
          <ChevronLeftIcon size={16} />
        </a>
      )}
      <div className="page-numbers">
        {visiblePages.map((page) => (
          <a
            className={`page-link page-number ${page === currentPage ? "page-current" : ""} ${Math.abs(page - currentPage) <= 1 ? "page-near" : ""}`}
            href={pageHref(page, snapshotId)}
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
        <a className="page-link page-arrow" href={pageHref(currentPage + 1, snapshotId)} aria-label="Next page">
          <ChevronRightIcon size={16} />
        </a>
      )}
    </nav>
  );
}

function requireSelectedSnapshotIndex(
  snapshots: readonly RankingSnapshot[],
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
  snapshots: readonly RankingSnapshot[];
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
  onSelect,
}: {
  snapshots: readonly RankingSnapshot[];
  selectedId: string;
  onSelect: (snapshotId: string) => void;
}) {
  const selectedSnapshot = snapshots.find((snapshot) => snapshot.id === selectedId);
  if (selectedSnapshot === undefined) {
    throw new RangeError(`Selected snapshot ${selectedId} does not exist`);
  }
  const totalPages = Math.ceil(selectedSnapshot.repositories.length / PAGE_SIZE);
  const requestedPage = new URLSearchParams(window.location.search).get("page");
  const currentPage = parsePage(requestedPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const repositories = selectedSnapshot.repositories.slice(start, start + PAGE_SIZE);

  return (
    <main className="page-container">
      <section className="page-intro" aria-labelledby="page-title">
        <h1 id="page-title">GitHub Trending</h1>
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

      <section className="ranking-board" aria-label="Repository ranking">
        <div className="board-heading">
          <div className="board-title">
            <RepoIcon size={18} />
            <div>
              <h2>Trending repositories</h2>
              <p>{sourceLabel(selectedSnapshot.source)}</p>
            </div>
          </div>
          <span className="result-count">{selectedSnapshot.repositories.length} repositories</span>
        </div>

        <div className="column-heading" aria-hidden="true">
          <span>Rank</span>
          <span>Card</span>
          <span>Repository</span>
          <span>Language</span>
          <span className="stars-heading"><StarIcon size={12} />Stars</span>
          <span>Stars gained (24h)</span>
        </div>

        <ol className="ranking-list" start={start + 1} key={`${selectedId}-${currentPage}`}>
          {repositories.map((repository, rowIndex) => (
            <RankingRow repository={repository} rowIndex={rowIndex} key={repository.full_name} />
          ))}
        </ol>

        <div className="board-footer">
          <Pagination currentPage={currentPage} totalPages={totalPages} snapshotId={selectedId} />
        </div>
      </section>
    </main>
  );
}

export default function App() {
  const [snapshots, setSnapshots] = useState<RankingSnapshot[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadHistory() {
      try {
        const response = await fetch("/api/history", {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`History request failed with status ${response.status}`);
        }
        const history = parseHistoryResponse(await response.json());
        const requestedId = new URLSearchParams(window.location.search).get("snapshot");
        const resolvedId = resolveSnapshotId(requestedId, history.snapshots);
        setSnapshots(history.snapshots);
        setSelectedId(resolvedId);
      } catch (caughtError) {
        if (!controller.signal.aborted) {
          setError(caughtError instanceof Error ? caughtError.message : "Unknown history error");
        }
      }
    }

    void loadHistory();
    return () => controller.abort();
  }, []);

  function selectSnapshot(snapshotId: string) {
    if (snapshots === null || !snapshots.some((snapshot) => snapshot.id === snapshotId)) {
      throw new RangeError(`Snapshot ${snapshotId} does not exist`);
    }
    const parameters = new URLSearchParams({ page: "1", snapshot: snapshotId });
    window.history.replaceState(null, "", `?${parameters.toString()}`);
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

      {error !== null ? (
        <main className="page-container">
          <section className="status-panel" role="alert">
            <h1>History unavailable</h1>
            <p>{error}</p>
          </section>
        </main>
      ) : snapshots === null || selectedId === null ? (
        <main className="page-container">
          <p className="loading-state" role="status">Loading ranking history...</p>
        </main>
      ) : (
        <RankingPage snapshots={snapshots} selectedId={selectedId} onSelect={selectSnapshot} />
      )}
    </div>
  );
}
