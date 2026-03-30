const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const {
  parseTheDogsHtml,
  parseRacingAndSportsHtml,
  fetchMeetingsForDate,
  fetchGreyhoundResult,
  mergeSources,
} = require('../scraper.js')

const fix = p => fs.readFileSync(path.join(__dirname, 'fixtures', p), 'utf8')

describe('parseTheDogsHtml', () => {
  test('parses runner rows into normalized RunnerData', () => {
    const runners = parseTheDogsHtml(fix('thedogs-race.html'))
    assert.equal(runners.length, 2)
    assert.equal(runners[0].name, 'Blazing Arrow')
    assert.equal(runners[0].box, 1)
    assert.equal(runners[0].lastStarts, '1-2-1-3')
    assert.equal(runners[0].bestTime, 29.45)
    assert.equal(runners[1].name, 'Lightning Lou')
  })
})

describe('parseRacingAndSportsHtml', () => {
  test('parses .form-runner rows with varied selectors', () => {
    const runners = parseRacingAndSportsHtml(fix('racingandsports-race.html'))
    assert.equal(runners.length, 3)
    assert.equal(runners[0].name, 'Swift Runner')
    assert.equal(runners[0].box, 3)
    assert.equal(runners[0].lastStarts, '2-1-3-1')
    assert.equal(runners[0].trainer, 'A. Jones')
    assert.equal(runners[1].name, 'Dark Storm')
    assert.equal(runners[2].name, 'Quick Silver')
  })
})

describe('mergeSources', () => {
  test('merges runner data from multiple sources by name', () => {
    const s1 = [{ name: 'Blazing Arrow', box: 1, lastStarts: '1-2-1-3', bestTime: 29.45 }]
    const s2 = [
      { name: 'Blazing Arrow', box: 1, odds: 3.50 },
      { name: 'Lightning Lou', box: 2, lastStarts: '3-1-2', odds: 5.00 }
    ]
    const merged = mergeSources([s1, s2])
    const arrow = merged.find(r => r.name === 'Blazing Arrow')
    assert.ok(arrow)
    assert.equal(arrow.lastStarts, '1-2-1-3')
    assert.equal(arrow.odds, 3.50)
    assert.equal(arrow.bestTime, 29.45)
    assert.equal(merged.length, 2)
  })

  test('returns empty array for empty input', () => {
    assert.deepEqual(mergeSources([]), [])
    assert.deepEqual(mergeSources([[]]), [])
  })
})

describe('fetchGreyhoundResult', () => {
  test('parses a saved results fixture correctly', async () => {
    const originalFetch = global.fetch
    const fixture = fix('thedogs-result.html')

    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => fixture,
    })

    try {
      const result = await fetchGreyhoundResult('2026-03-29', 'Richmond', 8)

      assert.deepEqual(result, {
        winner: 'Rocket Boy',
        second: 'Late Charger',
        third: 'Inside Rail',
        finished: true,
      })
    } finally {
      global.fetch = originalFetch
    }
  })
})

describe('fetchMeetingsForDate', () => {
  test('parses a saved racecards fixture correctly', async () => {
    const originalFetch = global.fetch
    const fixture = fix('thedogs-racecards.html')

    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => fixture,
    })

    try {
      const meetings = await fetchMeetingsForDate('2026-03-30', 'greyhound')

      assert.deepEqual(meetings, [
        { track: 'Richmond', slug: 'richmond', raceCount: 12, firstRaceTime: '18:15' },
        { track: 'Wentworth Park', slug: 'wentworth-park', raceCount: 10, firstRaceTime: '19:05' },
      ])
    } finally {
      global.fetch = originalFetch
    }
  })
})
