const express = require('express')
const cors = require('cors')
const path = require('path')
const {
  initDb,
  getPrediction,
  savePrediction,
  getPredictions,
  getBetLedgerSummary,
  updateResult,
  getPendingPredictions,
  autoResolveResult,
} = require('./database.js')
const {
  fetchMeetingsForDate,
  fetchMeetingsForDateDetailed,
  fetchAllRacesForMeeting,
  fetchGreyhoundResult,
  fetchHorseResult,
  closeBrowser,
} = require('./scraper.js')
const { generateBestBets } = require('./predictor.js')
const { getCapabilityMatrix, getFeatureMeta, getReleaseInfo, getSourceMeta } = require('./capabilities.js')

const app = express()
const PORT = process.env.PORT || 3001
const RESULT_CHECK_INTERVAL_MS = 30 * 60 * 1000
const BEST_BETS_CACHE_TTL_MS = 30 * 60 * 1000
const CLIENT_DIST_PATH = path.join(__dirname, '..', 'dist')
const RELEASE_INFO = getReleaseInfo()
const AI_ANALYST_CAPABILITY = getFeatureMeta('aiAnalyst')
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173'

app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }))
app.use(express.json())

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(CLIENT_DIST_PATH))
}

const db = initDb()
console.log('[RaceEdge] Database ready')

let activeResultCheck = null
const bestBetsCache = new Map()
const activeBestBetsScans = new Map()

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function sendSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

function parsePositiveNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

function parseOptionalNumber(value) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : null
}

function getConfidenceLabel(confidence) {
  const numeric = Number(confidence) || 0
  if (numeric >= 80) return 'High'
  if (numeric >= 65) return 'Medium'
  return 'Low'
}

function buildSourceBadges(sourceNames = []) {
  const uniqueSourceNames = Array.from(new Set(sourceNames.filter(Boolean)))

  return uniqueSourceNames.map(sourceName => {
    const metadata = getSourceMeta(sourceName) || {}
    return {
      sourceName,
      displayName: metadata.displayName || sourceName,
      trustStatus: metadata.status || 'experimental',
      trustLabel: metadata.statusLabel || 'Experimental',
      note: metadata.note || 'No source reliability note recorded.',
    }
  })
}

function decoratePick(pick) {
  const sourceBadges = buildSourceBadges(pick.sourcesUsed)

  return {
    ...pick,
    confidenceLabel: getConfidenceLabel(pick.confidence),
    sourceBadges,
    experimentalWarning: sourceBadges.some(source => source.trustStatus === 'experimental'),
  }
}

function decorateScanPayload(payload) {
  return {
    ...payload,
    picks: {
      safest: (payload.picks?.safest || []).map(decoratePick),
      value: (payload.picks?.value || []).map(decoratePick),
      longshot: (payload.picks?.longshot || []).map(decoratePick),
    },
  }
}

function formatBetResponse(bet) {
  return {
    id: bet.id,
    date: bet.date,
    track: bet.track,
    raceNumber: bet.race_number,
    raceType: bet.race_type,
    raceGrade: bet.race_grade,
    runnerName: bet.runner,
    box: bet.box_barrier,
    mode: bet.mode,
    confidence: bet.confidence,
    confidenceLabel: getConfidenceLabel(bet.confidence),
    stake: bet.stake,
    confirmedOdds: bet.odds,
    oddsSource: bet.odds_source,
    winProbability: bet.win_probability,
    ev: bet.ev,
    expectedReturn: bet.expected_return,
    result: bet.result,
    pnl: bet.pnl,
    placedAt: bet.placed_at,
    resolvedAutomatically: bet.resolved_automatically,
    defaultOddsUsed: bet.default_odds_used,
  }
}

function getBestBetsCacheKey(date, type) {
  return `${date}|${type}`
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

async function executeBestBetsScan({
  date,
  type = 'greyhound',
  emit,
  dbInstance = db,
  fetchMeetingsForDateFn = fetchMeetingsForDate,
  fetchMeetingsForDateDetailedFn = fetchMeetingsForDateDetailed,
  fetchAllRacesForMeetingFn = fetchAllRacesForMeeting,
  generateBestBetsFn = generateBestBets,
} = {}) {
  const startedAt = Date.now()
  const shouldUseLegacyMeetingStub = (
    fetchMeetingsForDateDetailedFn === fetchMeetingsForDateDetailed &&
    fetchMeetingsForDateFn !== fetchMeetingsForDate
  )
  const meetingLookup = shouldUseLegacyMeetingStub
    ? { meetings: await fetchMeetingsForDateFn(date, type, dbInstance), diagnostics: null }
    : fetchMeetingsForDateDetailedFn
      ? await fetchMeetingsForDateDetailedFn(date, type, dbInstance)
      : { meetings: await fetchMeetingsForDateFn(date, type, dbInstance), diagnostics: null }
  const meetings = meetingLookup.meetings || []
  const meetingDiagnostics = meetingLookup.diagnostics || null
  const totalMeetings = meetings.length
  let totalRacesScanned = 0
  let allRaces = []

  emit?.({ type: 'scan_start', totalMeetings, meetingDiagnostics })

  for (const meeting of meetings) {
    emit?.({
      type: 'meeting_start',
      track: meeting.track,
      raceCount: meeting.raceCount,
      totalMeetings,
    })

    const meetingRaces = await fetchAllRacesForMeetingFn(
      date,
      meeting.track,
      meeting.raceCount,
      type,
      dbInstance,
      progressEvent => {
        if (progressEvent.type === 'race_done') {
          totalRacesScanned += 1
        }

        emit?.({
          ...progressEvent,
          totalMeetings,
          totalRacesScanned,
        })
      }
    )

    allRaces = allRaces.concat(meetingRaces)

    emit?.({
      type: 'meeting_done',
      track: meeting.track,
      racesScanned: meeting.raceCount,
      totalRacesScanned,
      totalMeetings,
    })
  }

  return decorateScanPayload({
    generatedAt: new Date().toISOString(),
    date,
    type,
    mode: 'all',
    totalMeetings,
    totalRacesScanned,
    picks: generateBestBetsFn(allRaces),
    meetingDiagnostics,
    scanDurationMs: Date.now() - startedAt,
  })
}

function getOrStartBestBetsScan({ date, type = 'greyhound' }) {
  const key = getBestBetsCacheKey(date, type)
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

    const promise = executeBestBetsScan({ date, type, emit })
      .then(payload => {
        setCachedBestBets(key, payload)
        const completePayload = { ...payload, type: 'complete', cached: false, cacheAgeMinutes: 0 }
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
  if (prediction.race_type === 'horse') {
    return { source: 'racingandsports', fetcher: fetchHorseResult }
  }

  return { source: 'thedogs', fetcher: fetchGreyhoundResult }
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
          betId: prediction.id,
          track: prediction.track,
          raceNumber: prediction.race_number,
          source,
          error: err.message,
        })
        continue
      }

      if (!resultData?.finished || !resultData.winner) {
        continue
      }

      const resolved = autoResolveResult(db, prediction.id, resultData.winner, undefined)
      if (resolved) {
        summary.resolved += 1
      } else {
        summary.errors.push({
          betId: prediction.id,
          track: prediction.track,
          raceNumber: prediction.race_number,
          source,
          error: 'Bet could not be resolved',
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

app.get('/api/health', (req, res) => {
  try {
    db.prepare('SELECT 1').get()
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      release: RELEASE_INFO,
      aiAnalyst: AI_ANALYST_CAPABILITY,
    })
  } catch (err) {
    res.status(503).json({ status: 'error', error: err.message })
  }
})

app.get('/api/capabilities', (req, res) => {
  res.json(getCapabilityMatrix())
})

app.get('/api/best-bets', async (req, res) => {
  const date = req.query.date
  const type = req.query.type || 'greyhound'

  if (!date) {
    return res.status(400).json({ error: 'date is required' })
  }

  if (!['greyhound', 'horse'].includes(type)) {
    return res.status(400).json({ error: 'type must be greyhound or horse' })
  }

  try {
    const { cached, active } = getOrStartBestBetsScan({ date, type })
    if (cached) {
      res.set('X-Scan-Duration-Ms', String(cached.scanDurationMs || 0))
      return res.json(cached)
    }

    const payload = await active.promise
    const { type: eventType, ...responsePayload } = payload
    res.set('X-Scan-Duration-Ms', String(responsePayload.scanDurationMs || 0))
    return res.json(responsePayload)
  } catch (err) {
    console.error('[/api/best-bets]', err)
    return res.status(500).json({ error: err.message })
  }
})

app.get('/api/best-bets/stream', async (req, res) => {
  const date = req.query.date
  const type = req.query.type || 'greyhound'

  if (!date) {
    return res.status(400).json({ error: 'date is required' })
  }

  if (!['greyhound', 'horse'].includes(type)) {
    return res.status(400).json({ error: 'type must be greyhound or horse' })
  }

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const { cached, active } = getOrStartBestBetsScan({ date, type })
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
    const payload = await active.promise
    if (!res.writableEnded) {
      sendSse(res, payload)
      res.end()
    }
  } catch {
    if (!res.writableEnded) {
      res.end()
    }
  }
})

app.get('/api/bets', (req, res) => {
  try {
    res.json({
      bets: getPredictions(db).map(formatBetResponse),
      summary: getBetLedgerSummary(db),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/bets', (req, res) => {
  const {
    date,
    track,
    raceNumber,
    raceType = 'greyhound',
    raceGrade = null,
    raceDistance = null,
    runnerName,
    box = null,
    mode,
    confidence,
    stake,
    confirmedOdds,
    oddsSource = 'confirmed',
    winProbability = null,
    ev = null,
    expectedReturn = null,
  } = req.body || {}

  if (!date || !track || !runnerName || !mode) {
    return res.status(400).json({ error: 'date, track, raceNumber, runnerName, and mode are required' })
  }

  if (!Number.isInteger(Number(raceNumber)) || Number(raceNumber) < 1) {
    return res.status(400).json({ error: 'raceNumber must be a positive integer' })
  }

  if (!['greyhound', 'horse'].includes(raceType)) {
    return res.status(400).json({ error: 'raceType must be greyhound or horse' })
  }

  if (!['safest', 'value', 'longshot'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be safest, value, or longshot' })
  }

  const parsedStake = parsePositiveNumber(stake)
  const parsedOdds = parsePositiveNumber(confirmedOdds)
  const parsedConfidence = parseOptionalNumber(confidence)

  if (parsedStake == null) {
    return res.status(400).json({ error: 'stake must be a positive number' })
  }

  if (parsedOdds == null) {
    return res.status(400).json({ error: 'confirmedOdds must be a positive number' })
  }

  if (parsedConfidence == null) {
    return res.status(400).json({ error: 'confidence must be numeric' })
  }

  try {
    const bet = savePrediction(db, {
      date,
      track,
      race_number: Number(raceNumber),
      race_type: raceType,
      race_grade: raceGrade,
      race_distance: parseOptionalNumber(raceDistance),
      runner: runnerName,
      box_barrier: parseOptionalNumber(box),
      mode,
      confidence: parsedConfidence,
      stake: parsedStake,
      odds: parsedOdds,
      odds_source: oddsSource,
      win_probability: parseOptionalNumber(winProbability),
      ev: parseOptionalNumber(ev),
      expected_return: parseOptionalNumber(expectedReturn),
      record_kind: 'placed_bet',
      placed_at: new Date().toISOString(),
    })

    res.status(201).json({ bet: formatBetResponse(bet) })
  } catch (err) {
    console.error('[/api/bets]', err)
    res.status(500).json({ error: err.message })
  }
})

app.patch('/api/bets/:id', (req, res) => {
  const id = Number(req.params.id)
  const { result, odds } = req.body || {}

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'id must be a positive integer' })
  }

  if (!['win', 'loss', 'scratched'].includes(result)) {
    return res.status(400).json({ error: 'result must be win, loss, or scratched' })
  }

  try {
    const updated = updateResult(db, id, result, result === 'win' ? parsePositiveNumber(odds) : null)
    if (!updated) {
      return res.status(404).json({ error: 'Bet not found' })
    }

    res.json({ bet: formatBetResponse(updated) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/check-results', async (req, res) => {
  try {
    const summary = await runPendingResultCheck()
    res.json(summary)
  } catch (err) {
    console.error('[/api/check-results]', err)
    res.status(500).json({ error: err.message })
  }
})

const resultCheckInterval = setInterval(async () => {
  try {
    if (getPendingPredictions(db).length === 0) return
    const summary = await runPendingResultCheck()
    console.log(`[RaceEdge Results] checked=${summary.checked}, resolved=${summary.resolved}, stillPending=${summary.stillPending}, errors=${summary.errors.length}`)
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
process.on('SIGINT', shutdown)

if (process.env.NODE_ENV === 'production') {
  app.get('*', (req, res) => {
    res.sendFile(path.join(CLIENT_DIST_PATH, 'index.html'))
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
  executeBestBetsScan,
}
