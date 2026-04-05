# RaceEdge Repository

`raceedge/` is the canonical app in this repository.

The current product is an ease-of-use release: a greyhound-first daily scan board that surfaces the top 5 safest, value, and longshot bets, lets you confirm what you actually place, and tracks P/L in a clean ledger.

## Quick Start

Windows one-click launch:

```bat
launch.bat
```

Manual launch:

```bash
cd raceedge
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- API: `http://localhost:3001`

## Current Product Shape

- Daily scan board
- Inline source trust badges, including experimental warnings
- Explicit bet confirmation with stake and confirmed odds
- Placed-bet ledger with auto-settlement and manual override

## Verification

```bash
cd raceedge
npm test
npm run build
```

See `raceedge/README.md` for the full product notes, source status, and runtime details.
