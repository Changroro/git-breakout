<div align="center">

![GitBreakout](docs/banner.png)

**An open-source ranking that observes real growth and activity signals to find rising GitHub repositories.**

[![License](https://img.shields.io/badge/License-MIT-f1e05a?style=flat-square)](LICENSE)
[![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-7-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Collection](https://img.shields.io/badge/Collection-every%202%20hours-3FB950?style=flat-square)](#collection-and-storage)

[한국어](README.md) · [Open the service](https://gitbreakout.imbch.dev) · [API health](https://gitbreakout.imbch.dev/rpc/health)

</div>

## Why GitBreakout

GitHub Trending is useful for seeing what is popular now, but established repositories can appear repeatedly while early-stage growth goes unnoticed. GitBreakout combines Trending with recently created and pushed repositories plus public activity events, then emphasizes **recent change** over lifetime popularity.

GitBreakout is not a complete index of every repository on GitHub. It discovers a broad candidate pool within API search limits and builds rankings and star charts only from values it has observed directly.

## Screenshots

| Desktop | Mobile |
| :---: | :---: |
| ![GitBreakout desktop](docs/screenshots/desktop.png) | ![GitBreakout mobile](docs/screenshots/mobile.png) |

## Features

- **Breakout** finds unusually accelerating repositories first observed below 10,000 stars with no previous Trending history.
- **Momentum** combines observed star growth, lifetime velocity, repository scale, and recent activity for durable strength.
- **Current heat** measures attention right now through star velocity, unique actors, activity diversity, and short-term persistence.
- **GitHub Trending** preserves the collected Daily, Weekly, and Monthly source ranks in a separate view.
- **History** lets visitors inspect past rankings and repository state through two-hour snapshots.
- **Observed star series** draws sparklines from GitBreakout's own snapshots without an external graph service.
- **Archive** retains repositories that leave the latest candidate pool together with their historical snapshots.
- **Track record** verifies whether repositories observed early by GitBreakout later enter GitHub Trending Daily.
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
                                      API ─→ GitBreakout UI
```

### Candidate sources

| Source | Coverage | Purpose |
| --- | --- | --- |
| GitHub Trending | Current Daily, Weekly, and Monthly lists | Exposure evidence and source rank history |
| GitHub Search | Recently created and pushed repositories | Discovery outside Trending |
| GH Archive | Watch, Fork, PR, Issue, Comment, Push, and Release events | Early event discovery and breadth of attention |
| Previous observations | Candidates that pass the 14-day retention policy | Continued tracking beyond search windows |
| GitHub GraphQL | Stars, forks, issues, language, topics, and push time | Current metadata verification |

GitHub Search returns at most 1,000 results per query, so GitBreakout must not be described as a complete ranking of every GitHub repository. Leaving the candidate pool stops new observations; it does not delete existing snapshots.

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

See the [Trend Intelligence research note](docs/research/trend-intelligence-v2.md) for model comparisons and limitations. The question-mark control beside each ranking view also exposes the current methodology in the web app.

## Collection and storage

- The production collector follows a database-backed schedule and runs about every two hours.
- A server file lock and database lease prevent overlapping runs.
- Aggregated events are retained for 168 hours and evaluated over 1, 6, 24, and 72-hour windows.
- Ranking snapshots and archived observations are retained independently from raw event windows.
- The production stack uses PostgreSQL 17, PostgREST 14, a Node web server, and Cloudflare Tunnel.
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

### Remote collection

```bash
export GITHUB_TOKEN=your_token
export TREND_RADAR_API_URL=https://your-api.example.com
export TREND_RADAR_COLLECTOR_TOKEN=your_collector_jwt
npm run collect:remote
```

`deploy/oracle/.env.example` and `deploy/oracle/cloudflared.yml.example` are self-hosting templates. Never commit real tokens, passwords, or tunnel credentials.

```bash
cp deploy/oracle/.env.example deploy/oracle/.env
cp deploy/oracle/cloudflared.yml.example deploy/oracle/cloudflared.yml
docker compose --env-file deploy/oracle/.env \
  -f deploy/oracle/docker-compose.yml up -d
```

## Project layout

```text
src/                 React UI, i18n, filters, and ranking views
server/              GitHub collectors, ranking API, and web server
deploy/oracle/db/    PostgreSQL schema and migrations
deploy/oracle/       Docker Compose and systemd operations
docs/                Brand assets, screenshots, and research notes
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for responsible vulnerability reporting. Major third-party assets and their licenses are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

GitBreakout is distributed under the [MIT License](LICENSE).

---

<div align="center">
Built by <a href="https://github.com/Changroro">Changroro</a>
</div>

This project is not an official GitHub product and is not affiliated with, sponsored by, or endorsed by GitHub, Inc.
