const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')

process.env.NODE_ENV = 'test'
delete process.env.ANTHROPIC_API_KEY

process.env.DB_PATH = ':memory:'

const { savePrediction, saveJournalEntry } = require('../database.js')
const { analyseRace } = require('../analyst.js')
const { app, db, handleResearchRequest } = require('../index.js')

let server
let baseUrl

before(() => {
  server = app.listen(0)
  const address = server.address()
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(() => {
  server.close()
})

beforeEach(() => {
  db.exec('DELETE FROM prediction_journal')
  db.exec('DELETE FROM predictions')
})

function createResponseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code
      return this
    },
    json(payload) {
      this.body = payload
      return this
    },
  }
}

describe('research handler', () => {
  test('still works when aiAnalysis is null', async () => {
    const req = {
      body: {
        date: '2026-03-30',
        meeting: 'Richmond',
        raceNumber: 8,
        raceType: 'greyhound',
        mode: 'value',
        stake: 10,
        distance: 320,
      },
    }
    const res = createResponseRecorder()

    const runners = [
      {
        name: 'Domineering',
        box: 5,
        lastStarts: '1-2-4-3',
        bestTime: 18.74,
        trainerStrike: 18,
        careerTop3Pct: 58,
        daysSinceLastRun: 9,
      },
      {
        name: 'Late Split',
        box: 2,
        lastStarts: '3-3-2-4',
        bestTime: 18.81,
        trainerStrike: 12,
        careerTop3Pct: 42,
        daysSinceLastRun: 12,
      },
    ]

    await handleResearchRequest(req, res, {
      dbInstance: db,
      analyseRaceFn: analyseRace,
      researchFn: async () => ({
        runners,
        sources: [
          { source: 'thedogs.com.au', runners, error: null },
        ],
        sourcesUsed: ['thedogs.com.au'],
        sourcesSkipped: [],
        warning: null,
      }),
    })

    assert.equal(res.statusCode, 200)
    assert.ok(res.body.predictionId > 0)
    assert.equal(res.body.aiAnalysis, null)
    assert.ok(Array.isArray(res.body.picks))
    assert.ok(res.body.picks.length >= 1)
    assert.equal(res.body.runner, res.body.picks[0].name)
    assert.equal(res.body.oddsAvailable, false)
    assert.ok(Array.isArray(res.body.allRunners))
    assert.ok(Array.isArray(res.body.allScores))
  })
})

describe('/api/apply-odds', () => {
  test('recalculates EV and returns updated top picks', async () => {
    const prediction = savePrediction(db, {
      date: '2026-03-30',
      track: 'Richmond',
      race_number: 8,
      race_type: 'greyhound',
      runner: 'Domineering',
      box_barrier: 5,
      mode: 'value',
      confidence: 74,
      stake: 10,
      race_distance: 320,
    })

    saveJournalEntry(db, {
      prediction_id: prediction.id,
      race_date: '2026-03-30',
      track: 'Richmond',
      race_number: 8,
      race_distance: 320,
      all_runners_json: [
        {
          name: 'Domineering',
          box: 5,
          compositeScore: 82,
          breakdown: {
            recentForm: 88,
            bestTime: 74,
            boxDraw: 60,
            classConsistency: 70,
            trainerStrikeRate: 54,
            daysSinceLastRun: 85,
          },
        },
        {
          name: 'Late Split',
          box: 2,
          compositeScore: 70,
          breakdown: {
            recentForm: 78,
            bestTime: 72,
            boxDraw: 68,
            classConsistency: 64,
            trainerStrikeRate: 50,
            daysSinceLastRun: 70,
          },
        },
        {
          name: 'Rail Rider',
          box: 1,
          compositeScore: 60,
          breakdown: {
            recentForm: 69,
            bestTime: 67,
            boxDraw: 76,
            classConsistency: 55,
            trainerStrikeRate: 45,
            daysSinceLastRun: 65,
          },
        },
      ],
      sources_consulted_json: [
        { source: 'thedogs.com.au', status: 'success', recordsReturned: 8 },
      ],
      winner_name: 'Domineering',
      winner_box: 5,
      winner_composite_score: 82,
      winner_breakdown_json: {
        recentForm: 88,
        bestTime: 74,
        boxDraw: 60,
        classConsistency: 70,
        trainerStrikeRate: 54,
        daysSinceLastRun: 85,
      },
      ai_analysis_json: null,
      mode_used: 'value',
      box_bias_source: 'default',
      raw_data_summary: 'thedogs.com.au: success (8 runners)',
    })

    const response = await fetch(`${baseUrl}/api/apply-odds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        predictionId: prediction.id,
        odds: [
          { box: 5, runnerName: 'Domineering', decimalOdds: 2.2 },
          { box: 2, runnerName: 'Late Split', decimalOdds: 5.0 },
          { box: 1, runnerName: 'Rail Rider', decimalOdds: 4.2 },
        ],
      }),
    })

    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.oddsAvailable, true)
    assert.equal(body.oddsSource, 'manual')
    assert.equal(body.picks[0].name, 'Late Split')
    assert.ok(body.picks[0].ev > 0.15)
    assert.equal(body.updatedPrediction.runner, 'Late Split')
    assert.equal(body.updatedPrediction.odds_source, 'manual')
    assert.ok(body.updatedPrediction.ev > 0.15)
  })
})
