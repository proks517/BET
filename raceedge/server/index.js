const express = require('express')
const cors    = require('cors')
const { initDb, savePrediction, getPredictions, updateResult, getStats } = require('./database.js')
const { research, fetchMeetings, closeBrowser } = require('./scraper.js')
const { applyMode } = require('./predictor.js')

const app  = express()
const PORT = process.env.PORT || 3001

app.use(cors({ origin: 'http://localhost:5173' }))
app.use(express.json())

const db = initDb()
console.log('[RaceEdge] Database ready')

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
  const { date, meeting, raceNumber, raceType, mode } = req.body
  if (!date || !meeting || !raceNumber || !raceType || !mode) {
    return res.status(400).json({ error: 'date, meeting, raceNumber, raceType, mode are all required' })
  }
  try {
    const scrape = await research(date, meeting, raceNumber, raceType)

    if (scrape.runners.length === 0) {
      return res.status(422).json({
        error: 'No runner data retrieved from any source',
        sources: scrape.sources,
        sourcesSkipped: scrape.sourcesSkipped,
        warning: scrape.warning,
      })
    }

    const prediction = applyMode(scrape.runners, mode)

    const saved = savePrediction(db, {
      date,
      track:       meeting,
      race_number: raceNumber,
      race_type:   raceType,
      runner:      prediction.runner.name,
      box_barrier: prediction.runner.box ?? prediction.runner.barrier ?? null,
      mode,
      confidence:  prediction.confidence,
    })

    res.json({
      predictionId:   saved.id,
      runner:         prediction.runner.name,
      box:            prediction.runner.box,
      barrier:        prediction.runner.barrier,
      odds:           prediction.runner.odds,
      score:          prediction.score,
      confidence:     prediction.confidence,
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

async function shutdown() {
  await closeBrowser()
  db.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

app.listen(PORT, () => console.log(`[RaceEdge API] http://localhost:${PORT}`))
