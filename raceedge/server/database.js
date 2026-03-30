const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'raceedge.db')
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Australia/Sydney'

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS predictions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    track       TEXT NOT NULL,
    race_number INTEGER NOT NULL,
    race_type   TEXT NOT NULL,
    race_grade  TEXT,
    runner      TEXT NOT NULL,
    box_barrier INTEGER,
    mode        TEXT NOT NULL,
    confidence  REAL NOT NULL,
    result      TEXT NOT NULL DEFAULT 'pending',
    odds        REAL,
    stake       REAL NOT NULL DEFAULT 10,
    pnl         REAL,
    race_distance INTEGER,
    ai_recommendation TEXT,
    ai_agreed   INTEGER,
    resolved_automatically INTEGER NOT NULL DEFAULT 0,
    default_odds_used INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS scraper_health (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source_name      TEXT NOT NULL,
    race_date        TEXT NOT NULL,
    track            TEXT NOT NULL,
    race_number      INTEGER NOT NULL,
    status           TEXT NOT NULL,
    response_time_ms INTEGER NOT NULL,
    records_returned INTEGER NOT NULL DEFAULT 0,
    error_message    TEXT,
    checked_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS prediction_journal (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    prediction_id          INTEGER NOT NULL,
    race_date              TEXT NOT NULL,
    track                  TEXT NOT NULL,
    race_number            INTEGER NOT NULL,
    race_distance          INTEGER,
    all_runners_json       TEXT NOT NULL,
    sources_consulted_json TEXT NOT NULL,
    winner_name            TEXT NOT NULL,
    winner_box             INTEGER,
    winner_composite_score INTEGER NOT NULL,
    winner_breakdown_json  TEXT NOT NULL,
    ai_analysis_json       TEXT,
    mode_used              TEXT NOT NULL,
    box_bias_source        TEXT,
    raw_data_summary       TEXT NOT NULL,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (prediction_id) REFERENCES predictions(id)
  )
`

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some(column => column.name === columnName)
}

function ensureColumn(db, tableName, columnName, definition) {
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
  }
}

function parseJsonColumn(value, fallback) {
  if (!value) return fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function parseJournalRow(row) {
  if (!row) return undefined
  return {
    ...row,
    race_distance: row.race_distance == null ? null : Number(row.race_distance),
    winner_box: row.winner_box == null ? null : Number(row.winner_box),
    winner_composite_score: Number(row.winner_composite_score),
    all_runners: parseJsonColumn(row.all_runners_json, []),
    sources_consulted: parseJsonColumn(row.sources_consulted_json, []),
    winner_breakdown: parseJsonColumn(row.winner_breakdown_json, {}),
    ai_analysis: parseJsonColumn(row.ai_analysis_json, null),
  }
}

function todayDateString() {
  const formatter = new Intl.DateTimeFormat('en-AU', {
    timeZone: APP_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date()).map(part => [part.type, part.value])
  )
  return `${parts.year}-${parts.month}-${parts.day}`
}

function normalizeRunnerName(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function parsePredictionRow(row) {
  if (!row) return undefined

  return {
    ...row,
    race_date: row.date,
    confidence: row.confidence == null ? null : Number(row.confidence),
    odds: row.odds == null ? null : Number(row.odds),
    stake: row.stake == null ? null : Number(row.stake),
    pnl: row.pnl == null ? null : Number(row.pnl),
    race_distance: row.race_distance == null ? null : Number(row.race_distance),
    race_grade: row.race_grade ?? null,
    ai_recommendation: row.ai_recommendation ?? null,
    ai_agreed: row.ai_agreed == null ? null : Boolean(Number(row.ai_agreed)),
    resolved_automatically: Boolean(Number(row.resolved_automatically)),
    default_odds_used: Boolean(Number(row.default_odds_used)),
    result: row.result ?? 'pending',
  }
}

function initDb() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  ensureColumn(db, 'predictions', 'race_distance', 'INTEGER')
  ensureColumn(db, 'predictions', 'race_grade', 'TEXT')
  ensureColumn(db, 'predictions', 'ai_recommendation', 'TEXT')
  ensureColumn(db, 'predictions', 'ai_agreed', 'INTEGER')
  ensureColumn(db, 'predictions', 'resolved_automatically', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'predictions', 'default_odds_used', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'prediction_journal', 'race_distance', 'INTEGER')
  ensureColumn(db, 'prediction_journal', 'ai_analysis_json', 'TEXT')
  ensureColumn(db, 'prediction_journal', 'box_bias_source', 'TEXT')
  return db
}

function savePrediction(db, {
  date,
  track,
  race_number,
  race_type,
  race_grade = null,
  runner,
  box_barrier,
  mode,
  confidence,
  stake = 10,
  race_distance = null,
  odds = null,
  ai_recommendation = null,
  ai_agreed = null,
}) {
  const info = db.prepare(`
    INSERT INTO predictions (date, track, race_number, race_type, race_grade, runner, box_barrier, mode, confidence, stake, race_distance, odds, ai_recommendation, ai_agreed)
    VALUES (@date, @track, @race_number, @race_type, @race_grade, @runner, @box_barrier, @mode, @confidence, @stake, @race_distance, @odds, @ai_recommendation, @ai_agreed)
  `).run({
    date,
    track,
    race_number,
    race_type,
    race_grade,
    runner,
    box_barrier,
    mode,
    confidence,
    stake,
    race_distance,
    odds,
    ai_recommendation,
    ai_agreed: ai_agreed == null ? null : (ai_agreed ? 1 : 0),
  })
  return parsePredictionRow(db.prepare('SELECT * FROM predictions WHERE id = ?').get(info.lastInsertRowid))
}

function roundTo(value, digits = 1) {
  const factor = 10 ** digits
  return Math.round((Number(value) || 0) * factor) / factor
}

function roundCurrency(value) {
  return roundTo(value, 2)
}

function calculateWinRate(wins, total) {
  return total > 0 ? roundTo((wins / total) * 100, 1) : 0
}

function normalizeConfidenceValue(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return numeric <= 1 ? numeric * 100 : numeric
}

function comparePredictionsChronologically(left, right) {
  return String(left.date).localeCompare(String(right.date)) || (left.id - right.id)
}

function getResolvedPredictions(db) {
  return db.prepare(`
    SELECT *
    FROM predictions
    WHERE result IS NOT NULL
      AND result != 'pending'
  `).all().map(parsePredictionRow)
}

function getWinLossPredictions(db) {
  return db.prepare(`
    SELECT *
    FROM predictions
    WHERE result IN ('win', 'loss')
  `).all().map(parsePredictionRow)
}

function buildPerformanceSummary(rows, labelKey, labelValue) {
  const total = rows.length
  const wins = rows.filter(row => row.result === 'win').length
  return {
    [labelKey]: labelValue,
    total,
    wins,
    winRate: calculateWinRate(wins, total),
    pnl: roundCurrency(rows.reduce((sum, row) => sum + (row.pnl ?? 0), 0)),
  }
}

function getPredictions(db, limit = 100) {
  return db.prepare('SELECT * FROM predictions ORDER BY id DESC LIMIT ?').all(limit).map(parsePredictionRow)
}

function updateResult(db, id, result, odds) {
  const pred = db.prepare('SELECT stake FROM predictions WHERE id = ?').get(id)
  if (!pred) return undefined
  const stake = pred.stake ?? 10
  let pnl = null
  if (result === 'win' && odds != null) {
    pnl = Math.round(((odds * stake) - stake) * 100) / 100
  } else if (result === 'loss') {
    pnl = -stake
  } else if (result === 'scratched') {
    pnl = 0
  }
  db.prepare(`
    UPDATE predictions
    SET
      result = @result,
      odds = @odds,
      pnl = @pnl,
      resolved_automatically = 0,
      default_odds_used = 0
    WHERE id = @id
  `).run({ result, odds: odds ?? null, pnl, id })
  return parsePredictionRow(db.prepare('SELECT * FROM predictions WHERE id = ?').get(id))
}

function getPendingPredictions(db) {
  const today = todayDateString()

  return db.prepare(`
    SELECT *
    FROM predictions
    WHERE date < ?
      AND (result IS NULL OR result = 'pending')
    ORDER BY date DESC, race_number DESC, id DESC
  `).all(today).map(parsePredictionRow)
}

function autoResolveResult(db, predictionId, winner, odds) {
  const prediction = db.prepare('SELECT * FROM predictions WHERE id = ?').get(predictionId)
  if (!prediction) return undefined

  const normalizedPrediction = normalizeRunnerName(prediction.runner)
  const normalizedWinner = normalizeRunnerName(winner)
  const didWin = normalizedWinner.length > 0 && normalizedPrediction === normalizedWinner
  const stake = Number(prediction.stake ?? 10)
  const resolvedOdds = prediction.odds ?? odds ?? 2.0
  const defaultOddsUsed = didWin && prediction.odds == null && odds == null
  const result = didWin ? 'win' : 'loss'
  const pnl = didWin
    ? Math.round(((resolvedOdds * stake) - stake) * 100) / 100
    : -stake

  db.prepare(`
    UPDATE predictions
    SET
      result = @result,
      odds = @stored_odds,
      pnl = @pnl,
      resolved_automatically = 1,
      default_odds_used = @default_odds_used
    WHERE id = @id
  `).run({
    id: predictionId,
    result,
    stored_odds: didWin ? resolvedOdds : (prediction.odds ?? odds ?? null),
    pnl,
    default_odds_used: defaultOddsUsed ? 1 : 0,
  })

  return parsePredictionRow(db.prepare('SELECT * FROM predictions WHERE id = ?').get(predictionId))
}

function getStats(db) {
  const settled = getResolvedPredictions(db)
  const wins = settled.filter(p => p.result === 'win')
  const overall_win_rate = settled.length > 0
    ? Math.round((wins.length / settled.length) * 100)
    : 0

  const by_mode = ['safest', 'value', 'longshot'].map(mode => {
    const mp = settled.filter(p => p.mode === mode)
    const mw = mp.filter(p => p.result === 'win')
    return {
      mode,
      total: mp.length,
      wins: mw.length,
      win_rate: mp.length > 0 ? Math.round((mw.length / mp.length) * 100) : 0,
      pnl: roundCurrency(mp.reduce((sum, row) => sum + (row.pnl ?? 0), 0)),
    }
  })

  const by_type = ['greyhound', 'horse'].map(race_type => {
    const tp = settled.filter(p => p.race_type === race_type)
    const tw = tp.filter(p => p.result === 'win')
    return {
      race_type,
      total: tp.length,
      wins: tw.length,
      win_rate: tp.length > 0 ? Math.round((tw.length / tp.length) * 100) : 0,
      pnl: roundCurrency(tp.reduce((sum, row) => sum + (row.pnl ?? 0), 0)),
    }
  })

  const total_pnl = roundCurrency(settled.reduce((s, p) => s + (p.pnl ?? 0), 0))
  const last10 = db.prepare('SELECT * FROM predictions ORDER BY id DESC LIMIT 10').all().map(parsePredictionRow)
  const pending_count = getPendingPredictions(db).length

  return { overall_win_rate, by_mode, by_type, total_pnl, last10, pending_count, ai_agreement: getAIAgreementStats(db) }
}

function getStatsByTrack(db) {
  const rows = getResolvedPredictions(db)
  const grouped = new Map()

  for (const row of rows) {
    if (!grouped.has(row.track)) {
      grouped.set(row.track, [])
    }
    grouped.get(row.track).push(row)
  }

  return Array.from(grouped.entries())
    .map(([track, trackRows]) => buildPerformanceSummary(trackRows, 'track', track))
    .filter(row => row.total >= 3)
    .sort((left, right) => (
      right.winRate - left.winRate ||
      right.total - left.total ||
      String(left.track).localeCompare(String(right.track))
    ))
}

function getStatsByGrade(db) {
  const rows = getResolvedPredictions(db).filter(row => row.race_grade)
  const grouped = new Map()

  for (const row of rows) {
    if (!grouped.has(row.race_grade)) {
      grouped.set(row.race_grade, [])
    }
    grouped.get(row.race_grade).push(row)
  }

  return Array.from(grouped.entries())
    .map(([race_grade, gradeRows]) => buildPerformanceSummary(gradeRows, 'race_grade', race_grade))
    .filter(row => row.total >= 3)
    .sort((left, right) => (
      right.winRate - left.winRate ||
      right.total - left.total ||
      String(left.race_grade).localeCompare(String(right.race_grade))
    ))
}

function buildBoxPerformanceRows(rows, scoreMap) {
  const grouped = new Map(
    Array.from({ length: 8 }, (_, index) => [
      index + 1,
      { total: 0, wins: 0, scores: [] },
    ])
  )

  for (const row of rows) {
    const box = Number(row.box_barrier)
    if (!Number.isFinite(box) || box < 1 || box > 8) continue

    const entry = grouped.get(box)
    entry.total += 1
    if (row.result === 'win') {
      entry.wins += 1
    }

    const compositeScore = scoreMap.get(row.id)
    if (Number.isFinite(compositeScore)) {
      entry.scores.push(compositeScore)
    }
  }

  return Array.from(grouped.entries()).map(([box, entry]) => ({
    box,
    total: entry.total,
    wins: entry.wins,
    winRate: calculateWinRate(entry.wins, entry.total),
    avgCompositeScore: entry.scores.length > 0
      ? roundTo(entry.scores.reduce((sum, score) => sum + score, 0) / entry.scores.length, 1)
      : null,
  }))
}

function getStatsByBox(db) {
  const rows = getWinLossPredictions(db).filter(row => {
    const box = Number(row.box_barrier)
    return Number.isFinite(box) && box >= 1 && box <= 8
  })

  const journalRows = db.prepare(`
    SELECT prediction_id, winner_composite_score
    FROM prediction_journal
    ORDER BY id DESC
  `).all()

  const scoreMap = new Map()
  for (const row of journalRows) {
    if (!scoreMap.has(row.prediction_id)) {
      scoreMap.set(row.prediction_id, Number(row.winner_composite_score))
    }
  }

  const byTrackMap = new Map()
  for (const row of rows) {
    if (!byTrackMap.has(row.track)) {
      byTrackMap.set(row.track, [])
    }
    byTrackMap.get(row.track).push(row)
  }

  return {
    overall: buildBoxPerformanceRows(rows, scoreMap),
    byTrack: Array.from(byTrackMap.entries())
      .map(([track, trackRows]) => ({
        track,
        total: trackRows.length,
        boxes: buildBoxPerformanceRows(trackRows, scoreMap),
      }))
      .sort((left, right) => String(left.track).localeCompare(String(right.track))),
  }
}

function getLastTwelveMonthKeys() {
  const [year, month] = todayDateString().slice(0, 7).split('-').map(Number)
  return Array.from({ length: 12 }, (_, index) => {
    const cursor = new Date(Date.UTC(year, (month - 1) - (11 - index), 1))
    const cursorYear = cursor.getUTCFullYear()
    const cursorMonth = String(cursor.getUTCMonth() + 1).padStart(2, '0')
    return `${cursorYear}-${cursorMonth}`
  })
}

function getStatsByMonth(db) {
  const rows = getResolvedPredictions(db)
  const months = getLastTwelveMonthKeys()
  const grouped = new Map(months.map(month => [month, { month, total: 0, wins: 0, pnl: 0 }]))

  for (const row of rows) {
    const monthKey = String(row.date || '').slice(0, 7)
    if (!grouped.has(monthKey)) continue

    const entry = grouped.get(monthKey)
    entry.total += 1
    if (row.result === 'win') {
      entry.wins += 1
    }
    entry.pnl += row.pnl ?? 0
  }

  return months.map(month => {
    const entry = grouped.get(month)
    return {
      month,
      total: entry.total,
      wins: entry.wins,
      winRate: calculateWinRate(entry.wins, entry.total),
      pnl: roundCurrency(entry.pnl),
    }
  })
}

function getCalibrationData(db) {
  const buckets = [
    { bucket: '50-59%', min: 50, max: 59, predictedPct: 55 },
    { bucket: '60-69%', min: 60, max: 69, predictedPct: 65 },
    { bucket: '70-79%', min: 70, max: 79, predictedPct: 75 },
    { bucket: '80-89%', min: 80, max: 89, predictedPct: 85 },
    { bucket: '90%+', min: 90, max: Infinity, predictedPct: 95 },
  ].map(bucket => ({ ...bucket, total: 0, wins: 0 }))

  for (const row of getWinLossPredictions(db)) {
    const confidence = normalizeConfidenceValue(row.confidence)
    if (!Number.isFinite(confidence) || confidence < 50) continue

    const bucket = buckets.find(entry => confidence >= entry.min && confidence <= entry.max)
    if (!bucket) continue

    bucket.total += 1
    if (row.result === 'win') {
      bucket.wins += 1
    }
  }

  return buckets.map(bucket => ({
    bucket: bucket.bucket,
    predicted: bucket.bucket,
    predictedPct: bucket.predictedPct,
    total: bucket.total,
    wins: bucket.wins,
    actualWinRate: calculateWinRate(bucket.wins, bucket.total),
  }))
}

function getStreakData(db) {
  const rows = getWinLossPredictions(db).sort(comparePredictionsChronologically)
  if (rows.length === 0) {
    return { current: 0, longest: 0, currentLoss: 0, longestLoss: 0 }
  }

  let longest = 0
  let longestLoss = 0
  let winRun = 0
  let lossRun = 0

  for (const row of rows) {
    if (row.result === 'win') {
      winRun += 1
      lossRun = 0
      longest = Math.max(longest, winRun)
    } else if (row.result === 'loss') {
      lossRun += 1
      winRun = 0
      longestLoss = Math.max(longestLoss, lossRun)
    }
  }

  const descending = [...rows].sort((left, right) => comparePredictionsChronologically(right, left))
  const latestResult = descending[0]?.result
  let current = 0
  let currentLoss = 0

  for (const row of descending) {
    if (row.result !== latestResult) break
    if (latestResult === 'win') {
      current += 1
    } else if (latestResult === 'loss') {
      currentLoss += 1
    }
  }

  return { current, longest, currentLoss, longestLoss }
}

function getProfitCurve(db) {
  const rows = db.prepare(`
    SELECT *
    FROM predictions
    ORDER BY date ASC, id ASC
  `).all().map(parsePredictionRow)

  let runningPnl = 0
  let settledCount = 0
  let winCount = 0

  return rows.map(row => {
    runningPnl += row.pnl ?? 0

    if (row.result === 'win') {
      settledCount += 1
      winCount += 1
    } else if (row.result === 'loss') {
      settledCount += 1
    }

    return {
      date: row.date,
      runningPnl: roundCurrency(runningPnl),
      runningWinRate: settledCount > 0 ? calculateWinRate(winCount, settledCount) : 0,
    }
  })
}

function getAIAgreementStats(db) {
  const rows = db.prepare(`
    SELECT *
    FROM predictions
    WHERE ai_recommendation IS NOT NULL
      AND ai_recommendation != ''
  `).all().map(parsePredictionRow)

  const totalWithAI = rows.length
  const agreedRows = rows.filter(row => row.ai_agreed === true)
  const disagreedRows = rows.filter(row => row.ai_agreed === false)
  const settledAgreed = agreedRows.filter(row => row.result && row.result !== 'pending')
  const settledDisagreed = disagreedRows.filter(row => row.result && row.result !== 'pending')
  const agreedWins = settledAgreed.filter(row => row.result === 'win').length
  const disagreedWins = settledDisagreed.filter(row => row.result === 'win').length

  return {
    totalWithAI,
    agreedCount: agreedRows.length,
    agreedWinRate: settledAgreed.length > 0 ? Math.round((agreedWins / settledAgreed.length) * 100) : 0,
    disagreedWinRate: settledDisagreed.length > 0 ? Math.round((disagreedWins / settledDisagreed.length) * 100) : 0,
  }
}

function logScraperHealth(db, entry) {
  const info = db.prepare(`
    INSERT INTO scraper_health (
      source_name, race_date, track, race_number, status,
      response_time_ms, records_returned, error_message
    )
    VALUES (
      @source_name, @race_date, @track, @race_number, @status,
      @response_time_ms, @records_returned, @error_message
    )
  `).run({
    ...entry,
    records_returned: entry.records_returned ?? 0,
    error_message: entry.error_message ?? null,
  })

  return db.prepare('SELECT * FROM scraper_health WHERE id = ?').get(info.lastInsertRowid)
}

function getScraperStats(db) {
  const rows = db.prepare(`
    WITH recent AS (
      SELECT *
      FROM scraper_health
      WHERE checked_at >= datetime('now', '-7 days')
    ),
    source_summary AS (
      SELECT
        source_name,
        COUNT(*) AS total_attempts,
        SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS success_count,
        ROUND(
          CASE
            WHEN COUNT(*) = 0 THEN 0
            ELSE (SUM(CASE WHEN status = 'success' THEN 1.0 ELSE 0 END) / COUNT(*)) * 100
          END,
          1
        ) AS success_rate_pct,
        ROUND(AVG(response_time_ms)) AS average_response_time_ms,
        MAX(checked_at) AS last_checked
      FROM recent
      GROUP BY source_name
    )
    SELECT
      summary.source_name,
      summary.total_attempts,
      summary.success_count,
      summary.success_rate_pct,
      summary.average_response_time_ms,
      summary.last_checked,
      (
        SELECT recent_error.error_message
        FROM recent AS recent_error
        WHERE recent_error.source_name = summary.source_name
          AND recent_error.error_message IS NOT NULL
          AND recent_error.error_message != ''
        ORDER BY recent_error.checked_at DESC, recent_error.id DESC
        LIMIT 1
      ) AS last_seen_error
    FROM source_summary AS summary
    ORDER BY summary.source_name
  `).all()

  return rows.map(row => ({
    ...row,
    success_rate_pct: Number(row.success_rate_pct),
    average_response_time_ms: row.average_response_time_ms == null
      ? null
      : Number(row.average_response_time_ms),
  }))
}

function getBoxBiasStats(db, track, distance) {
  const normalizedDistance = Number(distance)
  if (!track || !Number.isFinite(normalizedDistance)) return null

  const rows = db.prepare(`
    SELECT
      box_barrier AS box,
      COUNT(*) AS total_predictions,
      SUM(CASE WHEN result = 'win' THEN 1 ELSE 0 END) AS win_count,
      ROUND(
        CASE
          WHEN COUNT(*) = 0 THEN 0
          ELSE (SUM(CASE WHEN result = 'win' THEN 1.0 ELSE 0 END) / COUNT(*)) * 100
        END,
        1
      ) AS win_rate_pct
    FROM predictions
    WHERE lower(track) = lower(?)
      AND race_distance IS NOT NULL
      AND ABS(race_distance - ?) <= 50
      AND box_barrier BETWEEN 1 AND 8
      AND result IN ('win', 'loss')
    GROUP BY box_barrier
    ORDER BY box_barrier
  `).all(track, normalizedDistance)

  const totalResults = rows.reduce((sum, row) => sum + Number(row.total_predictions), 0)
  if (totalResults < 10) return null

  return {
    track,
    distance: normalizedDistance,
    total_results: totalResults,
    boxes: rows.map(row => ({
      box: Number(row.box),
      total_predictions: Number(row.total_predictions),
      win_count: Number(row.win_count),
      win_rate_pct: Number(row.win_rate_pct),
    })),
  }
}

function saveJournalEntry(db, entry) {
  const info = db.prepare(`
    INSERT INTO prediction_journal (
      prediction_id,
      race_date,
      track,
      race_number,
      race_distance,
      all_runners_json,
      sources_consulted_json,
      winner_name,
      winner_box,
      winner_composite_score,
      winner_breakdown_json,
      ai_analysis_json,
      mode_used,
      box_bias_source,
      raw_data_summary
    )
    VALUES (
      @prediction_id,
      @race_date,
      @track,
      @race_number,
      @race_distance,
      @all_runners_json,
      @sources_consulted_json,
      @winner_name,
      @winner_box,
      @winner_composite_score,
      @winner_breakdown_json,
      @ai_analysis_json,
      @mode_used,
      @box_bias_source,
      @raw_data_summary
    )
  `).run({
    ...entry,
    race_distance: entry.race_distance ?? null,
    winner_box: entry.winner_box ?? null,
    all_runners_json: JSON.stringify(entry.all_runners_json ?? []),
    sources_consulted_json: JSON.stringify(entry.sources_consulted_json ?? []),
    winner_breakdown_json: JSON.stringify(entry.winner_breakdown_json ?? {}),
    ai_analysis_json: entry.ai_analysis_json == null ? null : JSON.stringify(entry.ai_analysis_json),
    box_bias_source: entry.box_bias_source ?? null,
  })

  return db.prepare('SELECT * FROM prediction_journal WHERE id = ?').get(info.lastInsertRowid)
}

function getJournalEntry(db, predictionId) {
  const row = db.prepare(`
    SELECT *
    FROM prediction_journal
    WHERE prediction_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(predictionId)

  return parseJournalRow(row)
}

function getJournalHistory(db, limit = 20) {
  const rows = db.prepare(`
    SELECT *
    FROM prediction_journal
    ORDER BY id DESC
    LIMIT ?
  `).all(limit)

  return rows.map(parseJournalRow)
}

module.exports = {
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
  getAIAgreementStats,
  logScraperHealth,
  getScraperStats,
  getBoxBiasStats,
  saveJournalEntry,
  getJournalEntry,
  getJournalHistory,
}
