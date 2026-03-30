# RaceEdge
Australian racing research and prediction tracker.

## Quick Start (Windows)
1. Install Node.js 18+ from nodejs.org
2. Double-click `start.bat`
3. Browser opens automatically at http://localhost:5173

## Quick Start (Mac/Linux)
1. Install Node.js 18+ from nodejs.org
2. Run: `./start.sh`
3. Browser opens at http://localhost:5173

## Manual Start
```bash
cd raceedge
npm install
npm run dev
```

## What it does
- Researches greyhound and horse races across multiple sources
- Scores every runner using a 6-factor weighted model
- Recommends Safest / Value / Long Shot picks with EV calculations
- Scans all races for a day and surfaces the top picks
- Tracks prediction accuracy, win rate and P&L over time

## Data sources
- thedogs.com.au (greyhounds)
- thegreyhoundrecorder.com.au (greyhounds)
- racingandsports.com.au (horses + greyhounds)
- racenet.com.au (horses)

## Configuration
Copy `.env.example` to `.env` in the `raceedge` folder.
No API keys required for standalone use.
