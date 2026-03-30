const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')

process.env.DB_PATH = ':memory:'
process.env.NODE_ENV = 'test'
delete process.env.ANTHROPIC_API_KEY

const { initDb } = require('../database.js')
const { analyseRace } = require('../analyst.js')
const { handleResearchRequest } = require('../index.js')

let db

before(() => {
  db = initDb()
})

after(() => {
  db.close()
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
    assert.equal(res.body.runner, 'Late Split')
    assert.ok(Array.isArray(res.body.allScores))
  })
})
