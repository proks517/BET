const { test, describe } = require('node:test')
const assert = require('node:assert/strict')
const {
  buildScoreBreakdown,
  scoreRunner,
  scoreRecentForm,
  scoreBestTime,
  scoreBoxDraw,
  scoreClassConsistency,
  scoreTrainerStrikeRate,
  scoreDaysSinceLastRun,
  applyMode,
} = require('../predictor.js')

describe('scoreRecentForm', () => {
  test('all wins across six starts returns the maximum score', () => {
    assert.equal(scoreRecentForm({ lastStarts: '1-1-1-1-1-1' }), 100)
  })

  test('more recent wins are worth more than older wins', () => {
    const recentWin = scoreRecentForm({ lastStarts: '1-5-5-5-5-5' })
    const olderWin = scoreRecentForm({ lastStarts: '5-5-5-5-5-1' })
    assert.ok(recentWin > olderWin)
  })

  test('did-not-finish penalties reduce the score', () => {
    const steady = scoreRecentForm({ lastStarts: '1-5-1-1-1-1' })
    const dnf = scoreRecentForm({ lastStarts: '1-F-1-1-1-1' })
    assert.ok(dnf < steady)
  })

  test('missing form data returns a neutral score', () => {
    assert.equal(scoreRecentForm({}), 50)
  })
})

describe('scoreBestTime', () => {
  test('missing best time returns a neutral score', () => {
    assert.equal(scoreBestTime({}, 29.8), 45)
  })

  test('runner more than half a second faster than the field scores in the elite range', () => {
    assert.equal(scoreBestTime({ bestTime: 29.0 }, 29.7), 94)
  })

  test('runner slightly faster than the field lands in the positive range', () => {
    assert.equal(scoreBestTime({ bestTime: 29.8 }, 30.0), 72)
  })

  test('runner slower than the field average is penalised', () => {
    assert.equal(scoreBestTime({ bestTime: 30.6 }, 30.0), 36)
  })
})

describe('scoreBoxDraw', () => {
  test('greyhound sprint box 1 gets the top sprint score', () => {
    assert.equal(scoreBoxDraw({ box: 1, distanceMeters: 320, raceType: 'greyhound' }), 85)
  })

  test('greyhound middle-distance box 2 reflects the mapped score', () => {
    assert.equal(scoreBoxDraw({ box: 2, distanceMeters: 410, raceType: 'greyhound' }), 75)
  })

  test('greyhound staying draw compresses the range', () => {
    assert.equal(scoreBoxDraw({ box: 8, distanceMeters: 520, raceType: 'greyhound' }), 55)
  })

  test('horse inside barrier scores higher than a wide draw relative to field size', () => {
    const inside = scoreBoxDraw({ barrier: 1, raceType: 'horse', fieldSize: 12 })
    const wide = scoreBoxDraw({ barrier: 12, raceType: 'horse', fieldSize: 12 })
    assert.equal(inside, 80)
    assert.equal(wide, 45)
    assert.ok(inside > wide)
  })

  test('uses empirical box bias data when the selected box has at least 10 samples', () => {
    const boxBiasData = {
      boxes: [
        { box: 3, total_predictions: 12, win_count: 4, win_rate_pct: 28.5 },
      ],
    }

    assert.equal(
      scoreBoxDraw({ name: 'Empirical Edge', box: 3, distanceMeters: 320, raceType: 'greyhound' }, boxBiasData),
      86
    )
  })

  test('falls back to the default box map when empirical data is insufficient for that box', () => {
    const boxBiasData = {
      boxes: [
        { box: 3, total_predictions: 9, win_count: 3, win_rate_pct: 33.3 },
      ],
    }

    assert.equal(
      scoreBoxDraw({ name: 'Fallback Dog', box: 3, distanceMeters: 320, raceType: 'greyhound' }, boxBiasData),
      65
    )
  })
})

describe('scoreClassConsistency', () => {
  test('high career top-three percentage scores in the premium range', () => {
    assert.equal(scoreClassConsistency({ careerTop3Pct: 75 }), 94)
  })

  test('mid-range top-three percentage scores in the solid range', () => {
    assert.equal(scoreClassConsistency({ careerTop3Pct: 50 }), 75)
  })

  test('low top-three percentage scores poorly', () => {
    assert.equal(scoreClassConsistency({ careerTop3Pct: 10 }), 15)
  })

  test('missing consistency data returns a neutral score', () => {
    assert.equal(scoreClassConsistency({}), 50)
  })
})

describe('scoreTrainerStrikeRate', () => {
  test('missing trainer data returns a neutral score', () => {
    assert.equal(scoreTrainerStrikeRate({}), 50)
  })

  test('high trainer strike rate scores strongly', () => {
    assert.equal(scoreTrainerStrikeRate({ trainerStrike: 30 }), 87)
  })

  test('moderate trainer strike rate lands in the middle band', () => {
    assert.equal(scoreTrainerStrikeRate({ trainerStrike: 10 }), 45)
  })

  test('very low trainer strike rate scores poorly', () => {
    assert.equal(scoreTrainerStrikeRate({ trainerStrike: 2 }), 12)
  })
})

describe('scoreDaysSinceLastRun', () => {
  test('ideal spacing of 7-21 days gets the ideal score', () => {
    assert.equal(scoreDaysSinceLastRun({ daysSinceLastRun: 10 }), 85)
  })

  test('quick back-up scores slightly lower than ideal', () => {
    assert.equal(scoreDaysSinceLastRun({ daysSinceLastRun: 5 }), 70)
  })

  test('slight freshen between 22 and 35 days is a mild query', () => {
    assert.equal(scoreDaysSinceLastRun({ daysSinceLastRun: 30 }), 65)
  })

  test('long spell beyond 60 days is penalised', () => {
    assert.equal(scoreDaysSinceLastRun({ daysSinceLastRun: 70 }), 25)
  })

  test('missing layoff data returns a neutral score', () => {
    assert.equal(scoreDaysSinceLastRun({}), 50)
  })
})

describe('scoreRunner and breakdown', () => {
  test('strong profile scores higher than a weak profile', () => {
    const strong = {
      box: 1,
      distanceMeters: 515,
      lastStarts: '1-1-2-1-2-1',
      bestTime: 29.45,
      trainerStrike: 28,
      careerTop3Pct: 70,
      daysSinceLastRun: 10,
    }
    const weak = {
      box: 8,
      distanceMeters: 515,
      lastStarts: '5-6-5-6-5-6',
      bestTime: 30.05,
      trainerStrike: 3,
      careerTop3Pct: 10,
      daysSinceLastRun: 70,
    }

    assert.ok(scoreRunner(strong, 29.7) > scoreRunner(weak, 29.7))
  })

  test('breakdown exposes every weighted factor', () => {
    const breakdown = buildScoreBreakdown({
      box: 2,
      distanceMeters: 515,
      lastStarts: '1-2-3-4-5-6',
      bestTime: 29.6,
      trainerStrike: 18,
      careerTop3Pct: 50,
      daysSinceLastRun: 14,
    }, 29.8)

    assert.deepEqual(Object.keys(breakdown), [
      'recentForm',
      'bestTime',
      'boxDraw',
      'classConsistency',
      'trainerStrikeRate',
      'daysSinceLastRun',
    ])
  })

  test('composite score stays in the 0-100 range', () => {
    const score = scoreRunner({
      box: 4,
      distanceMeters: 410,
      lastStarts: '2-2-2-2-2-2',
      bestTime: 29.9,
      trainerStrike: 15,
      careerTop3Pct: 60,
      daysSinceLastRun: 14,
    }, 30.0)

    assert.ok(score >= 0 && score <= 100)
  })
})

describe('applyMode', () => {
  const field = [
    {
      name: 'Anchor',
      box: 1,
      distanceMeters: 515,
      lastStarts: '1-1-2-1-2-1',
      bestTime: 29.45,
      trainerStrike: 28,
      careerTop3Pct: 72,
      daysSinceLastRun: 10,
      odds: 2.6,
    },
    {
      name: 'Overlay',
      box: 2,
      distanceMeters: 515,
      lastStarts: '1-2-1-2-3-1',
      bestTime: 29.5,
      trainerStrike: 20,
      careerTop3Pct: 64,
      daysSinceLastRun: 14,
      odds: 4.8,
    },
    {
      name: 'Solid',
      box: 4,
      distanceMeters: 515,
      lastStarts: '2-2-3-2-3-2',
      bestTime: 29.7,
      trainerStrike: 16,
      careerTop3Pct: 55,
      daysSinceLastRun: 18,
      odds: 6.5,
    },
    {
      name: 'Rocket',
      box: 7,
      distanceMeters: 515,
      lastStarts: '4-4-5-4-5-4',
      bestTime: 29.3,
      trainerStrike: 10,
      careerTop3Pct: 25,
      daysSinceLastRun: 30,
      odds: 14.0,
    },
    {
      name: 'Battler',
      box: 8,
      distanceMeters: 515,
      lastStarts: '6-6-5-6-6-5',
      bestTime: 30.1,
      trainerStrike: 3,
      careerTop3Pct: 8,
      daysSinceLastRun: 65,
      odds: 22.0,
    },
  ]

  test('safest returns the top composite scorer', () => {
    const result = applyMode(field, 'safest')
    assert.equal(result.runner.name, 'Anchor')
    assert.equal(result.score, result.compositeScore)
    assert.ok(result.breakdown)
  })

  test('value selects a runner within 15 points of the top scorer without picking the top scorer', () => {
    const result = applyMode(field, 'value')
    assert.equal(result.runner.name, 'Overlay')
    assert.notEqual(result.runner.name, 'Anchor')
  })

  test('longshot selects a runner ranked fourth or lower with genuine speed', () => {
    const result = applyMode(field, 'longshot')
    assert.equal(result.runner.name, 'Rocket')
    assert.ok(result.breakdown.bestTime > 70)
  })

  test('confidence is capped at 92 percent', () => {
    const result = applyMode([
      {
        name: 'Machine',
        box: 1,
        distanceMeters: 320,
        lastStarts: '1-1-1-1-1-1',
        bestTime: 28.8,
        trainerStrike: 40,
        careerTop3Pct: 100,
        daysSinceLastRun: 10,
      },
      {
        name: 'Plodder',
        box: 8,
        distanceMeters: 320,
        lastStarts: '6-6-5-6-6-5',
        bestTime: 30.2,
        trainerStrike: 1,
        careerTop3Pct: 5,
        daysSinceLastRun: 75,
      },
    ], 'safest')

    assert.equal(result.confidence, 92)
  })

  test('allScores includes breakdown objects for each runner', () => {
    const result = applyMode(field, 'safest')
    assert.equal(result.allScores.length, field.length)
    assert.ok(result.allScores[0].breakdown)
  })

  test('surfaces the empirical box bias source when the winning runner used it', () => {
    const result = applyMode([
      {
        name: 'Empirical Leader',
        box: 1,
        distanceMeters: 320,
        lastStarts: '1-1-2-1-2-1',
        bestTime: 18.6,
        trainerStrike: 20,
        careerTop3Pct: 70,
        daysSinceLastRun: 9,
        boxBiasData: {
          boxes: [
            { box: 1, total_predictions: 12, win_count: 4, win_rate_pct: 28 },
          ],
        },
      },
      {
        name: 'Standard Runner',
        box: 8,
        distanceMeters: 320,
        lastStarts: '4-5-4-5-4-5',
        bestTime: 19.1,
        trainerStrike: 6,
        careerTop3Pct: 25,
        daysSinceLastRun: 20,
      },
    ], 'safest')

    assert.equal(result.boxBiasSource, 'empirical')
    assert.equal(result.allScores[0].boxBiasSource, 'empirical')
  })

  test('throws for unrecognised mode', () => {
    assert.throws(() => applyMode(field, 'unknown'), /unknown mode/i)
  })

  test('handles a single-runner field gracefully', () => {
    const result = applyMode([field[0]], 'safest')
    assert.equal(result.runner.name, 'Anchor')
  })
})
