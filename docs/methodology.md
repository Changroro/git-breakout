# Git Breakout methodology

Updated: 2026-09-06

Git Breakout discovers public repositories from GitHub Trending, GitHub Search, recent public activity, and previously observed candidates. It then ranks only values that were observed directly. A missing observation is not replaced with an estimated historical value or a zero.

## Candidate discovery

| Source | Purpose |
| --- | --- |
| GitHub Trending | Preserve the collected Daily, Weekly, and Monthly source ranks |
| GitHub Search | Find recently created and recently pushed repositories outside Trending |
| Public GitHub activity | Add repositories showing recent Watch, Fork, PR, Issue, Comment, Push, or Release activity |
| Previous observations | Continue tracking candidates that pass the retention policy |
| GitHub GraphQL | Verify current stars, forks, issues, language, topics, and push time |
| GitHub Star History API | Daily star changes for the star series and the breakout self-baseline (not used for discovery) |

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

## Breakout

`trend-intelligence-v6-shadow` evaluates every repository in the candidate pool with positive recent star growth. Earlier versions excluded repositories first observed above 10,000 stars or with prior Trending history because their past could not be observed; the GitHub Star History API now supplies that past directly, so a repository rising again after a quiet period is evaluated like a new one.

Breakout compares recent star velocity, relative growth, acceleration, and available activity evidence against the candidate pool, and compares the recent day with the repository's own baseline: the median weekly gain over up to 12 completed weeks before the recent window, read from GitHub star history. At least two completed weeks are required for that baseline; younger repositories record `star_history_baseline` as missing evidence and are scored on the remaining components. An exact six-hour observed star window is preferred. Without one, GitHub's most recent completed day provides an exact 24-hour measurement, and observations at least two hours apart provide temporary low-confidence evidence. Early candidates are limited to the top 10% of calculable scores; after 24 hours of Git Breakout's own observations, every candidate scoring at least 70 is shown.

Absolute star counts are not capped. Comparison cohorts by repository size are a planned refinement pending real data.

## Current heat

Current heat separates immediate attention from long-term momentum. It uses the strongest complete star-growth window available together with unique actor breadth, activity diversity, and short-term persistence. It does not imply code quality, security, or long-term adoption.

## Evidence and confidence

Every optional trend score records its evidence window, confidence, and missing inputs. Incomplete windows, stale activity data, or undersized comparison cohorts remain partial or `insufficient_data` instead of being silently converted into positive evidence.

Public event archives are treated as lower-bound evidence because event coverage can vary over time. Direct GitHub star snapshots remain the primary source for observed growth.

## Verified early discovery

A repository counts as verified early only when its first recorded source was GitHub Search or public activity and it later appears in a collected GitHub Trending Daily snapshot. Lead time is the interval between the two observation timestamps, not GitHub's exact entry time.

Cases with unknown historical provenance, collection gaps, or an initial observation already inside Trending are excluded from conversion denominators.

## Retention and history

Newly observed repositories receive a 14-day grace period. After that period, recent star growth, a recent push, or retained ranking position is required for continued collection. Leaving the candidate pool stops new observations but does not delete existing ranking snapshots. Rediscovered repositories automatically return to active collection.

Star charts cover the 90 days ending at the selected snapshot. They combine two exact sources into one series: the daily star changes reported by the GitHub Star History API, anchored to the repository's current stargazer count, and the star counts Git Breakout observed at each collection. Days that are still in progress are not drawn. Ranking signals continue to use only Git Breakout's own observations.
