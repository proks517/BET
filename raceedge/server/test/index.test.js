const { test, describe, before, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

process.env.NODE_ENV = 'test'
process.env.DB_PATH = ':memory:'

const { savePrediction } = require('../database.js')
const { app, db, executeBestBetsScan } = require('../index.js')

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
  db.exec('DELETE FROM scraper_health')
  db.exec('DELETE FROM predictions')
})

function readFixture(name) {
  return fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')
}

describe('/api/health', () => {
  test('returns release and AI capability metadata', async () => {
    const response = await fetch(`${baseUrl}/api/health`)
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.status, 'ok')
    assert.equal(body.release.channel, 'stability')
    assert.equal(body.aiAnalyst.status, 'disabled')
  })
})

describe('/api/capabilities', () => {
  test('returns the shared capability matrix', async () => {
    const response = await fetch(`${baseUrl}/api/capabilities`)
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.release.channel, 'stability')
    assert.ok(Array.isArray(body.sources.greyhound))
    assert.ok(body.features.some(feature => feature.id === 'bestBetsScan'))
  })
})

describe('/api/bets', () => {
  test('creates an explicit placed bet and returns it in the ledger', async () => {
    const createResponse = await fetch(`${baseUrl}/api/bets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        date: '2026-03-31',
        track: 'Richmond',
        raceNumber: 5,
        raceType: 'greyhound',
        runnerName: 'Fast Dog',
        box: 1,
        mode: 'safest',
        confidence: 81,
        stake: 20,
        confirmedOdds: 3.4,
        winProbability: 0.31,
        ev: 0.12,
      }),
    })
    const createdBody = await createResponse.json()

    assert.equal(createResponse.status, 201)
    assert.equal(createdBody.bet.runnerName, 'Fast Dog')
    assert.equal(createdBody.bet.result, 'pending')
    assert.equal(createdBody.bet.stake, 20)
    assert.equal(createdBody.bet.confirmedOdds, 3.4)

    const ledgerResponse = await fetch(`${baseUrl}/api/bets`)
    const ledgerBody = await ledgerResponse.json()

    assert.equal(ledgerResponse.status, 200)
    assert.equal(ledgerBody.bets.length, 1)
    assert.equal(ledgerBody.summary.totalBets, 1)
    assert.equal(ledgerBody.summary.pendingBets, 1)
  })

  test('excludes archived legacy rows from the live ledger', async () => {
    savePrediction(db, {
      date: '2026-03-28',
      track: 'Richmond',
      race_number: 2,
      race_type: 'greyhound',
      runner: 'Legacy Pick',
      box_barrier: 2,
      mode: 'value',
      confidence: 68,
      record_kind: 'legacy_prediction',
      placed_at: null,
    })

    savePrediction(db, {
      date: '2026-03-29',
      track: 'Richmond',
      race_number: 3,
      race_type: 'greyhound',
      runner: 'Placed Pick',
      box_barrier: 3,
      mode: 'safest',
      confidence: 78,
      stake: 10,
      odds: 2.8,
      placed_at: '2026-03-29T01:00:00.000Z',
    })

    const response = await fetch(`${baseUrl}/api/bets`)
    const body = await response.json()

    assert.equal(body.bets.length, 1)
    assert.equal(body.bets[0].runnerName, 'Placed Pick')
  })
})

describe('/api/bets/:id', () => {
  test('applies a manual result override to a placed bet', async () => {
    const bet = savePrediction(db, {
      date: '2026-03-29',
      track: 'Richmond',
      race_number: 4,
      race_type: 'greyhound',
      runner: 'Manual Marker',
      box_barrier: 4,
      mode: 'longshot',
      confidence: 66,
      stake: 12,
      odds: 6,
      placed_at: '2026-03-29T02:00:00.000Z',
    })

    const response = await fetch(`${baseUrl}/api/bets/${bet.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ result: 'win', odds: 6 }),
    })
    const body = await response.json()

    assert.equal(response.status, 200)
    assert.equal(body.bet.result, 'win')
    assert.equal(body.bet.pnl, 60)
  })
})

describe('/api/check-results', () => {
  test('auto-settles pending placed bets from result scraping', async () => {
    const bet = savePrediction(db, {
      date: '2026-03-29',
      track: 'Richmond',
      race_number: 8,
      race_type: 'greyhound',
      runner: 'Rocket Boy',
      box_barrier: 1,
      mode: 'safest',
      confidence: 82,
      stake: 10,
      odds: 2.8,
      placed_at: '2026-03-29T03:00:00.000Z',
    })

    const originalFetch = global.fetch
    const localFetch = originalFetch
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => readFixture('thedogs-result.html'),
    })

    try {
      const response = await localFetch(`${baseUrl}/api/check-results`, { method: 'POST' })
      const body = await response.json()

      assert.equal(response.status, 200)
      assert.equal(body.checked, 1)
      assert.equal(body.resolved, 1)

      const ledgerResponse = await localFetch(`${baseUrl}/api/bets`)
      const ledgerBody = await ledgerResponse.json()
      assert.equal(ledgerBody.bets[0].id, bet.id)
      assert.equal(ledgerBody.bets[0].result, 'win')
      assert.equal(ledgerBody.bets[0].resolvedAutomatically, true)
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('executeBestBetsScan', () => {
  test('returns all three classes with confidence labels and source warnings', async () => {
    const events = []
    const payload = await executeBestBetsScan({
      date: '2026-03-31',
      type: 'greyhound',
      emit: event => events.push(event),
      dbInstance: db,
      fetchMeetingsForDateFn: async () => ([
        { track: 'Richmond', raceCount: 2, firstRaceTime: '18:15' },
      ]),
      fetchAllRacesForMeetingFn: async (date, track, raceCount, type, dbInstance, emitProgress) => {
        emitProgress({ type: 'race_done', raceNumber: 1 })
        emitProgress({ type: 'race_done', raceNumber: 2 })
        return [
          { track, raceNumber: 1, runners: [{}], sourcesUsed: ['thedogs.com.au'] },
          { track, raceNumber: 2, runners: [{}], sourcesUsed: ['grv.org.au'] },
        ]
      },
      generateBestBetsFn: races => ({
        safest: [{
          rank: 1,
          mode: 'safest',
          track: races[0].track,
          raceNumber: races[0].raceNumber,
          runnerName: 'Safe Pick',
          box: 1,
          decimalOdds: 2.9,
          confidence: 84,
          sourcesUsed: races[0].sourcesUsed,
        }],
        value: [{
          rank: 1,
          mode: 'value',
          track: races[1].track,
          raceNumber: races[1].raceNumber,
          runnerName: 'Value Pick',
          box: 5,
          decimalOdds: 4.8,
          confidence: 72,
          sourcesUsed: races[1].sourcesUsed,
        }],
        longshot: [{
          rank: 1,
          mode: 'longshot',
          track: races[1].track,
          raceNumber: races[1].raceNumber,
          runnerName: 'Longshot Pick',
          box: 7,
          decimalOdds: 10.5,
          confidence: 58,
          sourcesUsed: races[1].sourcesUsed,
        }],
      }),
    })

    assert.equal(payload.type, 'greyhound')
    assert.equal(payload.mode, 'all')
    assert.equal(payload.totalMeetings, 1)
    assert.equal(payload.totalRacesScanned, 2)
    assert.equal(payload.picks.safest[0].confidenceLabel, 'High')
    assert.equal(payload.picks.value[0].confidenceLabel, 'Medium')
    assert.equal(payload.picks.longshot[0].confidenceLabel, 'Low')
    assert.equal(payload.picks.safest[0].sourceBadges[0].trustLabel, 'Stable')
    assert.equal(payload.picks.value[0].experimentalWarning, true)
    assert.equal(events[0].type, 'scan_start')
    assert.ok(events.some(event => event.type === 'meeting_done'))
  })
})
