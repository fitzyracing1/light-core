// Types for light-core. The runtime is plain ESM in src/*.mjs.

export type Light = 'lit' | 'dark';
export declare const LIT: 'lit';
export declare const DARK: 'dark';
export type LightErrorCode = 'no-run' | 'not-completed' | 'no-conclusion' | 'bad-value';

export declare class LightError extends Error {
  code: LightErrorCode;
  constructor(code: LightErrorCode, message: string);
}

export type LightLike = Light | { light: Light } | { lit: boolean };

export interface RunLike {
  id?: number;
  status?: string | null;
  conclusion?: string | null;
  event?: string;
  head_branch?: string;
  workflow_id?: number;
  run_attempt?: number;
  created_at?: string;
  run_started_at?: string;
  updated_at?: string;
  html_url?: string;
  name?: string;
}

export declare const CONCLUSIONS: readonly string[];
export declare function lightOf(conclusion: string | null | undefined): Light;
export declare function lightOfRun(run: RunLike | null | undefined): Light;
export declare function lightOfExit(exitCode: number | string | null | undefined): Light;
export declare function asLight(value: LightLike): Light;
export declare function toBit(light: LightLike): 0 | 1;
export declare function fromBit(bit: 0 | 1): Light;
export declare function lamp(light: LightLike): '●' | '○';
export declare function pack(lights: LightLike[]): number;
export declare function unpack(byte: number, count?: number): Light[];
export declare function lamps(byte: number, count?: number): string;
export declare function allLit(lights: LightLike[]): Light;
export declare function isStale(reportedAt: string, ttlMs: number, now?: number): boolean;

export interface WorkflowLike {
  id: number;
  name?: string;
  path?: string;
  state?: string;
}

export interface DarkStreak {
  darkRuns: number;
  darkSince: string | null;
  darkSinceCapped: boolean;
  lastLitAt: string | null;
}

export interface WorkflowLight extends DarkStreak {
  workflowId: number;
  workflow?: string;
  path?: string;
  light: Light;
  conclusion: string;
  run: { id?: number; url?: string; startedAt?: string; attempt: number; event?: string };
}

export declare const DAY_MS: number;
export declare const IGNORED_NAME: RegExp;
export declare function isIgnoredWorkflow(workflow: WorkflowLike | null | undefined): boolean;
export declare function darkStreak(runs: RunLike[]): DarkStreak;
export declare function lightsForRepo(input: {
  workflows: WorkflowLike[];
  files?: Set<string> | string[];
  runs: RunLike[];
  branch?: string;
  now?: number;
  days?: number;
  events?: string[];
}): WorkflowLight[];
export declare function repoLight(workflowLights: WorkflowLight[]): Light;

export declare const API: string;
export declare class HttpError extends Error {
  status: number;
  constructor(status: number, message: string);
}
export declare class RateLimitError extends HttpError {
  resetAt: number | null;
  budget: true;
}
export declare function checkRepo(repo: string): string;

export interface GitHubOptions {
  token?: string;
  fetch?: typeof fetch;
  userAgent?: string;
  floor?: number;
  maxWaitMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (line: string) => void;
  writeRepos?: string[];
}

export interface GitHub {
  get<T = unknown>(path: string): Promise<T>;
  write<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  rate: { remaining: number; resetAt: number; blockedUntil: number; calls: number };
}

export declare function createGitHub(options?: GitHubOptions): GitHub;
export declare function readLatestPushLight(
  gh: GitHub,
  repo: string,
): Promise<{ repo: string; light: Light; conclusion: string; workflow?: string; url?: string; at?: string }>;
export declare function readRepoLights(
  gh: GitHub,
  repo: string,
  options?: { days?: number; pages?: number; now?: number },
): Promise<{ repo: string; branch: string; skipped?: 'archived' | 'disabled'; lights: WorkflowLight[] }>;

export type { Program, ProgramContext, ProgramResult, Finding } from './program.js';
