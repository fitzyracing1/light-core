// Which run decides a workflow's light. Ported from light-report lib/darks.mjs (dark-crawl):
// per workflow that is still active and still on the default branch, the newest completed push/schedule
// run on the default branch within the window. Pages deploys and dependabot don't count.
import { DARK, LightError, lightOf, LIT } from './light.mjs';

export const DAY_MS = 86_400_000;
export const IGNORED_NAME = /^(pages-build-deployment|dependabot.*|.*dependabot updates?)$/i;

export function isIgnoredWorkflow(workflow) {
  if (!workflow) return true;
  const name = String(workflow.name ?? '');
  const path = String(workflow.path ?? '');
  return IGNORED_NAME.test(name) || path.startsWith('dynamic/') || /dependabot/i.test(path);
}

// re-runs keep created_at; run_started_at moves to the latest attempt
const startedAt = (run) => Date.parse(run.run_started_at || run.created_at || run.updated_at || '');

function newestFirst(a, b) {
  return startedAt(b) - startedAt(a) || (b.run_attempt ?? 1) - (a.run_attempt ?? 1) || (b.id ?? 0) - (a.id ?? 0);
}

// The same run can show up once per attempt (pagination, merged pages); keep its latest attempt.
function latestAttempts(runs) {
  const byId = new Map();
  for (const run of runs) {
    const seen = byId.get(run.id);
    if (!seen || (run.run_attempt ?? 1) > (seen.run_attempt ?? 1)) byId.set(run.id, run);
  }
  return [...byId.values()];
}

// Newest first: how many runs in a row are dark, and since when. Capped when no lit run is in the list.
export function darkStreak(runs) {
  const sorted = [...runs].sort(newestFirst);
  if (!sorted.length || lightOf(sorted[0].conclusion) === LIT)
    return { darkRuns: 0, darkSince: null, darkSinceCapped: false, lastLitAt: null };
  let i = 0;
  while (i < sorted.length && lightOf(sorted[i].conclusion) === DARK) i++;
  const first = sorted[i - 1];
  return {
    darkRuns: i,
    darkSince: first.run_started_at || first.created_at || null,
    darkSinceCapped: i === sorted.length,
    lastLitAt: i < sorted.length ? sorted[i].updated_at || sorted[i].created_at || null : null,
  };
}

function liveWorkflows(workflows, files) {
  const live = new Map();
  for (const w of workflows ?? []) {
    if (w.state !== 'active' || isIgnoredWorkflow(w)) continue;
    // a workflow GitHub still lists but whose file is gone from the default branch can't go lit again
    if (files && !hasFile(files, w.path)) continue;
    live.set(w.id, w);
  }
  return live;
}

const hasFile = (files, path) => (files instanceof Set ? files.has(path) : files.includes(path));

function relevantRuns(runs, live, { branch, now, days, events }) {
  const byWorkflow = new Map();
  for (const run of latestAttempts(runs ?? [])) {
    if (!live.has(run.workflow_id)) continue;
    if (!events.includes(run.event)) continue;
    if (branch && run.head_branch !== branch) continue;
    if (run.status && run.status !== 'completed') continue;
    if (!run.conclusion) continue;
    const at = startedAt(run);
    if (!Number.isFinite(at) || now - at > days * DAY_MS) continue;
    if (!byWorkflow.has(run.workflow_id)) byWorkflow.set(run.workflow_id, []);
    byWorkflow.get(run.workflow_id).push(run);
  }
  return byWorkflow;
}

// workflows: GET /repos/:r/actions/workflows; files: paths in .github/workflows on the default branch
// (Set or array; leave it out to skip that check); runs: GET /repos/:r/actions/runs, any order.
export function lightsForRepo({
  workflows,
  files,
  runs,
  branch,
  now = Date.now(),
  days = 30,
  events = ['push', 'schedule'],
}) {
  const live = liveWorkflows(workflows, files);
  const out = [];
  for (const [id, list] of relevantRuns(runs, live, { branch, now, days, events })) {
    list.sort(newestFirst);
    const latest = list[0];
    const w = live.get(id);
    out.push({
      workflowId: id,
      workflow: w.name,
      path: w.path,
      light: lightOf(latest.conclusion),
      conclusion: latest.conclusion,
      run: {
        id: latest.id,
        url: latest.html_url,
        startedAt: latest.run_started_at || latest.created_at,
        attempt: latest.run_attempt ?? 1,
        event: latest.event,
      },
      ...darkStreak(list),
    });
  }
  return out.sort((a, b) => String(a.path).localeCompare(String(b.path)));
}

// One light for the repo: lit only when every relevant workflow is lit. No relevant workflow = error.
export function repoLight(workflowLights) {
  if (!workflowLights.length) throw new LightError('no-run', 'no relevant completed runs, so the repo has no light');
  return workflowLights.every((l) => l.light === LIT) ? LIT : DARK;
}
