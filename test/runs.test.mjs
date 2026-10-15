import assert from 'node:assert/strict';
import { test } from 'node:test';
import { darkStreak, isIgnoredWorkflow, LightError, lightsForRepo, repoLight } from '../index.mjs';

const NOW = Date.parse('2026-10-15T12:00:00Z');
const day = (n) => new Date(NOW - n * 86_400_000).toISOString();
const ci = { id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' };
let next = 100;
const run = (over) => ({
  id: next++,
  workflow_id: 1,
  event: 'push',
  head_branch: 'main',
  status: 'completed',
  conclusion: 'success',
  created_at: day(1),
  run_attempt: 1,
  ...over,
});
const pick = (runs, extra = {}) =>
  lightsForRepo({ workflows: [ci], files: new Set([ci.path]), runs, branch: 'main', now: NOW, ...extra });

test('newest completed push run on the default branch decides', () => {
  const [l] = pick([run({ conclusion: 'failure', created_at: day(3) }), run({ created_at: day(1) })]);
  assert.equal(l.light, 'lit');
  assert.equal(l.workflow, 'CI');
});

test('cancelled and skipped latest runs are dark', () => {
  assert.equal(pick([run({ conclusion: 'cancelled' })])[0].light, 'dark');
  assert.equal(pick([run({ conclusion: 'skipped' })])[0].light, 'dark');
  assert.equal(pick([run({ conclusion: 'neutral' })])[0].light, 'dark');
});

test('other branches, PR events, unfinished and old runs do not count', () => {
  const runs = [
    run({ conclusion: 'success', created_at: day(5) }),
    run({ conclusion: 'failure', head_branch: 'feature', created_at: day(1) }),
    run({ conclusion: 'failure', event: 'pull_request', created_at: day(1) }),
    run({ conclusion: null, status: 'in_progress', created_at: day(0) }),
    run({ conclusion: 'failure', created_at: day(31) }),
  ];
  const [l] = pick(runs);
  assert.equal(l.light, 'lit');
  assert.equal(pick([run({ conclusion: 'failure', created_at: day(31) })]).length, 0, 'outside 30 days: no light');
});

test('schedule runs count, workflow_dispatch does not by default', () => {
  assert.equal(pick([run({ event: 'schedule', conclusion: 'failure' })])[0].light, 'dark');
  assert.equal(pick([run({ event: 'workflow_dispatch', conclusion: 'failure' })]).length, 0);
  assert.equal(
    pick([run({ event: 'workflow_dispatch', conclusion: 'failure' })], { events: ['workflow_dispatch'] }).length,
    1,
  );
});

test('workflows that are gone, disabled or ignored never keep a repo dark', () => {
  const pages = {
    id: 2,
    name: 'pages-build-deployment',
    path: 'dynamic/pages/pages-build-deployment',
    state: 'active',
  };
  const dep = { id: 3, name: 'Dependabot Updates', path: 'dynamic/dependabot/dependabot-updates', state: 'active' };
  const deleted = { id: 4, name: 'Old', path: '.github/workflows/old.yml', state: 'active' };
  const disabled = { id: 5, name: 'Off', path: '.github/workflows/off.yml', state: 'disabled_manually' };
  const lights = lightsForRepo({
    workflows: [ci, pages, dep, deleted, disabled],
    files: [ci.path, disabled.path],
    runs: [run({}), ...[2, 3, 4, 5].map((id) => run({ workflow_id: id, conclusion: 'failure' }))],
    branch: 'main',
    now: NOW,
  });
  assert.deepEqual(
    lights.map((l) => l.workflow),
    ['CI'],
  );
  assert.equal(repoLight(lights), 'lit');
});

test('empty workflows dir (404) drops everything; no files list skips the check', () => {
  assert.equal(pick([run({})], { files: new Set() }).length, 0);
  assert.equal(lightsForRepo({ workflows: [ci], runs: [run({})], branch: 'main', now: NOW }).length, 1);
});

test('re-runs: the latest attempt wins, even with the same created_at', () => {
  const created = day(2);
  const first = run({ id: 7, conclusion: 'failure', run_attempt: 1, created_at: created });
  const rerun = { ...first, conclusion: 'success', run_attempt: 2, run_started_at: day(0.5) };
  const [l] = pick([first, rerun]);
  assert.equal(l.light, 'lit');
  assert.equal(l.run.attempt, 2);
  // a re-run of an old run that finished recently is inside the window
  const old = run({ id: 8, conclusion: 'failure', created_at: day(40), run_started_at: day(1), run_attempt: 3 });
  assert.equal(pick([old])[0].light, 'dark');
  // attempts can arrive in any order
  assert.equal(pick([rerun, first])[0].run.attempt, 2);
});

test('dark streak, darkSince and the capped case', () => {
  const runs = [
    run({ conclusion: 'failure', created_at: day(1) }),
    run({ conclusion: 'cancelled', created_at: day(2) }),
    run({ conclusion: 'success', created_at: day(3), updated_at: day(3) }),
    run({ conclusion: 'failure', created_at: day(4) }),
  ];
  const s = darkStreak(runs);
  assert.equal(s.darkRuns, 2);
  assert.equal(s.darkSince, day(2));
  assert.equal(s.darkSinceCapped, false);
  assert.equal(s.lastLitAt, day(3));
  const capped = darkStreak([
    run({ conclusion: 'failure', created_at: day(1) }),
    run({ conclusion: 'failure', created_at: day(2) }),
  ]);
  assert.equal(capped.darkSinceCapped, true);
  assert.equal(darkStreak([run({})]).darkRuns, 0);
  assert.equal(darkStreak([]).darkRuns, 0);
});

test('repo light: lit only when every workflow is lit, none is an error', () => {
  assert.throws(
    () => repoLight([]),
    (e) => e instanceof LightError && e.code === 'no-run',
  );
  assert.equal(repoLight([{ light: 'lit' }, { light: 'dark' }]), 'dark');
});

test('ignored workflow names', () => {
  assert.equal(isIgnoredWorkflow({ name: 'pages-build-deployment' }), true);
  assert.equal(isIgnoredWorkflow({ name: 'Dependabot auto-merge' }), true);
  assert.equal(isIgnoredWorkflow({ name: 'npm_and_yarn in /. - Update #123', path: 'dynamic/dependabot/x' }), true);
  assert.equal(isIgnoredWorkflow({ name: 'Deploy pages', path: '.github/workflows/pages.yml' }), false);
  assert.equal(isIgnoredWorkflow(null), true);
});
