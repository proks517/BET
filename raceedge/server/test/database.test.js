const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

process.env.DB_PATH = ':memory:'

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
  getAIAgreementStats,
  logScraperHealth,
  getScraperStats,
  getBoxBiasStats,
  saveJournalEntry,
  getJournalEntry,
  getJournalHistory,
} = require('../database.js')

let db
let predictionSeed = 0

before(() => { db = initDb() })
after(() => { db.close() })

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
  confidence = 0.7,
  stake = 10,
  race_distance = 320,
  race_grade = null,
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
    race_grade,
  })

  return updateResult(db, saved.id, result, result === 'win' ? odds : odds)
}

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

describe('AI agreement stats', () => {
  beforeEach(() => {
    db.exec('DELETE FROM predictions')
  })

  test('getAIAgreementStats returns correct aggregates', () => {
    const agreedWin = savePrediction(db, {
      date: '2026-03-29',
      track: 'Richmond',
      race_number: 1,
      race_type: 'greyhound',
      runner: 'Agree Win',
      box_barrier: 1,
      mode: 'safest',
      confidence: 82,
      ai_recommendation: 'Agree Win',
      ai_agreed: true,
    })
    updateResult(db, agreedWin.id, 'win', 2.8)

    const agreedLoss = savePrediction(db, {
      date: '2026-03-29',
      track: 'Richmond',
      race_number: 2,
      race_type: 'greyhound',
      runner: 'Agree Loss',
      box_barrier: 2,
      mode: 'value',
      confidence: 71,
      ai_recommendation: 'Agree Loss',
      ai_agreed: true,
    })
    updateResult(db, agreedLoss.id, 'loss', 4.2)

    const disagreedWin = savePrediction(db, {
      date: '2026-03-29',
      track: 'Richmond',
      race_number: 3,
      race_type: 'greyhound',
      runner: 'Model Pick',
      box_barrier: 3,
      mode: 'value',
      confidence: 69,
      ai_recommendation: 'Claude Pick',
      ai_agreed: false,
    })
    updateResult(db, disagreedWin.id, 'win', 5.1)

    const disagreedLoss = savePrediction(db, {
      date: '2026-03-29',
      track: 'Richmond',
      race_number: 4,
      race_type: 'greyhound',
      runner: 'Another Model Pick',
      box_barrier: 4,
      mode: 'longshot',
      confidence: 58,
      ai_recommendation: 'Different Claude Pick',
      ai_agreed: false,
    })
    updateResult(db, disagreedLoss.id, 'loss', 8.5)

    savePrediction(db, {
      date: '2026-03-29',
      track: 'Richmond',
      race_number: 5,
      race_type: 'greyhound',
      runner: 'Pending AI',
      box_barrier: 5,
      mode: 'safest',
      confidence: 60,
      ai_recommendation: 'Pending AI',
      ai_agreed: true,
    })

    const stats = getAIAgreementStats(db)

    assert.deepEqual(stats, {
      totalWithAI: 5,
      agreedCount: 3,
      agreedWinRate: 50,
      disagreedWinRate: 50,
    })
  })
})

describe('pending prediction resolution', () => {
  beforeEach(() => {
    db.exec('DELETE FROM predictions')
  })

  test('getPendingPredictions only returns past unresolved predictions', () => {
    savePrediction(db, {
      date: dateOffset(-2),
      track: 'Richmond',
      race_number: 1,
      race_type: 'greyhound',
      runner: 'Past Pending',
      box_barrier: 1,
      mode: 'safest',
      confidence: 0.7,
    })

    const settled = savePrediction(db, {
      date: dateOffset(-2),
      track: 'Richmond',
      race_number: 2,
      race_type: 'greyhound',
      runner: 'Past Settled',
      box_barrier: 2,
      mode: 'value',
      confidence: 0.66,
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
      confidence: 0.44,
    })

    const pending = getPendingPredictions(db)

    assert.equal(pending.length, 1)
    assert.equal(pending[0].runner, 'Past Pending')
    assert.equal(pending[0].result, 'pending')
  })

  test('autoResolveResult correctly marks win when name matches', () => {
    const prediction = savePrediction(db, {
      date: dateOffset(-1),
      track: 'Wentworth Park',
      race_number: 4,
      race_type: 'greyhound',
      runner: 'Fast Dog',
      box_barrier: 4,
      mode: 'safest',
      confidence: 0.79,
      stake: 10,
      odds: 3.4,
    })

    const resolved = autoResolveResult(db, prediction.id, '  fast dog  ')

    assert.equal(resolved.result, 'win')
    assert.equal(resolved.odds, 3.4)
    assert.equal(resolved.pnl, 24)
    assert.equal(resolved.resolved_automatically, true)
    assert.equal(resolved.default_odds_used, false)
  })

  test('autoResolveResult correctly marks loss when name does not match', () => {
    const prediction = savePrediction(db, {
      date: dateOffset(-1),
      track: 'Randwick',
      race_number: 6,
      race_type: 'horse',
      runner: 'Silver Comet',
      box_barrier: 6,
      mode: 'value',
      confidence: 0.61,
      stake: 12,
    })

    const resolved = autoResolveResult(db, prediction.id, 'Golden Arrow')

    assert.equal(resolved.result, 'loss')
    assert.equal(resolved.pnl, -12)
    assert.equal(resolved.resolved_automatically, true)
    assert.equal(resolved.default_odds_used, false)
  })

  test('autoResolveResult sets resolved_automatically and default odds flags correctly', () => {
    const prediction = savePrediction(db, {
      date: dateOffset(-1),
      track: 'Richmond',
      race_number: 7,
      race_type: 'greyhound',
      runner: 'Need Odds',
      box_barrier: 1,
      mode: 'safest',
      confidence: 0.74,
      stake: 10,
    })

    const resolved = autoResolveResult(db, prediction.id, 'Need Odds')

    assert.equal(resolved.result, 'win')
    assert.equal(resolved.odds, 2)
    assert.equal(resolved.pnl, 10)
    assert.equal(resolved.resolved_automatically, true)
    assert.equal(resolved.default_odds_used, true)
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

describe('box bias stats', () => {
  beforeEach(() => {
    db.exec('DELETE FROM predictions')
  })

  test('getBoxBiasStats returns null when fewer than 10 samples match the track and distance window', () => {
    for (let index = 0; index < 9; index += 1) {
      saveSettledPrediction({
        track: 'Richmond',
        race_number: index + 1,
        race_distance: 320,
        box_barrier: index % 2 === 0 ? 1 : 2,
        result: index < 3 ? 'win' : 'loss',
      })
    }

    saveSettledPrediction({
      track: 'Wentworth Park',
      race_distance: 320,
      box_barrier: 1,
      result: 'win',
    })

    assert.equal(getBoxBiasStats(db, 'Richmond', 320), null)
  })

  test('getBoxBiasStats returns correct win rates with enough filtered history', () => {
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
    saveSettledPrediction({
      track: 'Sandown Park',
      race_distance: 320,
      box_barrier: 1,
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

describe('advanced analytics', () => {
  beforeEach(() => {
    db.exec('DELETE FROM prediction_journal')
    db.exec('DELETE FROM predictions')
  })

  test('getStatsByTrack returns empty array when no predictions exist', () => {
    assert.deepEqual(getStatsByTrack(db), [])
  })

  test('getStatsByTrack correctly calculates win rates and pnl for tracks with 3+ predictions', () => {
    saveSettledPrediction({ track: 'Richmond', race_number: 1, result: 'win', odds: 3.0 })
    saveSettledPrediction({ track: 'Richmond', race_number: 2, result: 'win', odds: 2.5 })
    saveSettledPrediction({ track: 'Richmond', race_number: 3, result: 'loss', odds: 4.0 })
    saveSettledPrediction({ track: 'Albion Park', race_number: 4, result: 'win', odds: 2.0 })
    saveSettledPrediction({ track: 'Albion Park', race_number: 5, result: 'loss', odds: 3.5 })

    assert.deepEqual(getStatsByTrack(db), [
      { track: 'Richmond', total: 3, wins: 2, winRate: 66.7, pnl: 25 },
    ])
  })

  test('getCalibrationData correctly buckets confidence scores', () => {
    saveSettledPrediction({ track: 'Track A', race_number: 1, confidence: 0.55, result: 'loss' })
    saveSettledPrediction({ track: 'Track A', race_number: 2, confidence: 0.65, result: 'win' })
    saveSettledPrediction({ track: 'Track A', race_number: 3, confidence: 0.74, result: 'win' })
    saveSettledPrediction({ track: 'Track A', race_number: 4, confidence: 82, result: 'loss' })
    saveSettledPrediction({ track: 'Track A', race_number: 5, confidence: 91, result: 'win' })
    saveSettledPrediction({ track: 'Track A', race_number: 6, confidence: 0.4, result: 'win' })

    assert.deepEqual(getCalibrationData(db), [
      { bucket: '50-59%', predicted: '50-59%', predictedPct: 55, total: 1, wins: 0, actualWinRate: 0 },
      { bucket: '60-69%', predicted: '60-69%', predictedPct: 65, total: 1, wins: 1, actualWinRate: 100 },
      { bucket: '70-79%', predicted: '70-79%', predictedPct: 75, total: 1, wins: 1, actualWinRate: 100 },
      { bucket: '80-89%', predicted: '80-89%', predictedPct: 85, total: 1, wins: 0, actualWinRate: 0 },
      { bucket: '90%+', predicted: '90%+', predictedPct: 95, total: 1, wins: 1, actualWinRate: 100 },
    ])
  })

  test('getStreakData returns zeroed streaks for an empty history', () => {
    assert.deepEqual(getStreakData(db), {
      current: 0,
      longest: 0,
      currentLoss: 0,
      longestLoss: 0,
    })
  })

  test('getProfitCurve returns predictions in chronological order with running totals', () => {
    const first = savePrediction(db, {
      date: '2026-01-05',
      track: 'Richmond',
      race_number: 2,
      race_type: 'greyhound',
      runner: 'Curve One',
      box_barrier: 1,
      mode: 'safest',
      confidence: 72,
    })
    updateResult(db, first.id, 'win', 3.0)

    const second = savePrediction(db, {
      date: '2026-01-03',
      track: 'Richmond',
      race_number: 1,
      race_type: 'greyhound',
      runner: 'Curve Two',
      box_barrier: 2,
      mode: 'value',
      confidence: 68,
    })
    updateResult(db, second.id, 'loss', 5.0)

    const third = savePrediction(db, {
      date: '2026-01-06',
      track: 'Richmond',
      race_number: 3,
      race_type: 'greyhound',
      runner: 'Curve Three',
      box_barrier: 3,
      mode: 'longshot',
      confidence: 85,
    })

    assert.deepEqual(getProfitCurve(db), [
      { date: '2026-01-03', runningPnl: -10, runningWinRate: 0 },
      { date: '2026-01-05', runningPnl: 10, runningWinRate: 50 },
      { date: '2026-01-06', runningPnl: 10, runningWinRate: 50 },
    ])
  })

  test('getStatsByBox handles missing box data gracefully', () => {
    const first = savePrediction(db, {
      date: '2026-03-21',
      track: 'Richmond',
      race_number: 1,
      race_type: 'greyhound',
      runner: 'Inside Rail',
      box_barrier: 1,
      mode: 'safest',
      confidence: 81,
    })
    updateResult(db, first.id, 'win', 2.8)
    saveJournalEntry(db, {
      prediction_id: first.id,
      race_date: '2026-03-21',
      track: 'Richmond',
      race_number: 1,
      race_distance: 320,
      all_runners_json: [],
      sources_consulted_json: [],
      winner_name: 'Inside Rail',
      winner_box: 1,
      winner_composite_score: 81,
      winner_breakdown_json: {},
      ai_analysis_json: null,
      mode_used: 'safest',
      box_bias_source: 'default',
      raw_data_summary: 'test',
    })

    const boxStats = getStatsByBox(db)

    assert.equal(boxStats.overall.length, 8)
    assert.deepEqual(boxStats.overall[0], {
      box: 1,
      total: 1,
      wins: 1,
      winRate: 100,
      avgCompositeScore: 81,
    })
    assert.deepEqual(boxStats.overall[7], {
      box: 8,
      total: 0,
      wins: 0,
      winRate: 0,
      avgCompositeScore: null,
    })
    assert.equal(boxStats.byTrack.length, 1)
    assert.equal(boxStats.byTrack[0].track, 'Richmond')
    assert.equal(boxStats.byTrack[0].boxes[1].total, 0)
  })
})

describe('prediction journal', () => {
  beforeEach(() => {
    db.exec('DELETE FROM prediction_journal')
    db.exec('DELETE FROM predictions')
  })

  test('saveJournalEntry and getJournalEntry round-trip correctly', () => {
    const prediction = savePrediction(db, {
      date: '2026-03-29',
      track: 'Richmond',
      race_number: 7,
      race_type: 'greyhound',
      runner: 'Journal Star',
      box_barrier: 3,
      mode: 'value',
      confidence: 81,
      race_distance: 320,
    })

    saveJournalEntry(db, {
      prediction_id: prediction.id,
      race_date: '2026-03-29',
      track: 'Richmond',
      race_number: 7,
      race_distance: 320,
      all_runners_json: [
        { name: 'Journal Star', score: 81, breakdown: { bestTime: 74 } },
        { name: 'Late Split', score: 70, breakdown: { bestTime: 62 } },
      ],
      sources_consulted_json: [
        { source: 'thedogs.com.au', status: 'success', recordsReturned: 8 },
        { source: 'tab.com.au', status: 'empty', recordsReturned: 0 },
      ],
      winner_name: 'Journal Star',
      winner_box: 3,
      winner_composite_score: 81,
      winner_breakdown_json: {
        recentForm: 88,
        bestTime: 74,
        boxDraw: 65,
        classConsistency: 72,
        trainerStrikeRate: 50,
        daysSinceLastRun: 85,
      },
      ai_analysis_json: {
        recommendation: { runner: 'Journal Star', box: 3, reasoning: 'Clean map and best blend of speed.' },
        valueWatch: { runner: 'Late Split', reasoning: 'Drawn to settle close and run on.' },
        raceDynamic: 'Inside speed should control the early stages.',
        confidence: 'MEDIUM',
        confidenceReason: 'The map suits but the race has depth.',
        concerns: 'Can be vulnerable late if pressured.',
        modelAgreement: true,
      },
      mode_used: 'value',
      box_bias_source: 'empirical',
      raw_data_summary: 'thedogs.com.au: success (8 runners)\ntab.com.au: empty (0 runners)',
    })

    const entry = getJournalEntry(db, prediction.id)
    const history = getJournalHistory(db, 1)

    assert.ok(entry)
    assert.equal(entry.prediction_id, prediction.id)
    assert.equal(entry.track, 'Richmond')
    assert.equal(entry.race_distance, 320)
    assert.equal(entry.winner_name, 'Journal Star')
    assert.equal(entry.winner_box, 3)
    assert.equal(entry.winner_composite_score, 81)
    assert.equal(entry.mode_used, 'value')
    assert.equal(entry.box_bias_source, 'empirical')
    assert.deepEqual(entry.all_runners, [
      { name: 'Journal Star', score: 81, breakdown: { bestTime: 74 } },
      { name: 'Late Split', score: 70, breakdown: { bestTime: 62 } },
    ])
    assert.deepEqual(entry.sources_consulted, [
      { source: 'thedogs.com.au', status: 'success', recordsReturned: 8 },
      { source: 'tab.com.au', status: 'empty', recordsReturned: 0 },
    ])
    assert.deepEqual(entry.winner_breakdown, {
      recentForm: 88,
      bestTime: 74,
      boxDraw: 65,
      classConsistency: 72,
      trainerStrikeRate: 50,
      daysSinceLastRun: 85,
    })
    assert.deepEqual(entry.ai_analysis, {
      recommendation: { runner: 'Journal Star', box: 3, reasoning: 'Clean map and best blend of speed.' },
      valueWatch: { runner: 'Late Split', reasoning: 'Drawn to settle close and run on.' },
      raceDynamic: 'Inside speed should control the early stages.',
      confidence: 'MEDIUM',
      confidenceReason: 'The map suits but the race has depth.',
      concerns: 'Can be vulnerable late if pressured.',
      modelAgreement: true,
    })
    assert.equal(history.length, 1)
    assert.equal(history[0].prediction_id, prediction.id)
  })
})
