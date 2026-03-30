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
  getStatsByTrack,
  getStatsByGrade,
  getStatsByBox,
  getStatsByMonth,
  getCalibrationData,
  getStreakData,
  getProfitCurve,
  getScraperStats,
  getBoxBiasStats,
  saveJournalEntry,
  getJournalEntry,
  getJournalHistory,
} = require('./database.js')
const {
  research,
  fetchMeetings,
  fetchMeetingsForDate,
  fetchAllRacesForMeeting,
  fetchGreyhoundResult,
  fetchHorseResult,
  closeBrowser,
} = require('./scraper.js')
const { applyMode, generateBestBets, getDefaultBoxBiasTable } = require('./predictor.js')
const { analyseRace } = require('./analyst.js')

const app  = express()
const PORT = process.env.PORT || 3001
const RESULT_CHECK_INTERVAL_MS = 30 * 60 * 1000
const BEST_BETS_CACHE_TTL_MS = 30 * 60 * 1000

const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'
app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }))
app.use(express.json())

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '..', 'dist')))
}

const db = initDb()
console.log('[RaceEdge] Database ready')
let activeResultCheck = null
const bestBetsCache = new Map()
const activeBestBetsScans = new Map()

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function getBestBetsCacheKey(date, type, mode) {
  return `${date}|${type}|${mode}`
}

function getCachedBestBets(key) {
  const entry = bestBetsCache.get(key)
  if (!entry) return null

  const ageMs = Date.now() - entry.cachedAt
  if (ageMs >= BEST_BETS_CACHE_TTL_MS) {
    bestBetsCache.delete(key)
    return null
  }

  return {
    ...entry.payload,
    cached: true,
    cacheAgeMinutes: Math.max(0, Math.floor(ageMs / 60000)),
  }
}

function setCachedBestBets(key, payload) {
  bestBetsCache.set(key, {
    cachedAt: Date.now(),
    payload,
  })
}

function parseClockMinutes(value) {
  if (!value) return null
  const match = String(value).match(/^(\d{1,2}):(\d{2})$/)
  if (!match) return null
  return (parseInt(match[1], 10) * 60) + parseInt(match[2], 10)
}

function formatClockMinutes(totalMinutes) {
  if (!Number.isFinite(totalMinutes)) return null
  const wrapped = ((Math.round(totalMinutes) % (24 * 60)) + (24 * 60)) % (24 * 60)
  const hours = String(Math.floor(wrapped / 60)).padStart(2, '0')
  const minutes = String(wrapped % 60).padStart(2, '0')
  return `${hours}:${minutes}`
}

function estimateStartTime(firstRaceTime, raceNumber, raceType) {
  const baseMinutes = parseClockMinutes(firstRaceTime)
  if (baseMinutes == null || !Number.isFinite(Number(raceNumber))) return firstRaceTime || null
  const spacingMinutes = raceType === 'horse' ? 30 : 20
  return formatClockMinutes(baseMinutes + ((Number(raceNumber) - 1) * spacingMinutes))
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

async function executeBestBetsScan({ date, type, mode, emit }) {
  const startedAt = Date.now()
  const meetings = await fetchMeetingsForDate(date, type, db)
  const totalMeetings = meetings.length
  let totalRacesScanned = 0
  let allRaces = []

  emit?.({ type: 'scan_start', totalMeetings })

  for (const meeting of meetings) {
    emit?.({
      type: 'meeting_start',
      track: meeting.track,
      raceCount: meeting.raceCount,
      totalMeetings,
    })

    const meetingRaces = await fetchAllRacesForMeeting(
      date,
      meeting.track,
      meeting.raceCount,
      type,
      db,
      progressEvent => {
        if (progressEvent.type === 'race_done') {
          totalRacesScanned += 1
        }

        emit?.({
          ...progressEvent,
          totalRacesScanned,
          totalMeetings,
        })
      }
    )

    const enrichedRaces = meetingRaces.map(race => ({
      ...race,
      estimatedStartTime: estimateStartTime(meeting.firstRaceTime, race.raceNumber, type),
    }))

    allRaces = allRaces.concat(enrichedRaces)

    emit?.({
      type: 'meeting_done',
      track: meeting.track,
      racesScanned: meeting.raceCount,
      totalRacesScanned,
      totalMeetings,
    })
  }

  return {
    generatedAt: new Date().toISOString(),
    date,
    type,
    mode,
    totalRacesScanned,
    totalMeetings,
    picks: generateBestBets(allRaces, mode),
    scanDurationMs: Date.now() - startedAt,
  }
}

function getOrStartBestBetsScan({ date, type, mode }) {
  const key = getBestBetsCacheKey(date, type, mode)
  const cached = getCachedBestBets(key)
  if (cached) {
    return { key, cached }
  }

  let active = activeBestBetsScans.get(key)
  if (!active) {
    const listeners = new Set()
    const emit = payload => {
      for (const listener of listeners) {
        listener(payload)
      }
    }

    const promise = executeBestBetsScan({ date, type, mode, emit })
      .then(payload => {
        setCachedBestBets(key, payload)
        const completePayload = { type: 'complete', cached: false, cacheAgeMinutes: 0, ...payload }
        emit(completePayload)
        return completePayload
      })
      .catch(err => {
        const errorPayload = { type: 'error', message: err.message }
        emit(errorPayload)
        throw err
      })
      .finally(() => {
        activeBestBetsScans.delete(key)
      })

    active = { promise, listeners }
    activeBestBetsScans.set(key, active)
  }

  return { key, active }
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
    res.json({ meetings: await fetchMeetings(date, type, db) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/races?meeting=<name>
app.get('/api/races', (req, res) => {
  if (!req.query.meeting) return res.status(400).json({ error: 'meeting is required' })
  res.json({ races: Array.from({ length: 12 }, (_, i) => i + 1) })
})

async function handleResearchRequest(req, res, {
  researchFn = research,
  analyseRaceFn = analyseRace,
  dbInstance = db,
} = {}) {
  const { date, meeting, raceNumber, raceType, mode, stake, distance } = req.body
  if (!date || !meeting || !raceNumber || !raceType || !mode) {
    return res.status(400).json({ error: 'date, meeting, raceNumber, raceType, mode are all required' })
  }
  try {
    const scrape = await researchFn(date, meeting, raceNumber, raceType, dbInstance)

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
      ? getBoxBiasStats(dbInstance, meeting, numericDistance)
      : null

    const enrichedRunners = scrape.runners.map(runner => ({
      ...runner,
      distanceMeters: Number.isFinite(numericDistance) ? numericDistance : runner.distanceMeters,
      raceType,
      boxBiasData: boxBiasStats,
    }))

    const prediction = applyMode(enrichedRunners, mode)
    const derivedGrade = enrichedRunners.map(runner => runner.grade).find(Boolean) || null
    const aiStartedAt = Date.now()
    const aiAnalysis = await analyseRaceFn(prediction.allScores, {
      date,
      track: meeting,
      raceNumber,
      distance: Number.isFinite(numericDistance) ? numericDistance : (prediction.runner.distanceMeters ?? null),
      raceType,
      grade: derivedGrade,
    })
    console.log(`[AI Analyst] ${meeting} R${raceNumber} completed in ${Date.now() - aiStartedAt}ms (${aiAnalysis ? 'available' : 'unavailable'})`)

    const saved = savePrediction(dbInstance, {
      date,
      track:       meeting,
      race_number: raceNumber,
      race_type:   raceType,
      race_grade:  derivedGrade,
      race_distance: Number.isFinite(numericDistance) ? numericDistance : null,
      runner:      prediction.runner.name,
      box_barrier: prediction.runner.box ?? prediction.runner.barrier ?? null,
      mode,
      confidence:  prediction.confidence,
      odds:        prediction.runner.odds ?? null,
      stake:       stake || 10,
      ai_recommendation: aiAnalysis?.recommendation?.runner ?? null,
      ai_agreed: aiAnalysis?.modelAgreement ?? null,
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

    saveJournalEntry(dbInstance, {
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
      ai_analysis_json: aiAnalysis,
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
      aiAnalysis,
    })
  } catch (err) {
    console.error('[/api/research]', err)
    res.status(500).json({ error: err.message })
  }
}

// POST /api/research
app.post('/api/research', handleResearchRequest)

// GET /api/predictions
app.get('/api/predictions', (req, res) => {
  try {
    res.json({ predictions: getPredictions(db) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/best-bets?date=YYYY-MM-DD&type=greyhound|horse&mode=safest|value|longshot
app.get('/api/best-bets', async (req, res) => {
  const { date, type, mode } = req.query
  if (!date || !type || !mode) {
    return res.status(400).json({ error: 'date, type, and mode are required' })
  }

  if (!['greyhound', 'horse'].includes(type)) {
    return res.status(400).json({ error: 'type must be greyhound or horse' })
  }

  if (!['safest', 'value', 'longshot'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be safest, value, or longshot' })
  }

  try {
    const { cached, active } = getOrStartBestBetsScan({ date, type, mode })
    if (cached) {
      res.set('X-Scan-Duration-Ms', String(cached.scanDurationMs || 0))
      return res.json(cached)
    }

    const payload = await active.promise
    const { type: eventType, ...responsePayload } = payload
    res.set('X-Scan-Duration-Ms', String(responsePayload.scanDurationMs || 0))
    res.json(responsePayload)
  } catch (err) {
    console.error('[/api/best-bets]', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/best-bets/stream?date=YYYY-MM-DD&type=greyhound|horse&mode=safest|value|longshot
app.get('/api/best-bets/stream', async (req, res) => {
  const { date, type, mode } = req.query
  if (!date || !type || !mode) {
    return res.status(400).json({ error: 'date, type, and mode are required' })
  }

  if (!['greyhound', 'horse'].includes(type)) {
    return res.status(400).json({ error: 'type must be greyhound or horse' })
  }

  if (!['safest', 'value', 'longshot'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be safest, value, or longshot' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const { cached, active } = getOrStartBestBetsScan({ date, type, mode })
  if (cached) {
    sendSse(res, { type: 'complete', ...cached })
    return res.end()
  }

  const listener = payload => {
    sendSse(res, payload)
    if (payload.type === 'complete' || payload.type === 'error') {
      res.end()
    }
  }

  active.listeners.add(listener)
  req.on('close', () => {
    active.listeners.delete(listener)
  })

  try {
    await active.promise
  } catch {
    if (!res.writableEnded) {
      res.end()
    }
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

// GET /api/stats/advanced
app.get('/api/stats/advanced', (req, res) => {
  try {
    res.json({
      byTrack: getStatsByTrack(db),
      byGrade: getStatsByGrade(db),
      byBox: getStatsByBox(db),
      byMonth: getStatsByMonth(db),
      calibration: getCalibrationData(db),
      streaks: getStreakData(db),
      profitCurve: getProfitCurve(db),
    })
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

async function closeAppResources() {
  clearInterval(resultCheckInterval)
  await closeBrowser()
  db.close()
}

async function shutdown() {
  await closeAppResources()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT',  shutdown)

if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'))
  })
}

function startServer(port = PORT) {
  return app.listen(port, () => console.log(`[RaceEdge API] http://localhost:${port}`))
}

if (require.main === module) {
  startServer()
}

module.exports = {
  app,
  db,
  startServer,
  closeAppResources,
  handleResearchRequest,
}
