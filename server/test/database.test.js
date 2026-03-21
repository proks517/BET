const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')

process.env.DB_PATH = ':memory:'

const { initDb, savePrediction, getPredictions, updateResult, getStats } = require('../database.js')

let db

before(() => { db = initDb() })
after(() => { db.close() })

describe('savePrediction', () => {
  test('saves a prediction and returns it with an id', () => {
    const saved = savePrediction(db, {
      date: '2026-03-20', track: 'Sandown Park', race_number: 3,
      race_type: 'greyhound', runner: 'Fast Dog', box_barrier: 2,
      mode: 'safest', confidence: 0.78
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
