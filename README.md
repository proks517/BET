# RaceEdge

Australian racing research and prediction tracker. Researches greyhound and horse races across multiple sources, recommends a runner, and tracks win/loss history with P&L.

## Requirements

- Node.js 18+
- Windows: Visual Studio Build Tools (for `better-sqlite3` native compilation)

## Setup

```bash
cd raceedge
npm install      # downloads dependencies + Puppeteer browser (~150MB)
```

## Run

```bash
npm run dev
```

- Frontend: http://localhost:5173
- API: http://localhost:3001

## Test

```bash
npm test
```

## Data Sources

**Greyhounds:** thedogs.com.au, racingandsports.com.au, grv.org.au, tab.com.au (Puppeteer)

**Horses:** racingaustralia.horse, racingandsports.com.au, tab.com.au (Puppeteer), racenet.com.au (Puppeteer), punters.com.au (Puppeteer)

Note: thegreyhoundrecorder.com.au and gbota.com.au are listed in the spec but not yet implemented — their HTML structure requires further investigation. Add them to `scraper.js` as additional static scrapers when their form-guide URL patterns are known.

Scraper selectors are best-effort — racing sites change HTML frequently. Meeting list falls back to a hardcoded list of common Australian tracks when live scraping fails.

## P&L Calculation

| Outcome   | P&L              |
|-----------|-----------------|
| Win       | (odds × $10) − $10 |
| Loss      | −$10            |
| Scratched | $0              |

Default stake: **$10 flat**. Enter actual odds when recording a result.

## Prediction Modes

| Mode       | Strategy |
|------------|----------|
| Safest Bet | Highest composite score across all metrics |
| Best Value | Strong score but not the market favourite |
| Long Shot  | Lower market profile + specific form indicator |
