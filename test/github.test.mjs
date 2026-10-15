import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGitHub, HttpError, LightError, RateLimitError, readLatestPushLight, readRepoLights } from '../index.mjs';

// fake fetch: a queue of responses per call, records requests
function fake(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const r = typeof responses === 'function' ? responses(url, calls.length) : responses.shift();
    if (!r) throw new Error(`unexpected call ${url}`);
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body ?? ''),
    };
  };
  return { fetch, calls };
}

function client(responses, extra = {}) {
  const f = fake(responses);
  const waits = [];
  let clock = Date.parse('2026-10-15T12:00:00Z');
  const gh = createGitHub({
    fetch: f.fetch,
    token: extra.token,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    ...extra,
  });
  return { gh, calls: f.calls, waits, advance: (ms) => (clock += ms), now: () => clock };
}

test('token is optional; when given it is sent as Bearer', async () => {
  const a = client([{ status: 200, body: {} }]);
  await a.gh.get('/x');
  assert.equal(a.calls[0].init.headers.Authorization, undefined);
  const b = client([{ status: 200, body: {} }], { token: 't0k' });
  await b.gh.get('/x');
  assert.equal(b.calls[0].init.headers.Authorization, 'Bearer t0k');
  assert.equal(b.calls[0].init.headers['X-GitHub-Api-Version'], '2022-11-28');
});

test('secondary rate limit: waits retry-after seconds and retries', async () => {
  const c = client([
    { status: 403, headers: { 'retry-after': '3' } },
    { status: 429, headers: { 'retry-after': '1' } },
    { status: 200, body: { ok: 1 } },
  ]);
  assert.deepEqual(await c.gh.get('/x'), { ok: 1 });
  assert.deepEqual(c.waits, [3000, 1000]);
});

test('retry-after as an HTTP date', async () => {
  const c = client((url, n) =>
    n === 1
      ? { status: 429, headers: { 'retry-after': new Date(Date.parse('2026-10-15T12:00:05Z')).toUTCString() } }
      : { status: 200, body: 1 },
  );
  await c.gh.get('/x');
  assert.deepEqual(c.waits, [5000]);
});

test('a retry-after longer than maxWait fails fast and blocks until then', async () => {
  const c = client([{ status: 429, headers: { 'retry-after': '600' } }], { maxWaitMs: 60_000 });
  await assert.rejects(c.gh.get('/x'), (e) => e instanceof RateLimitError && e.budget === true);
  await assert.rejects(c.gh.get('/y'), RateLimitError, 'blocked without calling GitHub');
  assert.equal(c.calls.length, 1);
});

test('primary limit: remaining 0 waits for a near reset, otherwise throws and stays blocked', async () => {
  const soon = Math.floor(Date.parse('2026-10-15T12:00:30Z') / 1000);
  const c = client([
    { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(soon) } },
    { status: 200, body: 'ok' },
  ]);
  assert.equal(await c.gh.get('/x'), 'ok');
  assert.deepEqual(c.waits, [30_000]);

  const later = Math.floor(Date.parse('2026-10-15T13:00:00Z') / 1000);
  const d = client([{ status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(later) } }]);
  await assert.rejects(d.gh.get('/x'), (e) => e instanceof RateLimitError && e.resetAt === later * 1000);
  await assert.rejects(d.gh.get('/x'), RateLimitError);
  assert.equal(d.calls.length, 1);
  d.advance(3_600_000);
  // after the reset it calls GitHub again
  await assert.rejects(d.gh.get('/x'), /unexpected call/);
});

test('remaining 0 with no reset header backs off 15 minutes', async () => {
  const c = client([{ status: 429, headers: { 'x-ratelimit-remaining': '0' } }]);
  await assert.rejects(c.gh.get('/x'), (e) => e instanceof RateLimitError && e.resetAt - c.now() === 15 * 60_000);
});

test('a plain 403 (permissions) is an HttpError, not a rate limit', async () => {
  const c = client([
    { status: 403, headers: { 'x-ratelimit-remaining': '4000' }, body: { message: 'Resource not accessible' } },
  ]);
  await assert.rejects(
    c.gh.get('/x'),
    (e) => e instanceof HttpError && !(e instanceof RateLimitError) && e.status === 403,
  );
});

test('gives up after the retry count', async () => {
  const c = client(() => ({ status: 429, headers: { 'retry-after': '1' } }), { retries: 2 });
  await assert.rejects(c.gh.get('/x'), RateLimitError);
  assert.equal(c.calls.length, 3);
});

test('rate budget floor stops early, but search has its own budget', async () => {
  const c = client(
    () => ({ status: 200, headers: { 'x-ratelimit-remaining': '5', 'x-ratelimit-reset': '1' }, body: {} }),
    { floor: 10 },
  );
  await c.gh.get('/repos/a/b');
  await assert.rejects(c.gh.get('/repos/a/b'), /rate budget low/);
  await c.gh.get('/search/repositories?q=x');
  assert.equal(c.gh.rate.remaining, 5);
});

test('writes only go to allowed repos', async () => {
  const c = client([{ status: 201, body: { number: 1 } }], { writeRepos: ['fitzyracing1/darks'] });
  assert.deepEqual(await c.gh.write('POST', '/repos/fitzyracing1/darks/issues', { title: 't' }), { number: 1 });
  assert.equal(c.calls[0].init.headers['Content-Type'], 'application/json');
  assert.throws(() => c.gh.write('POST', '/repos/someone/else/issues', {}), /refusing to write/);
  assert.throws(() => c.gh.write('POST', '/repos/fitzyracing1/darks-evil/issues', {}), /refusing to write/);
  assert.throws(
    () => createGitHub({ fetch: async () => {} }).write('POST', '/repos/a/b/issues', {}),
    /no repos allowed/,
  );
});

test('readLatestPushLight: SPEC read, no run is an error', async () => {
  const run = { status: 'completed', conclusion: 'cancelled', name: 'CI', html_url: 'u', updated_at: 't' };
  const c = client([
    { status: 200, body: { workflow_runs: [run] } },
    { status: 200, body: { workflow_runs: [] } },
  ]);
  const l = await readLatestPushLight(c.gh, 'fitzyracing1/lit-dark');
  assert.equal(l.light, 'dark');
  assert.match(c.calls[0].url, /per_page=1&status=completed&event=push$/);
  await assert.rejects(
    readLatestPushLight(c.gh, 'fitzyracing1/lit-dark'),
    (e) => e instanceof LightError && e.code === 'no-run',
  );
  await assert.rejects(readLatestPushLight(c.gh, '../etc'), (e) => e.code === 'bad-value');
  await assert.rejects(readLatestPushLight(c.gh, 'a/b/c'), (e) => e.code === 'bad-value');
});

test('readRepoLights: archived skip, 404 workflows dir, pagination stops early', async () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const archived = client([{ status: 200, body: { archived: true, default_branch: 'main' } }]);
  assert.equal((await readRepoLights(archived.gh, 'a/b', { now })).skipped, 'archived');

  const wf = { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' };
  const r = {
    id: 9,
    workflow_id: 1,
    event: 'push',
    head_branch: 'trunk',
    status: 'completed',
    conclusion: 'skipped',
    created_at: '2026-10-14T00:00:00Z',
  };
  const routes = (url) => {
    if (url.endsWith('/repos/a/b')) return { status: 200, body: { default_branch: 'trunk' } };
    if (url.includes('/actions/workflows')) return { status: 200, body: { workflows: [wf] } };
    if (url.includes('/contents/')) return { status: 200, body: [{ path: wf.path }] };
    if (url.includes('/actions/runs')) return { status: 200, body: { workflow_runs: [r] } };
  };
  const c = client(routes);
  const out = await readRepoLights(c.gh, 'a/b', { now });
  assert.equal(out.branch, 'trunk');
  assert.equal(out.lights[0].light, 'dark');
  assert.equal(c.calls.filter((x) => x.url.includes('/actions/runs')).length, 1);
  assert.match(c.calls.at(-1).url, /branch=trunk/);

  const gone = client((url) =>
    url.includes('/contents/') ? { status: 404, body: { message: 'Not Found' } } : routes(url),
  );
  assert.deepEqual((await readRepoLights(gone.gh, 'a/b', { now })).lights, []);
});
