# light-core

The pieces every light program here needs, in one place, with no dependencies (Node 18+, ESM, TypeScript types).

- **light**: the one rule from [lit-dark SPEC.md](https://github.com/fitzyracing1/lit-dark/blob/main/SPEC.md).
  `success` is lit, every other conclusion (cancelled, skipped, neutral, timed_out, …) is dark. No run, an
  unfinished run or a value I can't read is an error, never dark. Plus the active-low byte: lit = 0, dark = 1.
- **runs**: which run decides a workflow's light (from dark-crawl): default branch, workflows that still exist and
  are active, no Pages or dependabot runs, push and schedule within 30 days, latest re-run attempt wins.
- **github**: one API client. Token optional. Waits out `retry-after` and near `x-ratelimit-reset`s, fails fast and
  stays blocked when the reset is far off, and only writes to repos you list.
- **program**: a type-only sketch of the "program inside a program" interface. No runtime yet.

```js
import { createGitHub, readLatestPushLight, readRepoLights, repoLight, pack, lamps } from '@fitzyracing1/light-core';

const gh = createGitHub(); // uses GITHUB_TOKEN when set
const { light } = await readLatestPushLight(gh, 'fitzyracing1/lit-dark'); // the SPEC's one-run read
const { lights } = await readRepoLights(gh, 'fitzyracing1/fakegreen'); // per workflow, dark-crawl's rules
console.log(light, repoLight(lights), lamps(pack([light, repoLight(lights)]), 2));
```

Not on npm. Install from GitHub: `npm i github:fitzyracing1/light-core`.
[MIGRATION.md](MIGRATION.md) lists what this replaces in light-report, lit-dark, light-computer and patch-cloud,
and what behaves differently.

MIT. Copyright (c) 2026 Joshua Almeida.

## Plans

This project is free, and its license stays as is. Support it through [GitHub Sponsors](https://github.com/sponsors/fitzyracing1):

- **Free**: use the code, community support.
- **Pro ($49/month)**: priority issues and support.
- **Team ($199/month)**: priority support for your team plus early access.
