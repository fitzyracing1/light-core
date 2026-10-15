// The "program inside a program" interface. Types only for now; there is no runtime yet.
// A program gets a context, may run other programs through it, and returns one light plus findings.
// A thrown error is an error, never dark.
import type { Light, LightLike } from './index.js';

export interface Finding {
  tool: string;
  rule: string;
  severity?: 'high' | 'medium' | 'low';
  file?: string;
  line?: number;
  message: string;
}

export interface ProgramResult {
  light: Light;
  findings: Finding[];
}

export type Capability = 'files' | 'diff' | 'repo' | 'light' | 'run';

export interface ProgramContext {
  dir: string;
  args: Record<string, unknown>;
  // only the capabilities listed in Program.needs are present
  files?: (options?: { include?: string[] }) => Promise<string[]>;
  diff?: (options?: { base?: string }) => Promise<unknown[]>;
  repo?: (spec: { owner: string; repo: string; ref?: string }) => Promise<{ dir: string }>;
  light?: (repo: string) => Promise<Light>;
  // depth and time budgets shrink with every nested call
  run?: (child: Program, args?: Record<string, unknown>) => Promise<ProgramResult & { program: string }>;
  budget: { ms: number; depth: number };
}

export interface Program {
  name: string;
  version?: string;
  needs?: Capability[];
  run(context: ProgramContext): Promise<ProgramResult>;
}

export type Combine = (lights: LightLike[]) => Light;
