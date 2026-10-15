import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allLit,
  asLight,
  CONCLUSIONS,
  fromBit,
  isStale,
  lamp,
  lamps,
  LightError,
  lightOf,
  lightOfExit,
  lightOfRun,
  pack,
  toBit,
  unpack,
} from '../index.mjs';

const code = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof LightError, `expected LightError, got ${e}`);
    return e.code;
  }
  assert.fail('expected a LightError');
};

test('only success is lit; every other conclusion is dark', () => {
  for (const c of CONCLUSIONS) assert.equal(lightOf(c), c === 'success' ? 'lit' : 'dark', c);
  // the ones add-merged used to treat as "no light"
  for (const c of ['cancelled', 'skipped', 'neutral', 'timed_out', 'startup_failure', 'action_required', 'stale'])
    assert.equal(lightOf(c), 'dark');
  // an unknown future conclusion must not read as lit
  assert.equal(lightOf('some_new_value'), 'dark');
  assert.equal(lightOf('Success'), 'dark');
});

test('no run, no conclusion, unfinished runs are errors, not dark', () => {
  assert.equal(
    code(() => lightOfRun(null)),
    'no-run',
  );
  assert.equal(
    code(() => lightOfRun(undefined)),
    'no-run',
  );
  assert.equal(
    code(() => lightOfRun({ id: 1, status: 'in_progress', conclusion: null })),
    'not-completed',
  );
  assert.equal(
    code(() => lightOfRun({ id: 1, status: 'queued' })),
    'not-completed',
  );
  assert.equal(
    code(() => lightOfRun({ id: 1, status: 'completed', conclusion: null })),
    'no-conclusion',
  );
  assert.equal(
    code(() => lightOf('')),
    'no-conclusion',
  );
  assert.equal(
    code(() => lightOf(0)),
    'bad-value',
  );
  assert.equal(lightOfRun({ status: 'completed', conclusion: 'success' }), 'lit');
  assert.equal(lightOfRun({ conclusion: 'failure' }), 'dark');
});

test('exit codes: 0 lit, other integers dark, blank or junk is an error', () => {
  assert.equal(lightOfExit(0), 'lit');
  assert.equal(lightOfExit('0'), 'lit');
  assert.equal(lightOfExit(1), 'dark');
  assert.equal(lightOfExit(124), 'dark');
  assert.equal(lightOfExit(-1), 'dark');
  for (const bad of [null, undefined, '', '  ', 'abc', 1.5, NaN])
    assert.equal(
      code(() => lightOfExit(bad)),
      'bad-value',
      String(bad),
    );
});

test('light shapes from the existing programs', () => {
  assert.equal(asLight('lit'), 'lit');
  assert.equal(asLight({ light: 'dark' }), 'dark');
  assert.equal(asLight({ lit: true }), 'lit');
  assert.equal(asLight({ lit: false }), 'dark');
  for (const bad of ['green', '', null, {}, { lit: 'yes' }, 0])
    assert.equal(
      code(() => asLight(bad)),
      'bad-value',
    );
});

test('active-low bits and lamps', () => {
  assert.equal(toBit('lit'), 0);
  assert.equal(toBit('dark'), 1);
  assert.equal(fromBit(0), 'lit');
  assert.equal(fromBit(1), 'dark');
  assert.equal(
    code(() => fromBit(2)),
    'bad-value',
  );
  assert.equal(lamp('lit'), '●');
  assert.equal(lamp({ lit: false }), '○');
});

test('pack/unpack: SPEC example ●●●●○○●● is 12, MSB is the first light', () => {
  const lights = ['lit', 'lit', 'lit', 'lit', 'dark', 'dark', 'lit', 'lit'];
  assert.equal(pack(lights), 12);
  assert.deepEqual(unpack(12), lights);
  assert.equal(lamps(12), '●●●●○○●●');
  assert.equal(pack(['dark']), 128);
  assert.equal(pack([]), 0);
  assert.equal(pack(Array(8).fill('dark')), 255);
  assert.deepEqual(unpack(128, 1), ['dark']);
  for (let b = 0; b < 256; b++) assert.equal(pack(unpack(b)), b);
});

test('pack/unpack refuse what would silently lose lights', () => {
  assert.equal(
    code(() => pack(Array(9).fill('lit'))),
    'bad-value',
  );
  assert.equal(
    code(() => pack(['lit', 'green'])),
    'bad-value',
  );
  assert.equal(
    code(() => pack('lit')),
    'bad-value',
  );
  for (const bad of [-1, 256, 1.5, '12'])
    assert.equal(
      code(() => unpack(bad)),
      'bad-value',
    );
  assert.equal(
    code(() => unpack(0, 9)),
    'bad-value',
  );
});

test('allLit and staleness', () => {
  assert.equal(allLit(['lit', { lit: true }]), 'lit');
  assert.equal(allLit(['lit', 'dark']), 'dark');
  assert.equal(
    code(() => allLit([])),
    'no-run',
  );
  const now = Date.parse('2026-10-15T12:00:00Z');
  assert.equal(isStale('2026-10-14T11:59:59Z', 86_400_000, now), true);
  assert.equal(isStale('2026-10-14T12:00:01Z', 86_400_000, now), false);
  assert.equal(isStale('2020-01-01T00:00:00Z', 0, now), false, 'ttl 0 means never stale');
  assert.equal(
    code(() => isStale(null, 1, now)),
    'bad-value',
  );
});
