// The one lit/dark rule (fitzyracing1/lit-dark SPEC.md).
// Map once: conclusion "success" is lit, every other conclusion is dark. After that, only lit and dark.
// Missing data is never dark. No run, a run that hasn't finished, or a value we can't read is an error.

export const LIT = 'lit';
export const DARK = 'dark';

export class LightError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LightError';
    this.code = code;
  }
}

// conclusion strings GitHub uses today; anything else non-empty is still dark (new values must not read as lit)
export const CONCLUSIONS = [
  'success',
  'failure',
  'cancelled',
  'skipped',
  'neutral',
  'timed_out',
  'action_required',
  'stale',
  'startup_failure',
];

export function lightOf(conclusion) {
  if (conclusion === null || conclusion === undefined || conclusion === '') {
    throw new LightError('no-conclusion', 'run has no conclusion yet (not completed), so it has no light');
  }
  if (typeof conclusion !== 'string')
    throw new LightError('bad-value', `conclusion must be a string, got ${typeof conclusion}`);
  return conclusion === 'success' ? LIT : DARK;
}

export function lightOfRun(run) {
  if (!run) throw new LightError('no-run', 'no run, so no light (an error, not dark)');
  if (run.status && run.status !== 'completed') {
    throw new LightError('not-completed', `run ${run.id ?? '(no id)'} is ${run.status}, so it has no light yet`);
  }
  return lightOf(run.conclusion);
}

// For things that report a process exit code instead of a run (light-report runner, light-run).
export function lightOfExit(exitCode) {
  const code = typeof exitCode === 'string' && exitCode.trim() !== '' ? Number(exitCode) : exitCode;
  if (!Number.isInteger(code))
    throw new LightError('bad-value', `exit code must be an integer, got ${JSON.stringify(exitCode)}`);
  return code === 0 ? LIT : DARK;
}

// Accepts the shapes the existing programs pass around: 'lit' | 'dark', { light }, { lit: boolean }.
export function asLight(value) {
  if (value === LIT || value === DARK) return value;
  if (value && typeof value === 'object') {
    if (value.light === LIT || value.light === DARK) return value.light;
    if (typeof value.lit === 'boolean') return value.lit ? LIT : DARK;
  }
  throw new LightError('bad-value', `not a light: ${JSON.stringify(value)}`);
}

// active-low, like a hardware signal line: lit = 0, dark = 1
export const toBit = (light) => (asLight(light) === LIT ? 0 : 1);

export function fromBit(bit) {
  if (bit === 0) return LIT;
  if (bit === 1) return DARK;
  throw new LightError('bad-value', `bit must be 0 or 1, got ${JSON.stringify(bit)}`);
}

export const lamp = (light) => (asLight(light) === LIT ? '●' : '○');

// Up to 8 lights into one byte, first light = most significant bit. Fewer than 8 leave the low bits 0.
export function pack(lights) {
  if (!Array.isArray(lights)) throw new LightError('bad-value', 'pack() takes an array of lights');
  if (lights.length > 8) throw new LightError('bad-value', `a byte holds 8 lights, got ${lights.length}`);
  return lights.reduce((byte, l, i) => (toBit(l) ? byte | (1 << (7 - i)) : byte), 0);
}

export function unpack(byte, count = 8) {
  if (!Number.isInteger(byte) || byte < 0 || byte > 255)
    throw new LightError('bad-value', `byte must be 0..255, got ${byte}`);
  if (!Number.isInteger(count) || count < 0 || count > 8)
    throw new LightError('bad-value', `count must be 0..8, got ${count}`);
  return Array.from({ length: count }, (_, i) => fromBit((byte >> (7 - i)) & 1));
}

export const lamps = (byte, count = 8) => unpack(byte, count).map(lamp).join('');

// A whole set is lit only when every light in it is lit. An empty set has no light.
export function allLit(lights) {
  if (!lights.length) throw new LightError('no-run', 'no lights to combine');
  return lights.every((l) => asLight(l) === LIT) ? LIT : DARK;
}

// Age check for pushed lights. Deciding what a stale light means (light-report shows it dark) is the caller's call.
export function isStale(reportedAt, ttlMs, now = Date.now()) {
  const t = Date.parse(reportedAt ?? '');
  if (!Number.isFinite(t)) throw new LightError('bad-value', `reportedAt is not a date: ${JSON.stringify(reportedAt)}`);
  return ttlMs > 0 && now - t > ttlMs;
}
