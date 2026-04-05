# RaceEdge

RaceEdge is now a simplified, greyhound-first betting workflow:

1. Scan the day
2. Review the top 5 `Safest`, `Value`, and `Longshot` bets
3. Confirm the bets you actually place with stake and odds
4. Track the placed-bet ledger and settle results automatically or manually

Everything else has been pushed out of the primary product surface.

## Quick Start

### Windows
1. Install Node.js 18+.
2. Run `npm install` inside `raceedge/`.
3. Double-click `start.bat` or run `npm run dev`.

### Mac/Linux
1. Install Node.js 18+.
2. Run `npm install` inside `raceedge/`.
3. Run `./start.sh` or `npm run dev`.

### Manual

```bash
cd raceedge
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- API: `http://localhost:3001`

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the simplified client and API together |
| `npm test` | Run the server suite plus UI smoke tests |
| `npm run build` | Build the production client bundle |
| `docker build -t raceedge .` | Build the multi-stage production image |

## Current Workflow

- `Scan Day` is the main entrypoint.
- The board returns the top 5 bets in each class.
- Experimental sources are visible by default and marked inline with warning badges.
- Only confirmed bets are stored in the live ledger.
- Existing legacy prediction rows are archived in place and excluded from the live P/L ledger.
- Automatic result checking stays active, with manual `win`, `loss`, and `scratched` overrides available in the ledger.

## API Surface

The simplified UI depends on these routes:

- `GET /api/health`
- `GET /api/capabilities`
- `GET /api/best-bets`
- `GET /api/best-bets/stream`
- `GET /api/bets`
- `POST /api/bets`
- `PATCH /api/bets/:id`
- `POST /api/check-results`

The older research-heavy routes are no longer part of the primary product.

## Source Status

The authoritative source is `shared/capabilities.json`.

### Greyhound sources shown on picks

| Source | Status | Notes |
| --- | --- | --- |
| TheDogs | Stable | Primary greyhound source with parser, meeting, and result fixture coverage. |
| Racing & Sports | Stable | Shared parser coverage and active use in the merge. |
| GRV | Experimental | Visible by default, but should be treated cautiously. |
| TAB | Experimental | Selector drift remains a risk. |
| Greyhound Recorder | Experimental | Supplemental source only. |
| GBOTA | Experimental | Supplemental source only. |

## Configuration

Copy `.env.example` to `.env` only if you want to override defaults such as the API port.

```bash
cp .env.example .env
```

No API keys are required for the current product. AI remains disabled and is not part of the simplified workflow.

## Testing And CI

- `npm test` covers the placed-bet ledger, scan payload, source warnings, and simplified UI flow.
- `npm run build` validates the production client bundle.
- GitHub Actions runs tests, build, and Docker image build for `raceedge/`.
