<div align="center">

![Git Breakout](docs/banner.png)

**An open-source ranking that observes real growth and activity signals to find rising GitHub repositories.**

[![License](https://img.shields.io/badge/License-MIT-f1e05a?style=flat-square)](LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Collection](https://img.shields.io/badge/Collection-every%202%20hours-3FB950?style=flat-square)](#collection-and-storage)
[![GitHub Sponsors](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?style=flat-square&logo=githubsponsors)](https://github.com/sponsors/Changroro)

[한국어](README.md) · [Open the service](https://gitbreakout.imbch.dev) · [API health](https://gitbreakout.imbch.dev/rpc/health)

</div>

## Why Git Breakout

GitHub Trending is useful for seeing what is popular now, but established repositories can appear repeatedly while early-stage growth goes unnoticed. Git Breakout combines Trending with recently created and pushed repositories plus public activity events, then emphasizes **recent change** over lifetime popularity.

Git Breakout is not a complete index of every repository on GitHub. It discovers a broad candidate pool within API search limits and builds rankings and star charts only from values it has observed directly.

## Screenshots

### Desktop

<p align="center">
  <img src="docs/screenshots/desktop.png" alt="Git Breakout desktop ranking view" width="960" />
</p>

### Mobile

<p align="center">
  <img src="docs/screenshots/mobile.png" alt="Git Breakout mobile ranking view" width="360" />
</p>

## Features

- **Breakout** finds unusually accelerating repositories first observed below 10,000 stars with no previous Trending history.
- **Momentum** combines observed star growth, lifetime velocity, repository scale, and recent activity for durable strength.
- **Current heat** measures attention right now through star velocity, unique actors, activity diversity, and short-term persistence.
- **GitHub Trending** preserves the collected Daily, Weekly, and Monthly source ranks in a separate view.
- **History** lets visitors inspect past rankings and repository state through two-hour snapshots.
- **Observed star series** draws sparklines from Git Breakout's own snapshots without an external graph service.
- **Archive** retains repositories that leave the latest candidate pool together with their historical snapshots.
- **Track record** verifies whether repositories observed early by Git Breakout later enter GitHub Trending Daily.
- **Discovery UI** includes repository search, language and topic filters, pagination, read-state dimming, Korean and English, responsive layouts, and light and dark themes.

## Data flow

```text
GitHub Trending ─┐
GitHub Search ───┼─→ merge and deduplicate ─→ verify GitHub metadata
GH Archive ──────┘                               │
                                                ▼
                                  calculate growth and activity
                                                │
                                                ▼
                                  PostgreSQL snapshots and archive
                                                │
                                                ▼
                                      API ─→ Git Breakout UI
```

### Candidate sources

| Source | Coverage | Purpose |
| --- | --- | --- |
| GitHub Trending | Current Daily, Weekly, and Monthly lists | Exposure evidence and source rank history |
| GitHub Search | Recently created and pushed repositories | Discovery outside Trending |
| GH Archive | Watch, Fork, PR, Issue, Comment, Push, and Release events | Early event discovery and breadth of attention |
| Previous observations | Candidates that pass the 14-day retention policy | Continued tracking beyond search windows |
| GitHub GraphQL | Stars, forks, issues, language, topics, and push time | Current metadata verification |

GitHub Search returns at most 1,000 results per query, so Git Breakout must not be described as a complete ranking of every GitHub repository. Leaving the candidate pool stops new observations; it does not delete existing snapshots.

## Ranking model

The baseline momentum model is `baseline-v1`.

```text
score = log1p(observedStarsPerDay) × 55
      + log1p(stars / ageDays)     × 28
      + log1p(stars)               × 5
      + log1p(forks)               × 2
      + log1p(openIssues)          × 0.5
      + max(0, 14 - pushAgeDays)
      + firstObservationBonus
```

- A first observation receives a discovery bonus but does not invent growth.
- Observed star velocity begins only after measurements are at least two hours apart.
- GitHub Trending rank is used for discovery and evidence, not added directly to momentum.
- Missing evidence remains `insufficient_data` instead of being converted into a zero score.
- Breakout and Current heat are stored separately under `trend-intelligence-v5-shadow`.

See the [public methodology](docs/methodology.md) for formulas and limitations. The question-mark control beside each ranking view also exposes the current methodology in the web app.

## Collection and storage

- The production collector follows a database-backed schedule and runs about every two hours.
- A server file lock and database lease prevent overlapping runs.
- Aggregated events are retained for 168 hours and evaluated over 1, 6, 24, and 72-hour windows.
- Ranking snapshots and archived observations are retained independently from raw event windows.
- Scheduled collection does not use GitHub Actions.

## Getting started

### Requirements

- Node.js 22 or newer
- npm
- A GitHub API token that can read public repository metadata

### Local development

```bash
git clone https://github.com/Changroro/git-breakout.git
cd git-breakout
npm ci
GITHUB_TOKEN=your_token npm run collect
npm run dev
```

Open `http://localhost:5173`. If no snapshot has been collected, the UI fails loudly with a data requirement instead of silently substituting sample data.

### Verification

```bash
npm test
npm run typecheck
npm run build
```

## Project layout

```text
src/                 React UI, i18n, filters, and ranking views
server/              GitHub collectors, ranking API, and web server
docs/                Brand assets, screenshots, and public methodology
```

Production deployment automation, secret configuration, backup operations, and internal competitive research are not distributed in the public repository.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for responsible vulnerability reporting. Major third-party assets and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Git Breakout is distributed under the [MIT License](LICENSE).

---

<div align="center">
Built by <a href="https://github.com/Changroro">Changroro</a>
</div>

This project is not an official GitHub product and is not affiliated with, sponsored by, or endorsed by GitHub, Inc.
