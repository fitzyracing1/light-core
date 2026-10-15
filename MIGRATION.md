# Migrating to light-core

Nothing has been changed in the other repos yet. This is the plan: which lines light-core replaces, and what
behaves differently afterwards. Line numbers are from the commits read on Oct 15, 2026:
light-report `beb7f4c`, lit-dark `c5dc9a0`, light-computer `a121f91`, patch-cloud `dd87c53`.

## Behavior changes (read these first)

1. **add-merged: cancelled, skipped, neutral, stale and action_required are now dark.** Today `lightOf()` returns
   `null` ("no light") for them, so a skipped job is dropped from `runFacts()` and a cancelled run reads `none`.
   With `lightOf()` from light-core they read **dark**, as SPEC.md says. Concretely:
   - a merged-fix entry whose after-merge run was cancelled now shows **dark** instead of looking for the next run
     (`detectLitRun()` skips only `state === 'none'`, so it stops at the cancelled run);
   - a job matched by `--light "<job>"` that was skipped makes the run **dark** instead of being ignored.
   - `detectDarkRun()` still filters out cancelled/skipped runs on purpose (lit-dark `scripts/add-merged.mjs:93`,
     patch-cloud `add-merged.mjs:88`): the "dark before the merge" proof should point at a real failure.
     Keep that filter; it chooses *which* run to cite, it doesn't decide a light.
   - runs still in progress throw `LightError('not-completed')`; catch it and keep showing **waiting**.
2. **No data is an error, never dark.**
   - light-report `lib/lights.mjs:8-18` `toLight()`: a report with no `exitCode` and no `state`, a blank or
     non-numeric exit code, or a state word other than lit/dark/success (e.g. `"passed"`, `"green"`) used to become
     **dark**. With `lightOfExit()` / `asLight()` / `lightOf()` they are rejected (the server should answer 400).
   - light-report `lib/lights.mjs:37-44` `view()`: a light that has never been reported currently shows **dark**.
     It should show *no light yet* (not a lamp). A light whose last report is older than the TTL stays **dark**;
     that's a deliberate light-report policy, now spelled out with `isStale()` instead of hidden in `view()`.
3. **Packing a byte refuses bad input instead of guessing.** light-report `lib/lights.mjs:23-25` and
   light-computer `fetch-lights.mjs:52-54` silently drop lights past the 8th and treat anything that isn't lit
   (including `undefined`) as dark. `pack()` throws on more than 8 lights or on a value that isn't a light.
4. **Which run decides, if a reader switches to `readRepoLights()`** (dark-crawl's rules). Readers that keep the
   SPEC's one-run read use `readLatestPushLight()` and behave exactly as today. Switching gives:
   - Pages deploys, dependabot runs and workflows that are disabled or deleted from the default branch no longer
     decide the light;
   - only default-branch `push` and `schedule` runs within 30 days count; a repo with none has **no light** (error)
     instead of keeping an old one;
   - one light per workflow, and the repo is lit only when every workflow is lit (`repoLight()`), so a repo whose
     newest push run is lit but whose nightly schedule is dark reads **dark**.
5. **Re-runs** (dark-crawl and patch-cloud): the latest attempt of a run wins and runs are ordered by
   `run_started_at`, not `created_at`. A failed run re-run green yesterday is lit even though it was created last
   month; previously the old `created_at` could push it out of the 30-day window or below an older run.
6. **Rate limits.** Everywhere: a `retry-after` (seconds or HTTP date) of up to 120 s is waited out and retried
   (up to 3 times) instead of failing; `x-ratelimit-remaining: 0` waits when the reset is within 120 s, otherwise
   throws `RateLimitError` and refuses further calls until the reset (15 min if GitHub sends no reset). A plain
   403 (permissions) is an `HttpError`, not a rate limit. Today only dark-crawl and patch-cloud handle any of this.
7. **Field names.** patch-cloud `lastPassingAt` → `lastLitAt`; dark-crawl `streak` → `darkRuns`,
   `prevLit` → `lastLitAt !== null`, `run.created_at` → `run.startedAt`. Values are the same except for (5).
8. **add-merged auth.** It shells out to `gh api` synchronously today. light-core's client is async `fetch` with
   `GITHUB_TOKEN`; run it as `GITHUB_TOKEN=$(gh auth token) node scripts/add-merged.mjs …`.

## What gets replaced, file by file

### lit-dark
| Lines | Today | Replace with |
|---|---|---|
| `read-light.mjs:17-38` | fetch newest completed push run, map `conclusion === 'success'` | `readLatestPushLight(createGitHub({ userAgent: 'lit-dark-reader' }), repo)` |
| `scripts/add-merged.mjs:47-51` | `gh()` via `gh api` | `createGitHub().get()` (async; see change 8) |
| `scripts/add-merged.mjs:56-61` | `lightOf(status, conclusion)` with `null` for cancelled/skipped/neutral | `lightOfRun(run)` + catch `not-completed` → `'waiting'` (change 1) |
| `scripts/add-merged.mjs:71-86` | `runFacts()` drops jobs whose light is `null` | keep the function, use `lightOfRun(job)`; no job is dropped any more |
| `SPEC.md` "Consuming a byte of lights" | inline `lightsToByte` example | point to `pack()` / `unpack()` |

### light-report
| Lines | Today | Replace with |
|---|---|---|
| `lib/lights.mjs:8-18` | `toLight()` | `lightOfExit()` for `exitCode`, `asLight()` for `state: lit/dark`, `lightOf()` for GitHub conclusions; invalid → 400 (change 2) |
| `lib/lights.mjs:20` | `toBit` | `toBit` |
| `lib/lights.mjs:23-25` | `lightsToByte` | `pack` (change 3) |
| `lib/lights.mjs:37-44` | `view()` stale/missing → dark | keep `view()`, use `isStale()`; missing → no light (change 2) |
| `lib/github.mjs:4-13` | `readGitHubLight()` | `readLatestPushLight()` (or `readRepoLights()` + `repoLight()`, change 4) |
| `lib/runner.mjs:181` | `exitCode === 0 && !timedOut` | `run.timedOut ? 'dark' : lightOfExit(exitCode)` (same result) |
| `lib/darks.mjs:5-7` | `DAY`, `IGNORE_NAME`, `isIgnoredWorkflow` | `DAY_MS`, `IGNORED_NAME`, `isIgnoredWorkflow` |
| `lib/darks.mjs:14-43` | `lightsForRepo()` | `lightsForRepo()` (changes 5, 7) |
| `bin/dark-crawl.mjs:16-47` | `createGitHub()` with budget, retry-after, `ownRepoWrite` | `createGitHub({ floor: 60, userAgent: 'dark-crawler', writeRepos: [DARKS_REPO] })`; `ownRepoWrite(m, p, b)` → `gh.write(m, p, b)`; `e.budget` checks keep working |
| `bin/dark-crawl.mjs:101-118` | repo meta, archived skip, workflows, contents 404, 3 pages of runs | `readRepoLights(gh, repo)`; keep lines 119-131 (cause + class) as they are |

### light-computer
| Lines | Today | Replace with |
|---|---|---|
| `fetch-lights.mjs:23-41` | `fetchOne()` | `readLatestPushLight()`, mapped to `{ lit: light === 'lit', … }` for `run.mjs` |
| `fetch-lights.mjs:44-49` | `fetchLights()` with `allSettled` | keep `allSettled` (errors stay errors), call the shared client so rate limits are handled (change 6) |
| `fetch-lights.mjs:52-54` | `lightsToByte` | `pack` (change 3); `run.mjs:41` keeps calling it |
| `run.mjs:62,66,98`, `programs.mjs:53-71` | `l.lit` checks | unchanged (still booleans), or `asLight(l)` |

### patch-cloud
| Lines | Today | Replace with |
|---|---|---|
| `server.mjs:81-86` | `noteRateLimit()` + `ghBackoffUntil` | the client's own blocked-until state (change 6) |
| `server.mjs:115-126` | `darkStreakOf()` | `darkStreak()` (changes 5, 7) |
| `server.mjs:128-155` | `fetchOneLight()` (30 push runs, `lit: conclusion === 'success'`) | one `gh.get()` of the same URL, then `lightOfRun(runs[0])` + `darkStreak(runs)`; or `readRepoLights()` (change 4) |
| `server.mjs:157-188` | `refreshLightsFromGitHub()` | keep: the "keep last known light, mark stale" fallback is patch-cloud policy; only the backoff check at the top goes |
| `server.mjs:442-456` | `ghApi()` | `gh.get()` |
| `server.mjs:410-416` | `rewriteMode()` `light.lit === false` | unchanged |
| `add-merged.mjs:42-46, 51-56, 66-81` | copy of lit-dark's `gh()`, `lightOf()`, `runFacts()` | same as lit-dark (change 1); then delete the copy and import from one place |

### uniform, fakegreen
No light code today. The uniform service's GitHub tarball fetch moves to a later `repo-fetch` module, not this one.
