# Git Breakout methodology

Updated: 2026-09-09

Git Breakout discovers public repositories from GitHub Trending, GitHub Search, recent public activity, and previously observed candidates. It then ranks only values that were observed directly. A missing observation is not replaced with an estimated historical value or a zero.

## Candidate discovery

| Source | Purpose |
| --- | --- |
| GitHub Trending | Preserve the collected Daily, Weekly, and Monthly source ranks |
| GitHub Search | Find recently created and recently pushed repositories outside Trending |
| Public GitHub activity | Add repositories showing recent Watch, Fork, PR, Issue, Comment, Push, or Release activity |
| Previous observations | Continue tracking candidates that pass the retention policy |
| GitHub GraphQL | Verify current stars, forks, issues, language, topics, and push time |
| GitHub Star History API | Acquisition dates of stars that still exist when fetched, used for the star series and breakout self-baseline (not used for discovery) |

GitHub Search returns at most 1,000 results per query. Git Breakout therefore describes its results as rankings within the observed candidate pool, not a complete ranking of every GitHub repository.

## Momentum

The baseline model is `baseline-v1`.

```text
score = log1p(observedStarsPerDay) × 55
      + log1p(stars / ageDays)     × 28
      + log1p(stars)               × 5
      + log1p(forks)               × 2
      + log1p(openIssues)          × 0.5
      + max(0, 14 - pushAgeDays)
      + firstObservationBonus
```

The first observation receives a discovery bonus but produces no growth value. Observed velocity begins only after measurements are at least two hours apart. GitHub Trending rank is used as discovery and verification evidence, not added directly to the momentum score.

## New discoveries and resurgence

The model is `trend-intelligence-v7-shadow`. New discoveries and resurgence are mutually exclusive cohorts, with their own percentile comparisons and provisional top-10% limits. A score is not a probability of future success.

**New discoveries** were first observed below 10,000 stars and have no recorded or current Daily, Weekly, or Monthly Trending appearance. A confirmed resurgence goes to the resurgence cohort even when the repository is small. Missing discovery provenance is not inferred from the current star total. “New” describes discovery within our observations, not necessarily the repository's creation date.

**Resurgence** requires earlier activity, seven quiet completed days, and renewed growth. It uses a single source: GitHub's retained-star acquisition days, not a mixture with observed point-in-time totals. The initial policy is:

- Prior activity: the median daily rate of two to twelve completed weeks before the quiet period; it must be positive.
- Quiet period: each of the seven days immediately before the most recent completed day is at most 50% of the prior activity rate.
- Recovery: the most recent completed day gains at least twice the quiet-period daily average and at least the prior activity rate.
- The completed day must end within 36 hours of collection. At least 22 contiguous completed days are needed. Missing, stale or incomplete history cannot establish resurgence.

For example, a prior rate of 20/day, seven days at 2/day, and a completed day of 25 qualifies. A steady 20/day does not. These are initial policy thresholds, not empirically calibrated detection guarantees. Each classified resurgence stores the rates, windows and history fetch timestamp that support it.

Both cohorts compare star velocity, relative growth, self-relative growth, acceleration and available event evidence. Observed windows are selected in the order 24h → 6h; if neither exists, the latest completed retained-acquisition day is used, then observations at least two hours apart. The self-baseline uses the median weekly retained acquisitions over up to 12 completed weeks before the recent growth window, with at least two completed weeks required. Missing optional score components remain missing.

A cohort needs at least two scoreable members. Early candidates without a 24-hour observation enter through the top 10%; with 24-hour observations, every score of at least 70 is shown. Classification does not guarantee display: a repository must also pass its cohort's score threshold.

Older snapshots keep their original scores and display “Earlier breakout”. They are not retroactively relabeled as new discoveries or resurging repositories. A new empty discovery board stays empty instead of automatically switching models.

The Star History API groups stars that still exist by the acquisition date GitHub reports. Removing a star later can reduce an older bucket. These values are never anchored to a current total or joined into a line of past point-in-time totals.

Each collection reads the remaining GitHub quota and refreshes histories within its budget. The collector's history cache must be on persistent storage across one-shot containers. Web requests return cached retained-acquisition history or observed totals immediately, with the appropriate source label. Cold or stale history refreshes in the background with at most four concurrent requests and a separate hourly budget. A later request can use the refreshed history; a slow GitHub response does not hold up all charts.

## Current heat

Current heat separates immediate attention from long-term momentum. It uses the strongest complete star-growth window available together with unique actor breadth, activity diversity, and short-term persistence. It does not imply code quality, security, or long-term adoption.

## Evidence and confidence

Every optional trend score records its evidence window, confidence, and missing inputs. Incomplete windows, stale activity data, or undersized comparison cohorts remain partial or `insufficient_data` instead of being silently converted into positive evidence.

Public event archives are treated as lower-bound evidence because event coverage can vary over time. Direct GitHub star snapshots remain the primary source for observed point-in-time growth.

## Verified early discovery

A repository counts as verified early only when its first recorded source was GitHub Search or public activity and it later appears in a collected GitHub Trending Daily snapshot. Lead time is the interval between the two observation timestamps, not GitHub's exact entry time.

Cases with unknown historical provenance, collection gaps, or an initial observation already inside Trending are excluded from conversion denominators.

## Retention and history

Newly observed repositories receive a 14-day grace period. After that period, recent star growth, a recent push, or retained ranking position is required for continued collection. Leaving the candidate pool stops new observations but does not delete existing ranking snapshots. Rediscovered repositories automatically return to active collection.

Star charts cover up to 90 completed days ending at the selected snapshot. When GitHub history is available, the chart is a zero-based cumulative view of stars acquired in that window that still exist when fetched. It is labeled as retained acquisitions and is not a historical total. If GitHub history is unavailable, the chart instead shows Git Breakout's point-in-time observations and labels them as observed. The two sources are never joined into one line, and days that are still in progress are not drawn.
