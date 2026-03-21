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
  )
`

function initDb() {
  const db = new Database(DB_PATH)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  return db
}

function savePrediction(db, { date, track, race_number, race_type, runner, box_barrier, mode, confidence }) {
  const info = db.prepare(`
    INSERT INTO predictions (date, track, race_number, race_type, runner, box_barrier, mode, confidence)
    VALUES (@date, @track, @race_number, @race_type, @runner, @box_barrier, @mode, @confidence)
  `).run({ date, track, race_number, race_type, runner, box_barrier, mode, confidence })
  return db.prepare('SELECT * FROM predictions WHERE id = ?').get(info.lastInsertRowid)
}

function getPredictions(db, limit = 100) {
  return db.prepare('SELECT * FROM predictions ORDER BY id DESC LIMIT ?').all(limit)
}

function updateResult(db, id, result, odds) {
  const stake = 10
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

module.exports = { initDb, savePrediction, getPredictions, updateResult, getStats }
