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
  calculateWinProbabilities,
  calculateEV,
  calculateExpectedReturn,
  classifyOdds,
  applyMode,
  generateBestBets,
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

describe('odds helpers', () => {
  test('calculateWinProbabilities returns probabilities that sum to 1.0', () => {
    const runners = calculateWinProbabilities([
      { name: 'Alpha', compositeScore: 70 },
      { name: 'Beta', compositeScore: 20 },
      { name: 'Gamma', compositeScore: 10 },
    ])

    const totalProbability = runners.reduce((sum, runner) => sum + runner.winProbability, 0)

    assert.equal(Number(totalProbability.toFixed(6)), 1)
    assert.equal(runners[0].winProbability, 0.7)
    assert.equal(runners[1].winProbability, 0.2)
    assert.equal(runners[2].winProbability, 0.1)
  })

  test('calculateWinProbabilities handles a single runner', () => {
    const [runner] = calculateWinProbabilities([{ name: 'Solo', compositeScore: 88 }])
    assert.equal(runner.winProbability, 1)
  })

  test('calculateEV returns the expected edge for known inputs', () => {
    assert.equal(calculateEV(0.4, 3.5), 0.4)
  })

  test('calculateEV returns null when odds are unavailable', () => {
    assert.equal(calculateEV(0.4, null), null)
  })

  test('calculateExpectedReturn returns the expected per-dollar return', () => {
    assert.equal(calculateExpectedReturn(1, 0.4, 3.5), 0.8)
  })

  test('classifyOdds maps each price range correctly', () => {
    assert.equal(classifyOdds(1.7), 'hotpot')
    assert.equal(classifyOdds(2.4), 'favourite')
    assert.equal(classifyOdds(4.8), 'midfield')
    assert.equal(classifyOdds(9.5), 'roughie')
    assert.equal(classifyOdds(15), 'longshot')
  })
})

function buildPreScoredRunner({
  name,
  box,
  compositeScore,
  recentForm = 60,
  bestTime = 60,
  boxDraw = 60,
  classConsistency = 60,
  trainerStrikeRate = 50,
  daysSinceLastRun = 70,
  decimalOdds = null,
  oddsSource = null,
}) {
  return {
    name,
    box,
    compositeScore,
    breakdown: {
      recentForm,
      bestTime,
      boxDraw,
      classConsistency,
      trainerStrikeRate,
      daysSinceLastRun,
    },
    ...(decimalOdds == null ? {} : { decimalOdds, odds: decimalOdds }),
    ...(oddsSource ? { oddsSource } : {}),
  }
}

describe('applyMode', () => {
  test('safest returns the top 3 qualifiers by win probability when odds are available', () => {
    const result = applyMode([
      buildPreScoredRunner({ name: 'Anchor', box: 1, compositeScore: 70, decimalOdds: 3.0, oddsSource: 'tab', bestTime: 78 }),
      buildPreScoredRunner({ name: 'Steady', box: 2, compositeScore: 60, decimalOdds: 3.4, oddsSource: 'tab', bestTime: 74 }),
      buildPreScoredRunner({ name: 'Measured', box: 3, compositeScore: 55, decimalOdds: 3.8, oddsSource: 'tab', bestTime: 72 }),
      buildPreScoredRunner({ name: 'Spec', box: 4, compositeScore: 15, decimalOdds: 10.0, oddsSource: 'tab', bestTime: 82 }),
    ], 'safest')

    assert.deepEqual(result.picks.map(runner => runner.name), ['Anchor', 'Steady', 'Measured'])
    assert.equal(result.oddsAvailable, true)
    assert.ok(result.picks.every((runner, index, collection) => index === 0 || collection[index - 1].winProbability >= runner.winProbability))
  })

  test('value returns only runners with EV above 0.15', () => {
    const result = applyMode([
      buildPreScoredRunner({ name: 'Market Lead', box: 1, compositeScore: 80, decimalOdds: 2.2, oddsSource: 'tab', bestTime: 76 }),
      buildPreScoredRunner({ name: 'Overlay', box: 2, compositeScore: 70, decimalOdds: 5.0, oddsSource: 'tab', bestTime: 74 }),
      buildPreScoredRunner({ name: 'Borderline', box: 3, compositeScore: 60, decimalOdds: 4.5, oddsSource: 'tab', bestTime: 72 }),
      buildPreScoredRunner({ name: 'Too Risky', box: 4, compositeScore: 25, decimalOdds: 9.0, oddsSource: 'tab', bestTime: 82 }),
    ], 'value')

    assert.deepEqual(result.picks.map(runner => runner.name), ['Overlay'])
    assert.ok(result.picks.every(runner => runner.ev > 0.15))
  })

  test('longshot requires odds of at least $8.00', () => {
    const result = applyMode([
      buildPreScoredRunner({ name: 'Leader', box: 1, compositeScore: 80, decimalOdds: 2.0, oddsSource: 'tab', bestTime: 65 }),
      buildPreScoredRunner({ name: 'Wide Drifter', box: 2, compositeScore: 65, decimalOdds: 9.0, oddsSource: 'tab', bestTime: 60 }),
      buildPreScoredRunner({ name: 'Fast Roughie', box: 3, compositeScore: 50, decimalOdds: 7.5, oddsSource: 'tab', bestTime: 91 }),
      buildPreScoredRunner({ name: 'Live Longshot', box: 4, compositeScore: 45, decimalOdds: 10.0, oddsSource: 'tab', bestTime: 82 }),
      buildPreScoredRunner({ name: 'Wild Card', box: 5, compositeScore: 40, decimalOdds: 14.0, oddsSource: 'tab', recentForm: 78, bestTime: 68 }),
    ], 'longshot')

    assert.deepEqual(result.picks.map(runner => runner.name), ['Wild Card', 'Live Longshot'])
    assert.ok(result.picks.every(runner => runner.decimalOdds >= 8))
  })

  test('falls back gracefully when odds are not provided', () => {
    const result = applyMode([
      buildPreScoredRunner({ name: 'Leader', box: 1, compositeScore: 80 }),
      buildPreScoredRunner({ name: 'Overlay', box: 2, compositeScore: 72, bestTime: 78 }),
      buildPreScoredRunner({ name: 'Closer', box: 3, compositeScore: 65, bestTime: 74 }),
    ], 'value')

    assert.equal(result.oddsAvailable, false)
    assert.deepEqual(result.picks.map(runner => runner.name), ['Overlay', 'Closer'])
  })

  test('returns one result when fewer than three runners qualify', () => {
    const result = applyMode([
      buildPreScoredRunner({ name: 'Leader', box: 1, compositeScore: 82, bestTime: 65 }),
      buildPreScoredRunner({ name: 'Second Pick', box: 2, compositeScore: 70, bestTime: 62 }),
      buildPreScoredRunner({ name: 'Third Pick', box: 3, compositeScore: 55, bestTime: 60 }),
      buildPreScoredRunner({ name: 'Solo Roughie', box: 4, compositeScore: 40, bestTime: 78 }),
      buildPreScoredRunner({ name: 'Non Qualifier', box: 5, compositeScore: 30, bestTime: 68 }),
    ], 'longshot')

    assert.equal(result.picks.length, 1)
    assert.equal(result.picks[0].name, 'Solo Roughie')
  })

  test('confidence is capped at 92 percent', () => {
    const result = applyMode([
      buildPreScoredRunner({ name: 'Machine', box: 1, compositeScore: 100, decimalOdds: 1.8, oddsSource: 'tab' }),
      buildPreScoredRunner({ name: 'Plodder', box: 8, compositeScore: 20, decimalOdds: 20.0, oddsSource: 'tab' }),
    ], 'safest')

    assert.equal(result.confidence, 92)
  })

  test('allScores includes breakdown objects, probabilities, and EV for each runner', () => {
    const result = applyMode([
      buildPreScoredRunner({ name: 'Anchor', box: 1, compositeScore: 70, decimalOdds: 3.0, oddsSource: 'tab', bestTime: 78 }),
      buildPreScoredRunner({ name: 'Steady', box: 2, compositeScore: 60, decimalOdds: 3.4, oddsSource: 'tab', bestTime: 74 }),
      buildPreScoredRunner({ name: 'Measured', box: 3, compositeScore: 55, decimalOdds: 3.8, oddsSource: 'tab', bestTime: 72 }),
    ], 'safest')

    assert.equal(result.allScores.length, 3)
    assert.ok(result.allScores[0].breakdown)
    assert.equal(typeof result.allScores[0].winProbability, 'number')
    assert.equal(typeof result.allScores[0].ev, 'number')
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
    assert.throws(() => applyMode([buildPreScoredRunner({ name: 'Anchor', box: 1, compositeScore: 70 })], 'unknown'), /unknown mode/i)
  })

  test('handles a single-runner field gracefully', () => {
    const result = applyMode([buildPreScoredRunner({ name: 'Anchor', box: 1, compositeScore: 70 })], 'safest')
    assert.equal(result.runner.name, 'Anchor')
    assert.equal(result.picks.length, 1)
  })
})

describe('generateBestBets', () => {
  function buildRace(index, overrides = {}) {
    return {
      track: `Track ${String(index).padStart(2, '0')}`,
      raceNumber: index,
      distance: 320 + index,
      estimatedStartTime: `1${index % 10}:0${index % 6}`,
      runners: overrides.runners ?? [
        buildPreScoredRunner({ name: `Race ${index} Anchor`, box: 1, compositeScore: 80 - index, decimalOdds: 2.8 + (index * 0.1), oddsSource: 'tab', bestTime: 78 }),
        buildPreScoredRunner({ name: `Race ${index} Overlay`, box: 2, compositeScore: 55 + index, decimalOdds: 5.2 + (index * 0.2), oddsSource: 'tab', bestTime: 80 }),
        buildPreScoredRunner({ name: `Race ${index} Longshot`, box: 3, compositeScore: 40 + index, decimalOdds: 10 + index, oddsSource: 'tab', bestTime: 82 }),
      ],
      ...overrides.race,
    }
  }

  test('returns the top 3 ranked picks for each mode', () => {
    const races = Array.from({ length: 4 }, (_, index) => buildRace(index + 1))
    const picks = generateBestBets(races)

    assert.deepEqual(Object.keys(picks), ['safest', 'value', 'longshot'])
    assert.equal(picks.safest.length, 3)
    assert.equal(picks.value.length, 3)
    assert.equal(picks.longshot.length, 3)

    for (let index = 1; index < picks.safest.length; index += 1) {
      assert.ok(picks.safest[index - 1].winProbability >= picks.safest[index].winProbability)
    }

    for (let index = 1; index < picks.value.length; index += 1) {
      assert.ok((picks.value[index - 1].ev ?? -Infinity) >= (picks.value[index].ev ?? -Infinity))
      assert.ok(picks.value[index - 1].rank < picks.value[index].rank)
    }

    for (let index = 1; index < picks.longshot.length; index += 1) {
      assert.ok((picks.longshot[index - 1].ev ?? -Infinity) >= (picks.longshot[index].ev ?? -Infinity))
    }
  })

  test('handles an empty race list gracefully', () => {
    assert.deepEqual(generateBestBets([]), {
      safest: [],
      value: [],
      longshot: [],
    })
  })

  test('handles races with a single runner', () => {
    const picks = generateBestBets([buildRace(1, {
      runners: [
        buildPreScoredRunner({ name: 'Solo Runner', box: 1, compositeScore: 78 }),
      ],
    })])

    assert.equal(picks.safest.length, 1)
    assert.equal(picks.value.length, 1)
    assert.equal(picks.longshot.length, 1)
    assert.equal(picks.safest[0].runnerName, 'Solo Runner')
    assert.equal(picks.safest[0].rank, 1)
  })

  test('includes detailed pick metadata in each mode bucket', () => {
    const picks = generateBestBets([buildRace(2)])

    assert.equal(picks.value[0].mode, 'value')
    assert.ok(picks.value[0].breakdown)
    assert.equal(typeof picks.value[0].confidence, 'number')
    assert.ok('winProbability' in picks.value[0])
  })
})
