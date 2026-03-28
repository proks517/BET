# RaceEdge Baseline

- Baseline date: 28 March 2026
- Scope: `raceedge/`
- Note: the recursive file inventory below was captured before this file was created, so `docs/BASELINE.md` is intentionally excluded from the snapshot.

## Current File Structure

| Path | Size (bytes) |
| --- | ---: |
| `.dockerignore` | 45 |
| `.env.example` | 198 |
| `.gitignore` | 35 |
| `client/App.css` | 10014 |
| `client/App.jsx` | 14955 |
| `client/index.html` | 496 |
| `docker-compose.yml` | 313 |
| `Dockerfile` | 749 |
| `package-lock.json` | 162312 |
| `package.json` | 993 |
| `README.md` | 1786 |
| `raceedge.db-shm` | 32768 |
| `raceedge.db-wal` | 12392 |
| `server/database.js` | 3462 |
| `server/index.js` | 4873 |
| `server/predictor.js` | 4655 |
| `server/scraper.js` | 20011 |
| `server/test/database.test.js` | 3187 |
| `server/test/fixtures/racingandsports-race.html` | 657 |
| `server/test/fixtures/thedogs-race.html` | 622 |
| `server/test/predictor.test.js` | 2791 |
| `server/test/scraper.test.js` | 2114 |
| `vite.config.js` | 351 |

## LOC Count

Total `.js` + `.jsx` LOC: **1261**

| File | Lines |
| --- | ---: |
| `client/App.jsx` | 332 |
| `server/database.js` | 75 |
| `server/index.js` | 133 |
| `server/predictor.js` | 99 |
| `server/scraper.js` | 421 |
| `server/test/database.test.js` | 79 |
| `server/test/predictor.test.js` | 55 |
| `server/test/scraper.test.js` | 49 |
| `vite.config.js` | 18 |

## Test Results

Command run: `npm test`

Result summary:

- Status: failed
- Totals: 11 tests, 9 passed, 2 failed
- Failing suites: `server/test/database.test.js`, `server/test/scraper.test.js`
- Immediate causes: missing runtime modules `better-sqlite3` and `cheerio`
- Environment note: an initial sandboxed run failed earlier with `spawn EPERM`; the output saved below is from the unrestricted rerun used for the baseline.

Saved output:

```text
> raceedge@1.0.0 test
> node --test server/test/database.test.js server/test/predictor.test.js server/test/scraper.test.js

node:internal/modules/cjs/loader:1451
  throw err;
  ^

Error: Cannot find module 'better-sqlite3'
Require stack:
- C:\Users\marsh\Projects\LABORATORIO\BET\raceedge\server\database.js
- C:\Users\marsh\Projects\LABORATORIO\BET\raceedge\server\test\database.test.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1448:15)
    at defaultResolveImpl (node:internal/modules/cjs/loader:1059:19)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1064:22)
    at Module._load (node:internal/modules/cjs/loader:1234:25)
    at TracingChannel.traceSync (node:diagnostics_channel:328:14)
    at wrapModuleLoad (node:internal/modules/cjs/loader:245:24)
    at Module.require (node:internal/modules/cjs/loader:1548:12)
    at require (node:internal/modules/helpers:152:16)
    at Object.<anonymous> (C:\Users\marsh\Projects\LABORATORIO\BET\raceedge\server\database.js:1:18)
    at Module._compile (node:internal/modules/cjs/loader:1804:14) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    'C:\\Users\\marsh\\Projects\\LABORATORIO\\BET\\raceedge\\server\\database.js',
    'C:\\Users\\marsh\\Projects\\LABORATORIO\\BET\\raceedge\\server\\test\\database.test.js'
  ]
}

Node.js v24.13.1
✖ server\test\database.test.js (149.841ms)
▶ scoreRunner
  ✔ strong form runner scores higher than weak form runner (1.8624ms)
  ✔ box 1 runner scores higher than box 8 runner with identical form (0.3818ms)
  ✔ high trainer strike rate adds points (0.3441ms)
  ✔ score is in range 0-100 (0.4656ms)
✔ scoreRunner (5.9397ms)
▶ applyMode
  ✔ safest returns highest scoring runner (1.7456ms)
  ✔ value avoids the market favourite (0.743ms)
  ✔ longshot selects a runner with odds >= $3 and a form indicator (0.7855ms)
  ✔ throws for unrecognised mode (2.2808ms)
  ✔ handles single-runner field gracefully (0.3323ms)
✔ applyMode (6.7902ms)
node:internal/modules/cjs/loader:1451
  throw err;
  ^

Error: Cannot find module 'cheerio'
Require stack:
- C:\Users\marsh\Projects\LABORATORIO\BET\raceedge\server\scraper.js
- C:\Users\marsh\Projects\LABORATORIO\BET\raceedge\server\test\scraper.test.js
    at Module._resolveFilename (node:internal/modules/cjs/loader:1448:15)
    at defaultResolveImpl (node:internal/modules/cjs/loader:1059:19)
    at resolveForCJSWithHooks (node:internal/modules/cjs/loader:1064:22)
    at Module._load (node:internal/modules/cjs/loader:1234:25)
    at TracingChannel.traceSync (node:diagnostics_channel:328:14)
    at wrapModuleLoad (node:internal/modules/cjs/loader:245:24)
    at Module.require (node:internal/modules/cjs/loader:1548:12)
    at require (node:internal/modules/helpers:152:16)
    at Object.<anonymous> (C:\Users\marsh\Projects\LABORATORIO\BET\raceedge\server\scraper.js:1:17)
    at Module._compile (node:internal/modules/cjs/loader:1804:14) {
  code: 'MODULE_NOT_FOUND',
  requireStack: [
    'C:\\Users\\marsh\\Projects\\LABORATORIO\\BET\\raceedge\\server\\scraper.js',
    'C:\\Users\\marsh\\Projects\\LABORATORIO\\BET\\raceedge\\server\\test\\scraper.test.js'
  ]
}

Node.js v24.13.1
✖ server\test\scraper.test.js (136.682ms)
ℹ tests 11
ℹ suites 2
ℹ pass 9
ℹ fail 2
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 216.9675

✖ failing tests:

test at server\test\database.test.js:1:1
✖ server\test\database.test.js (149.841ms)
  'test failed'

test at server\test\scraper.test.js:1:1
✖ server\test\scraper.test.js (136.682ms)
  'test failed'
```

## Dependency Health

Dependency status against npm on 28 March 2026:

| Package | Declared in `package.json` | Latest npm version | Status |
| --- | --- | --- | --- |
| `better-sqlite3` | `^12.8.0` | `12.8.0` | Up to date |
| `cheerio` | `^1.0.0` | `1.2.0` | Outdated |
| `cors` | `^2.8.5` | `2.8.6` | Outdated |
| `express` | `^4.18.3` | `5.2.1` | Outdated |
| `puppeteer` | `^22.4.0` | `24.40.0` | Outdated |
| `@vitejs/plugin-react` | `^4.2.1` | `6.0.1` | Outdated |
| `concurrently` | `^8.2.2` | `9.2.1` | Outdated |
| `react` | `^18.3.1` | `19.2.4` | Outdated |
| `react-dom` | `^18.3.1` | `19.2.4` | Outdated |
| `vite` | `^5.1.6` | `8.0.3` | Outdated |

`npm audit --json` summary:

- Known vulnerabilities: 0
- Severity breakdown: 0 info, 0 low, 0 moderate, 0 high, 0 critical
- Dependency counts in audit metadata: 227 prod, 114 dev, 53 optional, 5 peer, 345 total

## Known Issues / TODO Comments

Search used:

```text
rg -n -i --glob "*.js" --glob "*.jsx" --glob "*.css" --glob "*.html" "TODO|FIXME|BUG|HACK|XXX"
```

Findings:

- No explicit `TODO`, `FIXME`, `BUG`, `HACK`, or `XXX` comment markers were found in the scanned code files.
- Separate from comment markers, the current working copy is missing installed dependencies needed for the full test suite, which is why `database` and `scraper` fail during baseline execution.
