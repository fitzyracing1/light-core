// One GitHub API client for every light reader. No dependencies; token optional.
// Rate limits: waits on retry-after (secondary limits) and on x-ratelimit-reset when the wait is short,
// otherwise fails fast with a RateLimitError and refuses further calls until the reset.
import { LightError, lightOfRun } from './light.mjs';
import { lightsForRepo } from './runs.mjs';

export const API = 'https://api.github.com';
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class RateLimitError extends HttpError {
  constructor(status, message, resetAt) {
    super(status, message);
    this.name = 'RateLimitError';
    this.resetAt = resetAt;
    this.budget = true;
  }
}

export function checkRepo(repo) {
  if (typeof repo !== 'string' || !REPO.test(repo) || repo.includes('..'))
    throw new LightError('bad-value', `not an owner/repo: ${JSON.stringify(repo)}`);
  return repo;
}

const header = (res, name) =>
  (typeof res.headers?.get === 'function' ? res.headers.get(name) : res.headers?.[name]) ?? null;

// seconds to wait, or null. retry-after can be seconds or an HTTP date.
function retryAfterMs(res, now) {
  const value = header(res, 'retry-after');
  if (value === null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function rateFrom(res) {
  const remaining = header(res, 'x-ratelimit-remaining');
  const reset = header(res, 'x-ratelimit-reset');
  return {
    remaining: remaining === null ? null : Number(remaining),
    resetAt: reset === null ? null : Number(reset) * 1000,
  };
}

export function createGitHub({
  token = typeof process !== 'undefined' ? process.env.GITHUB_TOKEN : undefined,
  fetch: fetchImpl = globalThis.fetch,
  userAgent = 'light-core',
  floor = 0,
  maxWaitMs = 120_000,
  retries = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  now = () => Date.now(),
  log = () => {},
  writeRepos = [],
} = {}) {
  const state = { remaining: Infinity, resetAt: 0, blockedUntil: 0, calls: 0 };

  function guard(path) {
    if (state.blockedUntil > now()) {
      throw new RateLimitError(
        403,
        `rate limited until ${new Date(state.blockedUntil).toISOString()}`,
        state.blockedUntil,
      );
    }
    // the search API has its own, separate budget
    if (!path.startsWith('/search/') && state.remaining < floor) {
      throw new RateLimitError(403, `rate budget low (${state.remaining} left, floor ${floor})`, state.resetAt);
    }
  }

  async function waitOrThrow(res, path) {
    const rate = rateFrom(res);
    const after = retryAfterMs(res, now());
    if (after !== null) return after;
    if (rate.remaining === 0) {
      const resetAt = rate.resetAt ?? now() + 15 * 60_000;
      const wait = resetAt - now();
      if (wait <= maxWaitMs) return Math.max(0, wait);
      state.blockedUntil = resetAt;
      throw new RateLimitError(
        res.status,
        `rate limit reached on ${path}; resets ${new Date(resetAt).toISOString()}`,
        resetAt,
      );
    }
    return null;
  }

  async function request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      guard(path);
      state.calls++;
      const res = await fetchImpl(API + path, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': userAgent,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const rate = rateFrom(res);
      if (rate.remaining !== null && !path.startsWith('/search/')) {
        state.remaining = rate.remaining;
        state.resetAt = rate.resetAt ?? state.resetAt;
      }
      if (res.ok) return res.status === 204 ? null : res.json();
      if (res.status === 403 || res.status === 429) {
        const wait = await waitOrThrow(res, path);
        if (wait !== null && attempt < retries) {
          if (wait > maxWaitMs) {
            state.blockedUntil = now() + wait;
            throw new RateLimitError(
              res.status,
              `asked to wait ${Math.round(wait / 1000)}s on ${path}`,
              state.blockedUntil,
            );
          }
          log(`github: rate limited on ${path}, waiting ${Math.round(wait / 1000)}s`);
          await sleep(wait);
          continue;
        }
        if (wait !== null)
          throw new RateLimitError(res.status, `still rate limited on ${path} after ${retries} retries`, now() + wait);
      }
      const text = await res.text().catch(() => '');
      throw new HttpError(res.status, `${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`.trim());
    }
  }

  const get = (path) => request('GET', path);

  // Writes only ever go to repos named up front (dark-crawl's ownRepoWrite rule).
  function write(method, path, body) {
    const ok = writeRepos.some((r) => path.startsWith(`/repos/${checkRepo(r)}/`));
    if (!ok)
      throw new Error(`refusing to write outside ${writeRepos.join(', ') || '(no repos allowed)'}: ${method} ${path}`);
    return request(method, path, body);
  }

  return { get, write, rate: state };
}

// SPEC's simple read: newest completed push run of any workflow. Kept for lit-dark/light-computer parity.
export async function readLatestPushLight(gh, repo) {
  checkRepo(repo);
  const data = await gh.get(`/repos/${repo}/actions/runs?per_page=1&status=completed&event=push`);
  const run = data.workflow_runs?.[0];
  if (!run) throw new LightError('no-run', `${repo}: no completed push runs yet`);
  return {
    repo,
    light: lightOfRun(run),
    conclusion: run.conclusion,
    workflow: run.name,
    url: run.html_url,
    at: run.updated_at,
  };
}

// dark-crawl's full read: per workflow, with the relevant-run rules from runs.mjs.
export async function readRepoLights(gh, repo, { days = 30, pages = 3, now = Date.now() } = {}) {
  checkRepo(repo);
  const meta = await gh.get(`/repos/${repo}`);
  if (meta.archived || meta.disabled)
    return { repo, branch: meta.default_branch, skipped: meta.archived ? 'archived' : 'disabled', lights: [] };
  const branch = meta.default_branch;
  const { workflows = [] } = await gh.get(`/repos/${repo}/actions/workflows?per_page=100`);
  if (!workflows.length) return { repo, branch, lights: [] };
  const files = new Set();
  try {
    const dir = await gh.get(`/repos/${repo}/contents/.github/workflows?ref=${encodeURIComponent(branch)}`);
    for (const f of Array.isArray(dir) ? dir : []) files.add(f.path);
  } catch (e) {
    // no workflows directory on the default branch: every listed workflow is gone
    if (e.status !== 404) throw e;
  }
  const since = new Date(now - days * 86_400_000).toISOString().slice(0, 19) + 'Z';
  let runs = [];
  for (let page = 1; page <= pages; page++) {
    const q = `branch=${encodeURIComponent(branch)}&status=completed&per_page=100&page=${page}&created=${encodeURIComponent('>=' + since)}&exclude_pull_requests=true`;
    const j = await gh.get(`/repos/${repo}/actions/runs?${q}`);
    runs = runs.concat(j.workflow_runs ?? []);
    if ((j.workflow_runs ?? []).length < 100) break;
  }
  return { repo, branch, lights: lightsForRepo({ workflows, files, runs, branch, now, days }) };
}
