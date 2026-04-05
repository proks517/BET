const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'raceedge.db')
const APP_TIMEZONE = process.env.APP_TIMEZONE || 'Australia/Sydney'
const ACTIVE_RECORD_KIND = 'placed_bet'
const LEGACY_RECORD_KIND = 'legacy_prediction'

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
    odds_source TEXT,
    win_probability REAL,
    ev          REAL,
    expected_return REAL,
    stake       REAL NOT NULL DEFAULT 10,
    pnl         REAL,
    race_distance INTEGER,
    record_kind TEXT NOT NULL DEFAULT 'legacy_prediction',
    placed_at   TEXT,
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
`

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some(column => column.name === columnName)
}

function ensureColumn(db, tableName, columnName, definition) {
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`)
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
    odds_source: row.odds_source ?? null,
    win_probability: row.win_probability == null ? null : Number(row.win_probability),
    ev: row.ev == null ? null : Number(row.ev),
    expected_return: row.expected_return == null ? null : Number(row.expected_return),
    stake: row.stake == null ? null : Number(row.stake),
    pnl: row.pnl == null ? null : Number(row.pnl),
    race_distance: row.race_distance == null ? null : Number(row.race_distance),
    race_grade: row.race_grade ?? null,
    record_kind: row.record_kind ?? LEGACY_RECORD_KIND,
    placed_at: row.placed_at ?? null,
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
  ensureColumn(db, 'predictions', 'odds_source', 'TEXT')
  ensureColumn(db, 'predictions', 'win_probability', 'REAL')
  ensureColumn(db, 'predictions', 'ev', 'REAL')
  ensureColumn(db, 'predictions', 'expected_return', 'REAL')
  ensureColumn(db, 'predictions', 'record_kind', `TEXT NOT NULL DEFAULT '${LEGACY_RECORD_KIND}'`)
  ensureColumn(db, 'predictions', 'placed_at', 'TEXT')
  ensureColumn(db, 'predictions', 'resolved_automatically', 'INTEGER NOT NULL DEFAULT 0')
  ensureColumn(db, 'predictions', 'default_odds_used', 'INTEGER NOT NULL DEFAULT 0')
  db.prepare(`
    UPDATE predictions
    SET record_kind = ?
    WHERE record_kind IS NULL OR trim(record_kind) = ''
  `).run(LEGACY_RECORD_KIND)
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
  odds_source = null,
  win_probability = null,
  ev = null,
  expected_return = null,
  record_kind = ACTIVE_RECORD_KIND,
  placed_at = record_kind === ACTIVE_RECORD_KIND ? new Date().toISOString() : null,
}) {
  const info = db.prepare(`
    INSERT INTO predictions (
      date, track, race_number, race_type, race_grade, runner, box_barrier,
      mode, confidence, stake, race_distance, odds, odds_source,
      win_probability, ev, expected_return, record_kind, placed_at
    )
    VALUES (
      @date, @track, @race_number, @race_type, @race_grade, @runner, @box_barrier,
      @mode, @confidence, @stake, @race_distance, @odds, @odds_source,
      @win_probability, @ev, @expected_return, @record_kind, @placed_at
    )
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
    odds_source,
    win_probability,
    ev,
    expected_return,
    record_kind,
    placed_at,
  })

  return parsePredictionRow(db.prepare('SELECT * FROM predictions WHERE id = ?').get(info.lastInsertRowid))
}

function getPrediction(db, id) {
  return parsePredictionRow(db.prepare('SELECT * FROM predictions WHERE id = ?').get(id))
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

function activeRecordWhereClause(alias = '') {
  const prefix = alias ? `${alias}.` : ''
  return `${prefix}record_kind = '${ACTIVE_RECORD_KIND}'`
}

function getPredictions(db, limit = 100) {
  return db.prepare(`
    SELECT *
    FROM predictions
    WHERE ${activeRecordWhereClause()}
    ORDER BY COALESCE(placed_at, created_at) DESC, id DESC
    LIMIT ?
  `).all(limit).map(parsePredictionRow)
}

function updateResult(db, id, result, odds) {
  const prediction = db.prepare(`
    SELECT stake
    FROM predictions
    WHERE id = ?
      AND ${activeRecordWhereClause()}
  `).get(id)

  if (!prediction) return undefined

  const stake = prediction.stake ?? 10
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
    WHERE ${activeRecordWhereClause()}
      AND date < ?
      AND (result IS NULL OR result = 'pending')
    ORDER BY date DESC, race_number DESC, id DESC
  `).all(today).map(parsePredictionRow)
}

function autoResolveResult(db, predictionId, winner, odds) {
  const prediction = db.prepare(`
    SELECT *
    FROM predictions
    WHERE id = ?
      AND ${activeRecordWhereClause()}
  `).get(predictionId)

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

function getBetLedgerSummary(db) {
  const bets = getPredictions(db, 1000)
  const settled = bets.filter(bet => bet.result && bet.result !== 'pending')
  const wins = settled.filter(bet => bet.result === 'win')
  const losses = settled.filter(bet => bet.result === 'loss')
  const pending = bets.filter(bet => !bet.result || bet.result === 'pending')
  const totalPnl = roundCurrency(settled.reduce((sum, bet) => sum + (bet.pnl ?? 0), 0))
  const totalStaked = bets.reduce((sum, bet) => sum + (bet.stake ?? 0), 0)

  return {
    totalBets: bets.length,
    settledBets: settled.length,
    pendingBets: pending.length,
    wins: wins.length,
    losses: losses.length,
    strikeRate: calculateWinRate(wins.length, settled.length),
    totalPnl,
    totalStaked: roundCurrency(totalStaked),
    roi: totalStaked > 0 ? roundTo((totalPnl / totalStaked) * 100, 1) : 0,
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
    WHERE ${activeRecordWhereClause()}
      AND lower(track) = lower(?)
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

module.exports = {
  initDb,
  getPrediction,
  savePrediction,
  getPredictions,
  getBetLedgerSummary,
  updateResult,
  getPendingPredictions,
  autoResolveResult,
  logScraperHealth,
  getBoxBiasStats,
}
