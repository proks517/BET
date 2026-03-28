# RaceEdge — Design Spec
**Date:** 2026-03-20
**Status:** Approved

---

## Overview

RaceEdge is a racing research and prediction tracker for Australian greyhound and thoroughbred races. The user selects a date, meeting, and race; chooses a prediction mode; the app scrapes multiple sources to recommend a runner; all predictions and outcomes are persisted in SQLite with a running win/profit dashboard.

---

## Architecture

**Single root package** at `/raceedge` with `concurrently` running:
- Vite dev server on port **5173** (React frontend)
- Express API server on port **3001** (backend)
- Vite proxies `/api/*` → Express

**File structure:**
```
/raceedge
  /server
    index.js        Express entry point, routes
    scraper.js      Multi-source fetching (Puppeteer + Cheerio/node-fetch)
    predictor.js    Scoring and recommendation logic
    database.js     SQLite setup and query helpers
  /client
    App.jsx         Single React component tree
    index.html      Vite entry HTML
  vite.config.js
  package.json
  README.md
```

---

## Backend

### Express API (`server/index.js`)
- `GET /api/meetings?date=YYYY-MM-DD&type=greyhound|horse` — returns list of meetings for the day
- `GET /api/races?meeting=<id>&date=<date>&type=<type>` — returns race numbers for a meeting
- `POST /api/research` — body: `{ date, meeting, raceNumber, raceType, mode }` — runs multi-source scrape, returns recommendation
- `GET /api/predictions` — returns all stored predictions
- `PATCH /api/predictions/:id` — records actual result (win/loss/scratched + odds)

### Scraper (`server/scraper.js`)
Two scraping strategies:
1. **node-fetch + Cheerio** — static sites: thedogs.com.au, thegreyhoundrecorder.com.au, racingandsports.com.au, grv.org.au, gbota.com.au, racingaustralia.horse
2. **Puppeteer** — JS-rendered sites: tab.com.au, racenet.com.au, punters.com.au

Each source is attempted independently. Failures are caught, logged, and noted in the response. If fewer than 2 sources return data, a warning is included.

Each source returns a normalised `RunnerData[]`:
```ts
{
  name: string
  box?: number        // greyhounds
  barrier?: number    // horses
  lastStarts: string  // e.g. "1-2-3-1"
  bestTime?: number   // seconds
  trainer?: string
  trainerStrike?: number  // %
  odds?: number
}
```

### Predictor (`server/predictor.js`)
Scores each runner on:
- **Recent form** (last 4–6 starts): wins=3pts, places=1pt each
- **Best time** vs field average: faster than average = bonus points
- **Box/barrier advantage**: boxes 1–4 greyhounds = small bonus
- **Class consistency**: all placings in last 5 = bonus
- **Trainer strike rate**: >20% = bonus

Applies mode:
- **Safest Bet** — highest composite score
- **Best Value** — good score (top 3) but not highest-odds favourite
- **Long Shot** — lower odds profile but has ≥1 specific form indicator (best time, box advantage, recent win)

Returns: `{ runner, box/barrier, score, confidence, reasoning, mode, sourcesUsed, sourcesSkipped }`

### Database (`server/database.js`)
SQLite via `better-sqlite3`. Single `predictions` table:

| column | type |
|---|---|
| id | INTEGER PK |
| date | TEXT |
| track | TEXT |
| race_number | INTEGER |
| race_type | TEXT |
| runner | TEXT |
| box_barrier | INTEGER |
| mode | TEXT |
| confidence | REAL |
| result | TEXT (win/loss/scratched/pending) |
| odds | REAL |
| stake | REAL (default 10) |
| pnl | REAL |
| created_at | TEXT |

---

## Frontend (`client/App.jsx`)

Single React component file using hooks. Sections:

1. **Controls panel** — date picker, race type toggle (Greyhounds/Horses), meeting dropdown, race number selector, mode selector (Safest/Value/Long Shot), "Research & Pick" button
2. **Loading state** — shows which sources are currently being checked
3. **Results panel** — recommended runner, box/barrier, reasoning, sources consulted/skipped, confidence %
4. **Record Result** — Win / Loss / Scratched buttons + odds input field; calculates P&L on submission
5. **Stats dashboard** — overall win rate, win rate by mode, win rate by race type, last 10 predictions table, total P&L

---

## P&L Calculation

- **Win:** `(odds × stake) - stake`
- **Loss:** `-stake`
- **Scratched:** `0`
- Default stake: **$10 flat**
- Odds scraped from TAB/Racenet at research time (pre-filled in odds input); user can override before recording

---

## Error Handling

- Each scraper source wrapped in try/catch — failure returns `{ source, error, data: null }`
- Puppeteer launch failure → falls back silently, JS-rendered sources skipped
- `< 2 sources` with data → warning flag in response shown in UI
- All errors surfaced in "Sources consulted" panel, not thrown to user as crashes

---

## Dependencies

| Package | Purpose |
|---|---|
| express | API server |
| better-sqlite3 | SQLite ORM-free |
| cheerio | HTML parsing |
| node-fetch | Static site fetching |
| puppeteer | JS-rendered site scraping |
| cors | CORS for Vite↔Express |
| react + react-dom | UI |
| vite + @vitejs/plugin-react | Frontend build |
| concurrently | Run both servers together |
