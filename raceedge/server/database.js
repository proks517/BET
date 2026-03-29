const Database = require('better-sqlite3')
const path = require('path')

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'raceedge.db')

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS predictions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT NOT NULL,
    track       TEXT NOT NULL,
    race_number INTEGER NOT NULL,
    race_type   TEXT NOT NULL,
    runner      TEXT NOT NULL,
    box_barrier INTEGER,
    mode        TEXT NOT NULL,
    confidence  REAL NOT NULL,
    result      TEXT NOT NULL DEFAULT 'pending',
    odds        REAL,
    stake       REAL NOT NULL DEFAULT 10,
    pnl         REAL,
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
  )
`

function initDb() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

function savePrediction(db, { date, track, race_number, race_type, runner, box_barrier, mode, confidence, stake = 10 }) {
  const info = db.prepare(`
    INSERT INTO predictions (date, track, race_number, race_type, runner, box_barrier, mode, confidence, stake)
    VALUES (@date, @track, @race_number, @race_type, @runner, @box_barrier, @mode, @confidence, @stake)
  `).run({ date, track, race_number, race_type, runner, box_barrier, mode, confidence, stake })
  return db.prepare('SELECT * FROM predictions WHERE id = ?').get(info.lastInsertRowid)
}

function getPredictions(db, limit = 100) {
  return db.prepare('SELECT * FROM predictions ORDER BY id DESC LIMIT ?').all(limit)
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
    UPDATE predictions SET result = @result, odds = @odds, pnl = @pnl WHERE id = @id
  `).run({ result, odds: odds ?? null, pnl, id })
  return db.prepare('SELECT * FROM predictions WHERE id = ?').get(id)
}

function getStats(db) {
  const settled = db.prepare(`SELECT * FROM predictions WHERE result != 'pending'`).all()
  const wins = settled.filter(p => p.result === 'win')
  const overall_win_rate = settled.length > 0
    ? Math.round((wins.length / settled.length) * 100)
    : 0

  const by_mode = ['safest', 'value', 'longshot'].map(mode => {
    const mp = settled.filter(p => p.mode === mode)
    const mw = mp.filter(p => p.result === 'win')
    return { mode, total: mp.length, wins: mw.length, win_rate: mp.length > 0 ? Math.round((mw.length / mp.length) * 100) : 0 }
  })

  const by_type = ['greyhound', 'horse'].map(race_type => {
    const tp = settled.filter(p => p.race_type === race_type)
    const tw = tp.filter(p => p.result === 'win')
    return { race_type, total: tp.length, wins: tw.length, win_rate: tp.length > 0 ? Math.round((tw.length / tp.length) * 100) : 0 }
  })

  const total_pnl = Math.round(settled.reduce((s, p) => s + (p.pnl ?? 0), 0) * 100) / 100
  const last10 = db.prepare('SELECT * FROM predictions ORDER BY id DESC LIMIT 10').all()

  return { overall_win_rate, by_mode, by_type, total_pnl, last10 }
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

module.exports = {
  initDb,
  savePrediction,
  getPredictions,
  updateResult,
  getStats,
  logScraperHealth,
  getScraperStats,
}
