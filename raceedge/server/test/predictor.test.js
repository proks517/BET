const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const { scoreRunner, applyMode } = require('../predictor.js')

// Field: Alpha is clear form leader and favourite; Gamma is good value; Delta is the dud
const runners = [
  { name: 'Alpha',  box: 1, lastStarts: '1-1-2-1', bestTime: 29.20, trainerStrike: 25, odds: 2.80 },
  { name: 'Beta',   box: 5, lastStarts: '3-4-2-3', bestTime: 29.80, trainerStrike: 10, odds: 5.50 },
  { name: 'Gamma',  box: 3, lastStarts: '1-2-1-2', bestTime: 29.40, trainerStrike: 15, odds: 4.00 },
  { name: 'Delta',  box: 8, lastStarts: '5-6-4-5', bestTime: 30.10, trainerStrike:  8, odds: 15.00 },
]

const AVG_TIME = runners.reduce((s, r) => s + r.bestTime, 0) / runners.length // ~29.625

describe('scoreRunner', () => {
  test('strong form runner scores higher than weak form runner', () => {
    assert.ok(scoreRunner(runners[0], AVG_TIME) > scoreRunner(runners[1], AVG_TIME))
  })

  test('box 1 runner scores higher than box 8 runner with identical form', () => {
    const r1 = { name: 'A', box: 1, lastStarts: '3-3-3', bestTime: 30.0 }
    const r8 = { name: 'B', box: 8, lastStarts: '3-3-3', bestTime: 30.0 }
    assert.ok(scoreRunner(r1, 30.0) > scoreRunner(r8, 30.0))
  })

  test('high trainer strike rate adds points', () => {
    const hi = { name: 'A', box: 5, lastStarts: '3-3', bestTime: 30.0, trainerStrike: 25 }
    const lo = { name: 'B', box: 5, lastStarts: '3-3', bestTime: 30.0, trainerStrike: 10 }
    assert.ok(scoreRunner(hi, 30.0) > scoreRunner(lo, 30.0))
  })

  test('score is in range 0–100', () => {
    const s = scoreRunner(runners[0], AVG_TIME)
    assert.ok(s >= 0 && s <= 100, `Score ${s} out of range`)
  })
})

describe('applyMode', () => {
  test('safest returns highest scoring runner', () => {
    const r = applyMode(runners, 'safest')
    assert.equal(r.runner.name, 'Alpha')
    assert.ok(r.confidence > 0 && r.confidence <= 1)
    assert.ok(r.reasoning.length > 0)
  })

  test('value avoids the market favourite', () => {
    const r = applyMode(runners, 'value')
    assert.notEqual(r.runner.name, 'Alpha') // Alpha is fav at $2.80
    assert.ok(['Gamma', 'Beta'].includes(r.runner.name))
  })

  test('longshot selects a runner with odds >= $3 and a form indicator', () => {
    const r = applyMode(runners, 'longshot')
    assert.notEqual(r.runner.name, 'Alpha')
    assert.ok(!r.runner.odds || r.runner.odds >= 3.00)
  })

  test('throws for unrecognised mode', () => {
    assert.throws(() => applyMode(runners, 'unknown'), /unknown mode/i)
  })

  test('handles single-runner field gracefully', () => {
    const r = applyMode([runners[0]], 'safest')
    assert.equal(r.runner.name, 'Alpha')
  })
})
