# Git Breakout methodology

Updated: 2026-09-12

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

The current model is `trend-intelligence-v8-shadow`. New discoveries and resurgence are mutually exclusive cohorts, with their own percentile comparisons and provisional top-10% limits. A score is not a probability of future success.

**New discoveries** were first observed below 10,000 stars and have no recorded or current Daily, Weekly, or Monthly Trending appearance. A confirmed resurgence goes to the resurgence cohort even when the repository is small. Missing discovery provenance is not inferred from the current star total. “New” describes discovery within our observations, not necessarily the repository's creation date.

**Resurgence** requires earlier activity, seven quiet completed days, and renewed growth. It uses a single source: GitHub's retained-star acquisition days, not a mixture with observed point-in-time totals. The initial policy is:

- Prior activity: the median daily rate of two to twelve completed weeks before the quiet period; it must be positive.
- Quiet period: each of the seven days immediately before the most recent completed day is at most 50% of the prior activity rate.
- Recovery: the most recent completed day gains at least twice the quiet-period daily average and at least the prior activity rate.
- The completed day must end within 36 hours of collection. At least 22 contiguous completed days are needed. Missing, stale or incomplete history cannot establish resurgence.

For example, a prior rate of 20/day, seven days at 2/day, and a completed day of 25 qualifies. A steady 20/day does not. These are initial policy thresholds, not empirically calibrated detection guarantees. Each classified resurgence stores the rates, windows and history fetch timestamp that support it.

Both cohorts compare star velocity, relative growth, self-relative growth, acceleration and available event evidence. Observed windows are selected in the order 24h → 6h; if neither exists, the latest completed retained-acquisition day is used, then observations at least two hours apart. The self-baseline uses the median weekly retained acquisitions over up to 12 completed weeks before the recent growth window, with at least two completed weeks required. Missing optional score components remain missing.

In v8, observed growth uses each window's recorded elapsed time rather than its nominal 1h/6h/24h label when detailed window evidence is available. Legacy inputs without that metadata retain nominal durations for compatibility; missing historical timestamps are not reconstructed. The stored evidence includes elapsed hours, the history fetch timestamp, baseline start/end and the gap between the baseline end and the recent growth window. A self-baseline can end earlier than the recent growth window: that gap is disclosed, without a new freshness cutoff. This differs from the 36-hour completed-day freshness requirement used to establish resurgence. Existing scores keep their original version and are not recomputed in place.

A cohort needs at least two scoreable members. Early candidates without a 24-hour observation enter through the top 10%; with 24-hour observations, every score of at least 70 is shown. Classification does not guarantee display: a repository must also pass its cohort's score threshold.

Snapshots that predate the discovery/resurgence split keep their original scores and display “Earlier breakout”. They are not retroactively relabeled as new discoveries or resurging repositories. A new empty discovery board stays empty instead of automatically switching models.

New discoveries remains the default navigation view. Momentum remains available with `baseline-v1`. The default view is a product choice, not evidence that the new model predicts later growth better than Momentum. A future change to model thresholds, weights or default-view policy needs a recorded comparison using frozen origin snapshots and subsequent observations.

The Star History API groups stars that still exist by the acquisition date GitHub reports. Removing a star later can reduce an older bucket. These values are never anchored to a current total or joined into a line of past point-in-time totals.

Each collection reads the remaining GitHub quota and refreshes histories within its budget. The collector's history cache must be on persistent storage across one-shot containers. Web requests return cached retained-acquisition history or observed totals immediately, with the appropriate source label. Cold or stale history refreshes in the background with at most four concurrent requests and a separate hourly budget. A later request can use the refreshed history; a slow GitHub response does not hold up all charts.

## Current heat

Current heat separates immediate attention from long-term momentum. It uses the strongest complete star-growth window available together with unique actor breadth, activity diversity, and short-term persistence. It does not imply code quality, security, or long-term adoption.

These signals reduce dependence on raw star totals, but they are not a fake-star detector. GitHub exposes a new star as a `WatchEvent`, and coordinated accounts can still inflate star velocity, actor breadth, and persistence. Git Breakout therefore describes the result as a multi-signal ranking, not as verified organic activity or manipulation-proof evidence.

Persistence describes the relative rate of short-window and longer-window actor activity. Repeated Watch-only activity can satisfy it; it does not establish sustained development or adoption. Diversity reports how many event categories were present, without claiming those signals are independent.

## Evidence and confidence

Every optional trend score records its evidence window, confidence, and missing inputs. Incomplete windows, stale activity data, or undersized comparison cohorts remain partial or `insufficient_data` instead of being silently converted into positive evidence.

Each ranking row offers expandable score evidence: the score's axis and confidence, known component count and values, missing inputs, readable reasons and available observation/event/history timestamps. Baseline components are weighted contributions; trend components are normalized values shown on a 0–100 scale. When recorded, the actual elapsed star window and the baseline period and gap are shown as well. Missing optional inputs can coexist with a displayed score, so confidence and completeness should be read alongside the number.

Public event archives are treated as lower-bound evidence because event coverage can vary over time. Direct GitHub star snapshots remain the primary source for observed point-in-time growth.

## Verified early discovery

A repository counts as verified early only when its first recorded source was GitHub Search or public activity and it later appears in a collected GitHub Trending Daily snapshot. Lead time is the interval between the two observation timestamps, not GitHub's exact entry time.

Cases with unknown historical provenance, collection gaps, or an initial observation already inside Trending are excluded from conversion denominators.

Track Record evaluates the collector's early observations across its eligible discovery sources. It does not restrict the denominator to repositories displayed in the New discoveries top results and does not establish the predictive quality of that ranking.

Historical rankings preserve the score at the selected snapshot, while discovery outcomes can be evaluated using later observations. The interface distinguishes the ranking timestamp from the outcome evaluation timestamp. Verified badge details show the first observation, first observed Daily appearance and evaluation time; they do not claim GitHub's exact entry time.

## Offline ranking evaluation

`npm run evaluate:ranking -- snapshot-history.json 20` reads a local JSON file and writes an evaluation report to standard output. It makes no network calls and changes no stored snapshots. The output includes the input file's SHA-256, model versions and all evaluation settings so the same input can reproduce the same report.

The input uses `schema_version: "1.0"` and a non-empty `snapshots` array, ordered strictly by `captured_at`. Each snapshot needs a unique `id` and a `repositories` array. Supply immutable, unfiltered snapshot records, not a paginated board or retained-acquisition chart. Each repository needs `full_name`, `metrics.stars` (an observed total or null), and its stored `momentum.score` and `momentum.score_version: "baseline-v1"`. To evaluate a trend model, include the stored `trend_intelligence` with its `score_version`, `confidence`, `missing_evidence`, and `breakout`/`current_heat`/optional `resurgence` objects, each containing `score` and normalized `components`. Other snapshot fields are ignored. Duplicate names within a snapshot, unordered timestamps and invalid numeric values are errors.

For each origin snapshot and model version, the evaluator freezes the scoreable candidate pool and selects the top K from stored scores. It compares those selections with `baseline-v1` top K from the same pool; it does not claim recall over all GitHub repositories or all collected candidates. Follow-up repositories or scores cannot enter the origin selection. Confidence, missing-evidence and star-size strata also come only from the origin snapshot.

The 24-hour and 72-hour outcomes use the first observed total for each selected repository at or after the target, within a three-hour tolerance. The report includes the actual observation time, elapsed hours, signed star delta, growth normalized to a day, follow-up coverage and strata. Observations outside the window are not interpolated. Missing or immature follow-up evidence is reported separately from zero growth; later star losses remain negative. Supply `repository_id` when available: equal immutable ids can connect a rename, while conflicting ids never match even if the name is the same. Legacy name-only matches remain explicitly `name_unverified`.

Component ablation removes one saved normalized component at a time, averages the remaining known values and reports changes in ranks and top-K membership within the original eligible pool. This is a sensitivity test of stored components, not a replay of classification, percentile cohorts or production display thresholds. No value is inferred for a missing component.

Synthetic tests validate the evaluator's contracts, including future-data separation and missing observations. They do not validate empirical ranking quality. A useful evaluation requires representative, sufficiently mature snapshots, explicit coverage reporting and comparison with Momentum before drawing conclusions about thresholds or weights. Follow-up star growth remains an observational proxy, not proof of project usefulness or organic interest.

## Retention and history

Newly observed repositories receive a 14-day grace period. After that period, recent star growth or a recent push is required for continued collection. Eligible repositories are ordered by their last ranking position and limited to the configured retention capacity; a high rank alone does not make an inactive repository eligible. Leaving the candidate pool stops new observations but does not delete existing ranking snapshots. Rediscovered repositories automatically return to active collection.

Legacy history connected by repository name is preserved but labeled as unverified identity when it cannot be tied to an immutable GitHub repository id. A new verified id does not retroactively prove the identity of every older name-based record.

Star charts cover up to 90 completed days ending at the selected snapshot. When GitHub history is available, the chart is a zero-based cumulative view of stars acquired in that window that still exist when fetched. It is labeled as retained acquisitions and is not a historical total. If GitHub history is unavailable, the chart instead shows Git Breakout's point-in-time observations and labels them as observed. The two sources are never joined into one line, and days that are still in progress are not drawn.
