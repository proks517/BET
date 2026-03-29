const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

process.env.DB_PATH = ':memory:'

const {
  initDb,
  savePrediction,
  getPredictions,
  updateResult,
  getStats,
  logScraperHealth,
  getScraperStats,
} = require('../database.js')

let db

before(() => { db = initDb() })
after(() => { db.close() })

describe('savePrediction', () => {
  test('saves a prediction and returns it with an id', () => {
    const saved = savePrediction(db, {
      date: '2026-03-20', track: 'Sandown Park', race_number: 3,
      race_type: 'greyhound', runner: 'Fast Dog', box_barrier: 2,
      mode: 'safest', confidence: 0.78, stake: 10
    })
    assert.ok(saved.id > 0)
    assert.equal(saved.runner, 'Fast Dog')
    assert.equal(saved.result, 'pending')
    assert.equal(saved.stake, 10)
  })
})

describe('getPredictions', () => {
  test('returns array newest first', () => {
    const preds = getPredictions(db)
    assert.ok(Array.isArray(preds))
    assert.ok(preds.length >= 1)
    if (preds.length > 1) assert.ok(preds[0].id >= preds[1].id)
  })
})

describe('updateResult', () => {
  test('win with odds calculates positive pnl', () => {
    const pred = savePrediction(db, {
      date: '2026-03-20', track: 'Flemington', race_number: 1,
      race_type: 'horse', runner: 'Champion', box_barrier: 5,
      mode: 'value', confidence: 0.65
    })
    const updated = updateResult(db, pred.id, 'win', 4.50)
    assert.equal(updated.result, 'win')
    assert.equal(updated.odds, 4.50)
    assert.equal(updated.pnl, 35.00) // (4.5 × 10) - 10
  })

  test('loss results in -$10 pnl', () => {
    const pred = savePrediction(db, {
      date: '2026-03-20', track: 'Randwick', race_number: 2,
      race_type: 'horse', runner: 'Slowpoke', box_barrier: 8,
      mode: 'longshot', confidence: 0.40
    })
    const updated = updateResult(db, pred.id, 'loss', 12.00)
    assert.equal(updated.result, 'loss')
    assert.equal(updated.pnl, -10.00)
  })

  test('scratched results in zero pnl', () => {
    const pred = savePrediction(db, {
      date: '2026-03-20', track: 'Caulfield', race_number: 4,
      race_type: 'horse', runner: 'Absent', box_barrier: 3,
      mode: 'safest', confidence: 0.70
    })
    const updated = updateResult(db, pred.id, 'scratched', null)
    assert.equal(updated.result, 'scratched')
    assert.equal(updated.pnl, 0)
  })
})

test('variable stake P&L calculation', () => {
  const saved = savePrediction(db, {
    date: '2026-03-28', track: 'Test Track', race_number: 3, race_type: 'greyhound',
    runner: 'Stake Test Dog', box_barrier: 1, mode: 'safest', confidence: 0.8, stake: 20,
  })
  const updated = updateResult(db, saved.id, 'win', 3.00)
  assert.equal(updated.pnl, 40.00) // (3 * 20) - 20 = 40
})

describe('getStats', () => {
  test('returns win rates and pnl totals', () => {
    const stats = getStats(db)
    assert.ok(typeof stats.overall_win_rate === 'number')
    assert.ok(Array.isArray(stats.by_mode))
    assert.ok(Array.isArray(stats.by_type))
    assert.ok(typeof stats.total_pnl === 'number')
    assert.ok(Array.isArray(stats.last10))
  })
})

describe('scraper health', () => {
  beforeEach(() => {
    db.exec('DELETE FROM scraper_health')
  })

  test('logScraperHealth saves a record correctly', () => {
    const saved = logScraperHealth(db, {
      source_name: 'thedogs',
      race_date: '2026-03-29',
      track: 'Sandown Park',
      race_number: 5,
      status: 'success',
      response_time_ms: 215,
      records_returned: 8,
      error_message: null,
    })

    assert.ok(saved.id > 0)
    assert.equal(saved.source_name, 'thedogs')
    assert.equal(saved.race_date, '2026-03-29')
    assert.equal(saved.track, 'Sandown Park')
    assert.equal(saved.race_number, 5)
    assert.equal(saved.status, 'success')
    assert.equal(saved.response_time_ms, 215)
    assert.equal(saved.records_returned, 8)
    assert.equal(saved.error_message, null)
    assert.ok(saved.checked_at)
  })

  test('getScraperStats returns correct aggregates for mixed success/fail data', () => {
    logScraperHealth(db, {
      source_name: 'thedogs',
      race_date: '2026-03-29',
      track: 'Sandown Park',
      race_number: 1,
      status: 'success',
      response_time_ms: 120,
      records_returned: 8,
      error_message: null,
    })
    logScraperHealth(db, {
      source_name: 'thedogs',
      race_date: '2026-03-29',
      track: 'Sandown Park',
      race_number: 2,
      status: 'empty',
      response_time_ms: 180,
      records_returned: 0,
      error_message: null,
    })
    logScraperHealth(db, {
      source_name: 'thedogs',
      race_date: '2026-03-29',
      track: 'Sandown Park',
      race_number: 3,
      status: 'timeout',
      response_time_ms: 1000,
      records_returned: 0,
      error_message: 'Request timed out',
    })
    logScraperHealth(db, {
      source_name: 'racenet',
      race_date: '2026-03-29',
      track: 'Randwick',
      race_number: 4,
      status: 'error',
      response_time_ms: 400,
      records_returned: 0,
      error_message: 'Bad gateway',
    })
    logScraperHealth(db, {
      source_name: 'racenet',
      race_date: '2026-03-29',
      track: 'Randwick',
      race_number: 5,
      status: 'success',
      response_time_ms: 200,
      records_returned: 12,
      error_message: null,
    })

    const oldRecord = logScraperHealth(db, {
      source_name: 'tab',
      race_date: '2026-03-20',
      track: 'Caulfield',
      race_number: 6,
      status: 'error',
      response_time_ms: 350,
      records_returned: 0,
      error_message: 'Too old to count',
    })
    db.prepare(`
      UPDATE scraper_health
      SET checked_at = datetime('now', '-8 days')
      WHERE id = ?
    `).run(oldRecord.id)

    const stats = getScraperStats(db)
    const dogs = stats.find(row => row.source_name === 'thedogs')
    const racenet = stats.find(row => row.source_name === 'racenet')
    const tab = stats.find(row => row.source_name === 'tab')

    assert.equal(stats.length, 2)
    assert.equal(tab, undefined)

    assert.ok(dogs)
    assert.equal(dogs.total_attempts, 3)
    assert.equal(dogs.success_count, 1)
    assert.equal(dogs.success_rate_pct, 33.3)
    assert.equal(dogs.average_response_time_ms, 433)
    assert.equal(dogs.last_seen_error, 'Request timed out')
    assert.ok(dogs.last_checked)

    assert.ok(racenet)
    assert.equal(racenet.total_attempts, 2)
    assert.equal(racenet.success_count, 1)
    assert.equal(racenet.success_rate_pct, 50)
    assert.equal(racenet.average_response_time_ms, 300)
    assert.equal(racenet.last_seen_error, 'Bad gateway')
    assert.ok(racenet.last_checked)
  })
})
