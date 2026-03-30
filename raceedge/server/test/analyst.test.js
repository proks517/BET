const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { analyseRace } = require('../analyst.js')

const sampleRunners = [
  {
    name: 'Domineering',
    box: 5,
    lastStarts: '1-2-4-3',
    bestTime: 18.74,
    compositeScore: 74,
    breakdown: {
      recentForm: 88,
      bestTime: 71,
      boxDraw: 60,
      classConsistency: 65,
      trainerStrikeRate: 50,
      daysSinceLastRun: 85,
    },
  },
]

const raceContext = {
  date: '2026-03-30',
  track: 'Richmond',
  raceNumber: 8,
  distance: 320,
  raceType: 'greyhound',
  grade: 'Grade 5',
}

describe('analyseRace', () => {
  test('returns null gracefully when API key is not set', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY

    try {
      const result = await analyseRace(sampleRunners, raceContext)
      assert.equal(result, null)
    } finally {
      if (originalKey == null) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalKey
      }
    }
  })

  test('returns null gracefully when the API call throws', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY
    const originalFetch = global.fetch
    process.env.ANTHROPIC_API_KEY = 'test-key'
    global.fetch = async () => {
      throw new Error('network down')
    }

    try {
      const result = await analyseRace(sampleRunners, raceContext)
      assert.equal(result, null)
    } finally {
      if (originalKey == null) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = originalKey
      }
      global.fetch = originalFetch
    }
  })
})
