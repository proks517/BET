const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

process.env.DB_PATH = ':memory:'

const {
  initDb,
  savePrediction,
  getPredictions,
  getBetLedgerSummary,
  updateResult,
  getPendingPredictions,
  autoResolveResult,
  logScraperHealth,
  getBoxBiasStats,
} = require('../database.js')

let db
let predictionSeed = 0

before(() => {
  db = initDb()
})

after(() => {
  db.close()
})

beforeEach(() => {
  db.exec('DELETE FROM scraper_health')
  db.exec('DELETE FROM predictions')
})

function dateOffset(days) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' })
    .format(new Date(Date.now() + (days * 24 * 60 * 60 * 1000)))
}

function saveSettledPrediction({
  date = '2026-03-29',
  track = 'Richmond',
  race_number = 1,
  race_type = 'greyhound',
  runner = `Runner ${++predictionSeed}`,
  box_barrier = 1,
  mode = 'safest',
  confidence = 70,
  stake = 10,
  race_distance = 320,
  result = 'win',
  odds = 2.5,
} = {}) {
  const saved = savePrediction(db, {
    date,
    track,
    race_number,
    race_type,
    runner,
    box_barrier,
    mode,
    confidence,
    stake,
    race_distance,
  })

  return updateResult(db, saved.id, result, odds)
}

describe('savePrediction', () => {
  test('stores a placed bet by default', () => {
    const saved = savePrediction(db, {
      date: '2026-03-20',
      track: 'Sandown Park',
      race_number: 3,
      race_type: 'greyhound',
      runner: 'Fast Dog',
      box_barrier: 2,
      mode: 'safest',
      confidence: 78,
      stake: 10,
    })

    assert.ok(saved.id > 0)
    assert.equal(saved.runner, 'Fast Dog')
    assert.equal(saved.result, 'pending')
    assert.equal(saved.stake, 10)
    assert.equal(saved.record_kind, 'placed_bet')
    assert.ok(saved.placed_at)
  })
})

describe('getPredictions', () => {
  test('returns active bets newest first by placement time', () => {
    savePrediction(db, {
      date: '2026-03-18',
      track: 'Richmond',
      race_number: 1,
      race_type: 'greyhound',
      runner: 'Earlier Bet',
      box_barrier: 1,
      mode: 'safest',
      confidence: 68,
      placed_at: '2026-03-18T01:00:00.000Z',
    })

    savePrediction(db, {
      date: '2026-03-19',
      track: 'Richmond',
      race_number: 2,
      race_type: 'greyhound',
      runner: 'Later Bet',
      box_barrier: 2,
      mode: 'value',
      confidence: 74,
      placed_at: '2026-03-19T01:00:00.000Z',
    })

    const predictions = getPredictions(db)

    assert.equal(predictions.length, 2)
    assert.equal(predictions[0].runner, 'Later Bet')
    assert.equal(predictions[1].runner, 'Earlier Bet')
  })

  test('excludes archived legacy rows from the active bet ledger', () => {
    savePrediction(db, {
      date: '2026-03-18',
      track: 'Richmond',
      race_number: 1,
      race_type: 'greyhound',
      runner: 'Legacy Runner',
      box_barrier: 1,
      mode: 'safest',
      confidence: 68,
      record_kind: 'legacy_prediction',
      placed_at: null,
    })

    savePrediction(db, {
      date: '2026-03-19',
      track: 'Richmond',
      race_number: 2,
      race_type: 'greyhound',
      runner: 'Placed Runner',
      box_barrier: 2,
      mode: 'value',
      confidence: 74,
    })

    const predictions = getPredictions(db)

    assert.equal(predictions.length, 1)
    assert.equal(predictions[0].runner, 'Placed Runner')
    assert.equal(predictions[0].record_kind, 'placed_bet')
  })
})

describe('updateResult', () => {
  test('win with odds calculates positive pnl', () => {
    const prediction = savePrediction(db, {
      date: '2026-03-20',
      track: 'Flemington',
      race_number: 1,
      race_type: 'horse',
      runner: 'Champion',
      box_barrier: 5,
      mode: 'value',
      confidence: 65,
    })

    const updated = updateResult(db, prediction.id, 'win', 4.5)

    assert.equal(updated.result, 'win')
    assert.equal(updated.odds, 4.5)
    assert.equal(updated.pnl, 35)
  })

  test('loss and scratched outcomes calculate correctly', () => {
    const lossPrediction = savePrediction(db, {
      date: '2026-03-20',
      track: 'Randwick',
      race_number: 2,
      race_type: 'horse',
      runner: 'Slowpoke',
      box_barrier: 8,
      mode: 'longshot',
      confidence: 40,
    })

    const scratchedPrediction = savePrediction(db, {
      date: '2026-03-20',
      track: 'Caulfield',
      race_number: 4,
      race_type: 'horse',
      runner: 'Absent',
      box_barrier: 3,
      mode: 'safest',
      confidence: 70,
    })

    const loss = updateResult(db, lossPrediction.id, 'loss', 12)
    const scratched = updateResult(db, scratchedPrediction.id, 'scratched', null)

    assert.equal(loss.pnl, -10)
    assert.equal(scratched.pnl, 0)
  })

  test('uses the recorded stake when calculating pnl', () => {
    const saved = savePrediction(db, {
      date: '2026-03-28',
      track: 'Test Track',
      race_number: 3,
      race_type: 'greyhound',
      runner: 'Stake Test Dog',
      box_barrier: 1,
      mode: 'safest',
      confidence: 80,
      stake: 20,
    })

    const updated = updateResult(db, saved.id, 'win', 3)

    assert.equal(updated.pnl, 40)
  })
})

describe('getBetLedgerSummary', () => {
  test('summarises only active placed bets', () => {
    const activeWin = savePrediction(db, {
      date: '2026-03-20',
      track: 'Richmond',
      race_number: 3,
      race_type: 'greyhound',
      runner: 'Active Win',
      box_barrier: 3,
      mode: 'value',
      confidence: 71,
      stake: 15,
    })
    updateResult(db, activeWin.id, 'win', 4)

    const activeLoss = savePrediction(db, {
      date: '2026-03-21',
      track: 'Richmond',
      race_number: 4,
      race_type: 'greyhound',
      runner: 'Active Loss',
      box_barrier: 4,
      mode: 'longshot',
      confidence: 63,
      stake: 10,
    })
    updateResult(db, activeLoss.id, 'loss', 9)

    savePrediction(db, {
      date: '2026-03-18',
      track: 'Richmond',
      race_number: 1,
      race_type: 'greyhound',
      runner: 'Legacy Bet',
      box_barrier: 1,
      mode: 'safest',
      confidence: 62,
      stake: 10,
      record_kind: 'legacy_prediction',
      placed_at: null,
    })

    const summary = getBetLedgerSummary(db)

    assert.deepEqual(summary, {
      totalBets: 2,
      settledBets: 2,
      pendingBets: 0,
      wins: 1,
      losses: 1,
      strikeRate: 50,
      totalPnl: 35,
      totalStaked: 25,
      roi: 140,
    })
  })
})

describe('pending prediction resolution', () => {
  test('getPendingPredictions only returns past unresolved active bets', () => {
    savePrediction(db, {
      date: dateOffset(-2),
      track: 'Richmond',
      race_number: 1,
      race_type: 'greyhound',
      runner: 'Past Pending',
      box_barrier: 1,
      mode: 'safest',
      confidence: 70,
    })

    const settled = savePrediction(db, {
      date: dateOffset(-2),
      track: 'Richmond',
      race_number: 2,
      race_type: 'greyhound',
      runner: 'Past Settled',
      box_barrier: 2,
      mode: 'value',
      confidence: 66,
    })
    updateResult(db, settled.id, 'win', 3.4)

    savePrediction(db, {
      date: dateOffset(1),
      track: 'Richmond',
      race_number: 3,
      race_type: 'greyhound',
      runner: 'Future Pending',
      box_barrier: 3,
      mode: 'longshot',
      confidence: 44,
    })

    savePrediction(db, {
      date: dateOffset(-2),
      track: 'Richmond',
      race_number: 4,
      race_type: 'greyhound',
      runner: 'Legacy Pending',
      box_barrier: 4,
      mode: 'value',
      confidence: 55,
      record_kind: 'legacy_prediction',
      placed_at: null,
    })

    const pending = getPendingPredictions(db)

    assert.equal(pending.length, 1)
    assert.equal(pending[0].runner, 'Past Pending')
    assert.equal(pending[0].result, 'pending')
  })

  test('autoResolveResult correctly marks win, loss, and default odds usage', () => {
    const winner = savePrediction(db, {
      date: dateOffset(-1),
      track: 'Wentworth Park',
      race_number: 4,
      race_type: 'greyhound',
      runner: 'Fast Dog',
      box_barrier: 4,
      mode: 'safest',
      confidence: 79,
      stake: 10,
      odds: 3.4,
    })

    const loser = savePrediction(db, {
      date: dateOffset(-1),
      track: 'Richmond',
      race_number: 7,
      race_type: 'greyhound',
      runner: 'Need Odds',
      box_barrier: 1,
      mode: 'safest',
      confidence: 74,
      stake: 10,
    })

    const resolvedWin = autoResolveResult(db, winner.id, '  fast dog  ')
    const resolvedLoss = autoResolveResult(db, loser.id, 'Another Dog')

    assert.equal(resolvedWin.result, 'win')
    assert.equal(resolvedWin.odds, 3.4)
    assert.equal(resolvedWin.pnl, 24)
    assert.equal(resolvedWin.resolved_automatically, true)
    assert.equal(resolvedWin.default_odds_used, false)

    assert.equal(resolvedLoss.result, 'loss')
    assert.equal(resolvedLoss.pnl, -10)
    assert.equal(resolvedLoss.resolved_automatically, true)
    assert.equal(resolvedLoss.default_odds_used, false)

    const defaultOdds = savePrediction(db, {
      date: dateOffset(-1),
      track: 'Richmond',
      race_number: 8,
      race_type: 'greyhound',
      runner: 'Default Winner',
      box_barrier: 2,
      mode: 'value',
      confidence: 72,
      stake: 10,
    })

    const resolvedDefaultOdds = autoResolveResult(db, defaultOdds.id, 'Default Winner')

    assert.equal(resolvedDefaultOdds.result, 'win')
    assert.equal(resolvedDefaultOdds.odds, 2)
    assert.equal(resolvedDefaultOdds.pnl, 10)
    assert.equal(resolvedDefaultOdds.default_odds_used, true)
  })
})

describe('scraper health logging', () => {
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
})

describe('box bias stats', () => {
  test('returns null when fewer than 10 matching results exist', () => {
    for (let index = 0; index < 9; index += 1) {
      saveSettledPrediction({
        track: 'Richmond',
        race_number: index + 1,
        race_distance: 320,
        box_barrier: index % 2 === 0 ? 1 : 2,
        result: index < 3 ? 'win' : 'loss',
      })
    }

    assert.equal(getBoxBiasStats(db, 'Richmond', 320), null)
  })

  test('returns grouped win rates when enough matching results exist', () => {
    const boxOneResults = ['win', 'win', 'win', 'loss', 'loss', 'loss']
    boxOneResults.forEach((result, index) => {
      saveSettledPrediction({
        track: 'Richmond',
        race_number: index + 1,
        race_distance: 320,
        box_barrier: 1,
        result,
      })
    })

    const boxTwoResults = ['win', 'loss', 'loss', 'loss']
    boxTwoResults.forEach((result, index) => {
      saveSettledPrediction({
        track: 'Richmond',
        race_number: index + 11,
        race_distance: 345,
        box_barrier: 2,
        result,
      })
    })

    saveSettledPrediction({
      track: 'Richmond',
      race_distance: 430,
      box_barrier: 3,
      result: 'win',
    })

    const stats = getBoxBiasStats(db, 'Richmond', 320)

    assert.ok(stats)
    assert.equal(stats.track, 'Richmond')
    assert.equal(stats.distance, 320)
    assert.equal(stats.total_results, 10)
    assert.deepEqual(stats.boxes, [
      { box: 1, total_predictions: 6, win_count: 3, win_rate_pct: 50 },
      { box: 2, total_predictions: 4, win_count: 1, win_rate_pct: 25 },
    ])
  })
})
