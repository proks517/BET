const express = require('express')
const cors    = require('cors')
const path    = require('path')
const {
  initDb,
  savePrediction,
  getPredictions,
  updateResult,
  getPendingPredictions,
  autoResolveResult,
  getStats,
  getScraperStats,
  getBoxBiasStats,
  saveJournalEntry,
  getJournalEntry,
  getJournalHistory,
} = require('./database.js')
const {
  research,
  fetchMeetings,
  fetchGreyhoundResult,
  fetchHorseResult,
  closeBrowser,
} = require('./scraper.js')
const { applyMode, getDefaultBoxBiasTable } = require('./predictor.js')

const app  = express()
const PORT = process.env.PORT || 3001
const RESULT_CHECK_INTERVAL_MS = 30 * 60 * 1000

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }))
app.use(express.json())

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'dist')))
}

const db = initDb()
console.log('[RaceEdge] Database ready')
let activeResultCheck = null

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getResultSourceConfig(prediction) {
  if (prediction.race_type === 'greyhound') {
    return { source: 'thedogs', fetcher: fetchGreyhoundResult }
  }
  return { source: 'racingandsports', fetcher: fetchHorseResult }
}

async function runPendingResultCheck() {
  if (activeResultCheck) return activeResultCheck

  activeResultCheck = (async () => {
    const pendingPredictions = getPendingPredictions(db)
    const summary = {
      checked: pendingPredictions.length,
      resolved: 0,
      stillPending: pendingPredictions.length,
      errors: [],
    }

    if (pendingPredictions.length === 0) {
      summary.stillPending = 0
      return summary
    }

    const lastRequestAtBySource = new Map()

    for (const prediction of pendingPredictions) {
      const { source, fetcher } = getResultSourceConfig(prediction)
      const lastRequestAt = lastRequestAtBySource.get(source)
      if (lastRequestAt) {
        const elapsed = Date.now() - lastRequestAt
        if (elapsed < 1000) {
          await sleep(1000 - elapsed)
        }
      }

      lastRequestAtBySource.set(source, Date.now())

      let resultData = null
      try {
        resultData = await fetcher(prediction.date, prediction.track, prediction.race_number)
      } catch (err) {
        summary.errors.push({
          predictionId: prediction.id,
          track: prediction.track,
          raceNumber: prediction.race_number,
          source,
          error: err.message,
        })
        continue
      }

      if (resultData == null) {
        summary.errors.push({
          predictionId: prediction.id,
          track: prediction.track,
          raceNumber: prediction.race_number,
          source,
          error: 'Result page unavailable',
        })
        continue
      }

      if (!resultData.finished || !resultData.winner) {
        continue
      }

      const resolved = autoResolveResult(db, prediction.id, resultData.winner, undefined)
      if (resolved) {
        summary.resolved += 1
      } else {
        summary.errors.push({
          predictionId: prediction.id,
          track: prediction.track,
          raceNumber: prediction.race_number,
          source,
          error: 'Prediction could not be resolved',
        })
      }
    }

    summary.stillPending = getPendingPredictions(db).length
    return summary
  })().finally(() => {
    activeResultCheck = null
  })

  return activeResultCheck
}

function formatResultCheckSummary(summary) {
  return `checked=${summary.checked}, resolved=${summary.resolved}, stillPending=${summary.stillPending}, errors=${summary.errors.length}`
}

app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get()
    res.json({ status: 'ok', uptime: process.uptime() })
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message })
  }
})

// GET /api/meetings?date=YYYY-MM-DD&type=greyhound|horse
app.get('/api/meetings', async (req, res) => {
  const { date, type } = req.query
  if (!date || !type) return res.status(400).json({ error: 'date and type are required' })
  try {
    res.json({ meetings: await fetchMeetings(date, type) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/races?meeting=<name>
app.get('/api/races', (req, res) => {
  if (!req.query.meeting) return res.status(400).json({ error: 'meeting is required' })
  res.json({ races: Array.from({ length: 12 }, (_, i) => i + 1) })
})

// POST /api/research
app.post('/api/research', async (req, res) => {
  const { date, meeting, raceNumber, raceType, mode, stake, distance } = req.body
  if (!date || !meeting || !raceNumber || !raceType || !mode) {
    return res.status(400).json({ error: 'date, meeting, raceNumber, raceType, mode are all required' })
  }
  try {
    const scrape = await research(date, meeting, raceNumber, raceType, db)

    if (scrape.runners.length === 0) {
      return res.status(422).json({
        error: 'No runner data retrieved from any source',
        sources: scrape.sources,
        sourcesSkipped: scrape.sourcesSkipped,
        warning: scrape.warning,
      })
    }

    const numericDistance = Number(distance)
    const boxBiasStats = Number.isFinite(numericDistance)
      ? getBoxBiasStats(db, meeting, numericDistance)
      : null

    const enrichedRunners = scrape.runners.map(runner => ({
      ...runner,
      distanceMeters: Number.isFinite(numericDistance) ? numericDistance : runner.distanceMeters,
      raceType,
      boxBiasData: boxBiasStats,
    }))

    const prediction = applyMode(enrichedRunners, mode)

    const saved = savePrediction(db, {
      date,
      track:       meeting,
      race_number: raceNumber,
      race_type:   raceType,
      race_distance: Number.isFinite(numericDistance) ? numericDistance : null,
      runner:      prediction.runner.name,
      box_barrier: prediction.runner.box ?? prediction.runner.barrier ?? null,
      mode,
      confidence:  prediction.confidence,
      odds:        prediction.runner.odds ?? null,
      stake:       stake || 10,
    })

    const sourcesConsulted = scrape.sources.map(source => ({
      source: source.source,
      status: source.error
        ? 'error'
        : source.runners.length > 0
          ? 'success'
          : 'empty',
      recordsReturned: source.runners.length,
      error: source.error || null,
    }))

    const rawDataSummary = scrape.sources.map(source => {
      const status = source.error
        ? `error - ${source.error}`
        : source.runners.length > 0
          ? `success (${source.runners.length} runners)`
          : 'empty (0 runners)'
      return `${source.source}: ${status}`
    }).join('\n')

    saveJournalEntry(db, {
      prediction_id: saved.id,
      race_date: date,
      track: meeting,
      race_number: raceNumber,
      race_distance: Number.isFinite(numericDistance) ? numericDistance : null,
      all_runners_json: prediction.allScores,
      sources_consulted_json: sourcesConsulted,
      winner_name: prediction.runner.name,
      winner_box: prediction.runner.box ?? prediction.runner.barrier ?? null,
      winner_composite_score: prediction.score,
      winner_breakdown_json: prediction.breakdown,
      mode_used: mode,
      box_bias_source: prediction.boxBiasSource,
      raw_data_summary: rawDataSummary,
    })

    res.json({
      predictionId:   saved.id,
      runner:         prediction.runner.name,
      box:            prediction.runner.box,
      barrier:        prediction.runner.barrier,
      distance:       Number.isFinite(numericDistance) ? numericDistance : null,
      odds:           prediction.runner.odds,
      score:          prediction.score,
      confidence:     prediction.confidence,
      breakdown:      prediction.breakdown,
      boxBiasSource:  prediction.boxBiasSource,
      reasoning:      prediction.reasoning,
      allScores:      prediction.allScores,
      sourcesUsed:    scrape.sourcesUsed,
      sourcesSkipped: scrape.sourcesSkipped,
      warning:        scrape.warning,
    })
  } catch (err) {
    console.error('[/api/research]', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/predictions
app.get('/api/predictions', (req, res) => {
  try {
    res.json({ predictions: getPredictions(db) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/pending
app.get('/api/pending', (req, res) => {
  try {
    res.json({ predictions: getPendingPredictions(db) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/predictions/:id
app.patch('/api/predictions/:id', (req, res) => {
  const id = parseInt(req.params.id, 10)
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }
  const { result, odds } = req.body
  if (!result || !['win', 'loss', 'scratched'].includes(result)) {
    return res.status(400).json({ error: 'result must be win, loss, or scratched' })
  }
  try {
    const updated = updateResult(db, id, result, odds ?? null)
    if (!updated) return res.status(404).json({ error: 'Prediction not found' })
    res.json({ prediction: updated })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/stats
app.get('/api/stats', (req, res) => {
  try {
    res.json(getStats(db))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/check-results
app.post('/api/check-results', async (req, res) => {
  try {
    const summary = await runPendingResultCheck()
    res.json(summary)
  } catch (err) {
    console.error('[/api/check-results]', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/scraper-health
app.get('/api/scraper-health', (req, res) => {
  try {
    res.json({ sources: getScraperStats(db) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/box-bias?track=<name>&distance=<meters>
app.get('/api/box-bias', (req, res) => {
  const { track, distance } = req.query
  const numericDistance = Number(distance)
  if (!track || !Number.isFinite(numericDistance)) {
    return res.status(400).json({ error: 'track and numeric distance are required' })
  }

  try {
    const stats = getBoxBiasStats(db, track, numericDistance)
    const hasFullEmpiricalCoverage = stats &&
      stats.boxes.length === 8 &&
      stats.boxes.every(box => box.total_predictions >= 10)

    if (!hasFullEmpiricalCoverage) {
      const defaults = getDefaultBoxBiasTable(numericDistance)
      return res.json({
        source: 'default',
        message: 'insufficient data',
        track,
        distance: numericDistance,
        boxes: defaults.boxes.map(box => ({
          box: box.box,
          total_predictions: 0,
          win_count: 0,
          win_rate_pct: box.win_rate_pct,
        })),
      })
    }

    res.json({
      source: 'empirical',
      track,
      distance: numericDistance,
      boxes: stats.boxes,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/journal?limit=20
app.get('/api/journal', (req, res) => {
  const limit = Number(req.query.limit) || 20
  try {
    res.json({ entries: getJournalHistory(db, limit) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/journal/:predictionId
app.get('/api/journal/:predictionId', (req, res) => {
  const predictionId = Number(req.params.predictionId)
  if (!Number.isInteger(predictionId) || predictionId < 1) {
    return res.status(400).json({ error: 'predictionId must be a positive integer' })
  }

  try {
    const entry = getJournalEntry(db, predictionId)
    if (!entry) return res.status(404).json({ error: 'Journal entry not found' })
    res.json({ entry })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

const resultCheckInterval = setInterval(async () => {
  try {
    if (getPendingPredictions(db).length === 0) return
    const summary = await runPendingResultCheck()
    console.log(`[RaceEdge Results] ${formatResultCheckSummary(summary)}`)
    if (summary.errors.length > 0) {
      console.log('[RaceEdge Results] Errors:', summary.errors)
    }
  } catch (err) {
    console.error('[RaceEdge Results] Scheduled check failed:', err.message)
  }
}, RESULT_CHECK_INTERVAL_MS)

resultCheckInterval.unref?.()

async function shutdown() {
  clearInterval(resultCheckInterval)
  await closeBrowser()
  db.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'))
  })
}

app.listen(PORT, () => console.log(`[RaceEdge API] http://localhost:${PORT}`))
