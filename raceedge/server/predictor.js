const FACTOR_WEIGHTS = {
  recentForm: 0.30,
  bestTime: 0.25,
  boxDraw: 0.15,
  classConsistency: 0.15,
  trainerStrikeRate: 0.10,
  daysSinceLastRun: 0.05,
}

const FORM_RECENCY_WEIGHTS = [6, 5, 4, 3, 2, 1]
const FORM_MAX_POINTS = FORM_RECENCY_WEIGHTS.reduce((sum, weight) => sum + weight, 0)
const MAX_COMPOSITE_SCORE = 100

const DNF_MARKERS = new Set(['F', 'DNF', 'PU', 'UR', 'BD', 'FF', 'REF', 'NP'])

const GREYHOUND_BOX_SCORES = {
  sprint:  { 1: 85, 2: 75, 3: 65, 4: 70, 5: 60, 6: 55, 7: 50, 8: 45 },
  middle:  { 1: 70, 2: 75, 3: 72, 4: 68, 5: 65, 6: 60, 7: 55, 8: 50 },
  staying: { 1: 70, 2: 68, 3: 66, 4: 64, 5: 62, 6: 60, 7: 58, 8: 55 },
}

const FACTOR_LABELS = {
  recentForm: 'recent form',
  bestTime: 'best time',
  boxDraw: 'draw',
  classConsistency: 'class consistency',
  trainerStrikeRate: 'trainer strike rate',
  daysSinceLastRun: 'days since last run',
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value))
}

function roundScore(value) {
  return clamp(Math.round(value))
}

function interpolate(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMax
  const ratio = clamp((value - inMin) / (inMax - inMin), 0, 1)
  return outMin + (outMax - outMin) * ratio
}

function toNumber(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  const parsed = parseFloat(String(value).replace(/[^0-9.-]/g, ''))
  return Number.isFinite(parsed) ? parsed : null
}

function splitFormTokens(lastStarts) {
  if (!lastStarts) return []
  return String(lastStarts)
    .split(/[^A-Za-z0-9]+/)
    .map(token => token.trim())
    .filter(Boolean)
}

function parseFormFinish(token) {
  if (token == null) return null
  const normalized = String(token).trim().toUpperCase()
  if (!normalized) return null
  if (DNF_MARKERS.has(normalized)) return 'dnf'
  if (/(DNF|PU|UR|BD|FF|REF)/.test(normalized)) return 'dnf'
  const placing = parseInt(normalized, 10)
  return Number.isInteger(placing) ? placing : null
}

function inferRaceType(runner) {
  const explicit = typeof runner.raceType === 'string' ? runner.raceType.toLowerCase() : null
  if (explicit === 'greyhound' || explicit === 'horse') return explicit
  if (runner.box != null && runner.barrier == null) return 'greyhound'
  if (runner.barrier != null) return 'horse'
  if (runner.box != null) return 'greyhound'
  return 'greyhound'
}

function getDistanceMeters(runner) {
  return (
    toNumber(runner.distanceMeters) ??
    toNumber(runner.raceDistance) ??
    toNumber(runner.distance) ??
    toNumber(runner.trackDistance)
  )
}

function getGreyhoundBoxProfile(distance) {
  if (distance == null) return GREYHOUND_BOX_SCORES.middle
  if (distance <= 320) return GREYHOUND_BOX_SCORES.sprint
  if (distance <= 430) return GREYHOUND_BOX_SCORES.middle
  return GREYHOUND_BOX_SCORES.staying
}

function getDefaultBoxBiasTable(distance) {
  const profile = getGreyhoundBoxProfile(toNumber(distance))
  const total = Object.values(profile).reduce((sum, score) => sum + score, 0)

  return {
    source: 'default',
    boxes: Object.entries(profile).map(([box, score]) => ({
      box: Number(box),
      total_predictions: 0,
      win_count: 0,
      win_rate_pct: roundScore((score / total) * 100),
      default_score: score,
    })),
  }
}

function getDaysSinceLastRunValue(runner) {
  const explicitDays = toNumber(runner.daysSinceLastRun)
  if (explicitDays != null) return explicitDays

  const lastRunDate = runner.lastRunDate || runner.lastRun
  const raceDate = runner.raceDate || runner.date
  if (!lastRunDate || !raceDate) return null

  const last = new Date(lastRunDate)
  const race = new Date(raceDate)
  if (Number.isNaN(last.getTime()) || Number.isNaN(race.getTime())) return null

  return Math.round((race.getTime() - last.getTime()) / (1000 * 60 * 60 * 24))
}

function getCareerTop3Rate(runner) {
  const directRate = toNumber(runner.careerTop3Pct ?? runner.top3Pct)
  if (directRate != null) return clamp(directRate)

  const careerStarts = toNumber(runner.careerStarts ?? runner.starts)
  const top3Count = toNumber(runner.careerTop3Count ?? runner.careerPlacings ?? runner.top3Count)
  if (careerStarts && top3Count != null) {
    return clamp((top3Count / careerStarts) * 100)
  }

  const wins = toNumber(runner.careerWins ?? runner.wins)
  const seconds = toNumber(runner.careerSeconds ?? runner.seconds)
  const thirds = toNumber(runner.careerThirds ?? runner.thirds)
  if (careerStarts && (wins != null || seconds != null || thirds != null)) {
    return clamp((((wins || 0) + (seconds || 0) + (thirds || 0)) / careerStarts) * 100)
  }

  const finishes = splitFormTokens(runner.lastStarts)
    .map(parseFormFinish)
    .filter(finish => finish != null)

  if (finishes.length === 0) return null

  const top3 = finishes.filter(finish => typeof finish === 'number' && finish <= 3).length
  return clamp((top3 / finishes.length) * 100)
}

function scoreRecentForm(runner) {
  const finishes = splitFormTokens(runner.lastStarts)
    .map(parseFormFinish)
    .slice(0, FORM_RECENCY_WEIGHTS.length)

  if (finishes.length === 0) return 50

  const rawPoints = finishes.reduce((total, finish, index) => {
    const weight = FORM_RECENCY_WEIGHTS[index]
    if (finish === 1) return total + weight
    if (finish === 2) return total + (weight * 0.7)
    if (finish === 3) return total + (weight * 0.4)
    if (finish === 4) return total + (weight * 0.2)
    if (finish === 'dnf') return total - (weight * 0.1)
    return total
  }, 0)

  return roundScore((Math.max(rawPoints, 0) / FORM_MAX_POINTS) * 100)
}

function scoreBestTime(runner, fieldAvgTime) {
  const bestTime = toNumber(runner.bestTime)
  if (bestTime == null || fieldAvgTime == null) return 45

  const diff = fieldAvgTime - bestTime
  if (diff > 0.5) {
    return roundScore(interpolate(Math.min(diff, 1.0), 0.5, 1.0, 90, 100))
  }
  if (diff >= 0) {
    return roundScore(interpolate(diff, 0, 0.5, 60, 89))
  }
  return roundScore(interpolate(Math.min(Math.abs(diff), 1.0), 0, 1.0, 59, 20))
}

function getBoxDrawEvaluation(runner, boxBiasData = runner.boxBiasData) {
  const raceType = inferRaceType(runner)
  const box = toNumber(runner.box ?? runner.barrier)

  if (boxBiasData?.boxes && box != null) {
    const empiricalBox = boxBiasData.boxes.find(entry => Number(entry.box) === Math.round(box))
    if (empiricalBox && Number(empiricalBox.total_predictions) >= 10) {
      const score = roundScore(clamp(Number(empiricalBox.win_rate_pct) * 3, 0, 100))
      console.log(`[Predictor] Box draw mode: empirical (${runner.name || `box ${box}`})`)
      return { score, source: 'empirical' }
    }
  }

  console.log(`[Predictor] Box draw mode: default (${runner.name || `box ${box ?? 'n/a'}`})`)

  if (raceType === 'horse') {
    const barrier = toNumber(runner.barrier ?? runner.box)
    if (barrier == null) return { score: 50, source: 'default' }

    const fieldSize = Math.max(
      toNumber(runner.fieldSize) || 0,
      Math.round(barrier),
      8
    )

    if (fieldSize <= 1) return { score: 70, source: 'default' }

    const insideAdvantage = 1 - ((barrier - 1) / Math.max(fieldSize - 1, 1))
    return { score: roundScore(45 + (insideAdvantage * 35)), source: 'default' }
  }

  if (box == null) return { score: 50, source: 'default' }

  const distance = getDistanceMeters(runner)
  const profile = getGreyhoundBoxProfile(distance)

  return { score: profile[Math.round(box)] ?? 50, source: 'default' }
}

function scoreBoxDraw(runner, boxBiasData = runner.boxBiasData) {
  return getBoxDrawEvaluation(runner, boxBiasData).score
}

function scoreClassConsistency(runner) {
  const top3Rate = getCareerTop3Rate(runner)
  if (top3Rate == null) return 50

  if (top3Rate >= 60) {
    return roundScore(interpolate(top3Rate, 60, 100, 90, 100))
  }
  if (top3Rate >= 40) {
    return roundScore(interpolate(top3Rate, 40, 60, 60, 89))
  }
  if (top3Rate >= 20) {
    return roundScore(interpolate(top3Rate, 20, 40, 30, 59))
  }
  return roundScore(interpolate(top3Rate, 0, 20, 0, 29))
}

function scoreTrainerStrikeRate(runner) {
  const strikeRate = toNumber(runner.trainerStrike ?? runner.trainerStrikeRate)
  if (strikeRate == null) return 50

  if (strikeRate > 25) {
    return roundScore(interpolate(Math.min(strikeRate, 40), 25, 40, 80, 100))
  }
  if (strikeRate >= 15) {
    return roundScore(interpolate(strikeRate, 15, 25, 60, 79))
  }
  if (strikeRate >= 5) {
    return roundScore(interpolate(strikeRate, 5, 15, 30, 59))
  }
  return roundScore(interpolate(Math.max(strikeRate, 0), 0, 5, 0, 29))
}

function scoreDaysSinceLastRun(runner) {
  const days = getDaysSinceLastRunValue(runner)
  if (days == null || days < 0) return 50
  if (days >= 7 && days <= 21) return 85
  if (days >= 4 && days <= 6) return 70
  if (days >= 22 && days <= 35) return 65
  if (days >= 36 && days <= 60) return 45
  if (days > 60) return 25
  return 55
}

function buildScoreProfile(runner, fieldAvgTime) {
  const boxDraw = getBoxDrawEvaluation(runner, runner.boxBiasData)

  return {
    breakdown: {
      recentForm: scoreRecentForm(runner),
      bestTime: scoreBestTime(runner, fieldAvgTime),
      boxDraw: boxDraw.score,
      classConsistency: scoreClassConsistency(runner),
      trainerStrikeRate: scoreTrainerStrikeRate(runner),
      daysSinceLastRun: scoreDaysSinceLastRun(runner),
    },
    boxBiasSource: boxDraw.source,
  }
}

function buildScoreBreakdown(runner, fieldAvgTime) {
  return buildScoreProfile(runner, fieldAvgTime).breakdown
}

function getCompositeScore(breakdown) {
  return roundScore(
    (breakdown.recentForm * FACTOR_WEIGHTS.recentForm) +
    (breakdown.bestTime * FACTOR_WEIGHTS.bestTime) +
    (breakdown.boxDraw * FACTOR_WEIGHTS.boxDraw) +
    (breakdown.classConsistency * FACTOR_WEIGHTS.classConsistency) +
    (breakdown.trainerStrikeRate * FACTOR_WEIGHTS.trainerStrikeRate) +
    (breakdown.daysSinceLastRun * FACTOR_WEIGHTS.daysSinceLastRun)
  )
}

function scoreRunner(runner, fieldAvgTime) {
  return getCompositeScore(buildScoreBreakdown(runner, fieldAvgTime))
}

function buildReasoning(entry, rankedEntries, mode, fieldAvgTime) {
  const rank = rankedEntries.findIndex(item => item.runner.name === entry.runner.name) + 1
  const rankedFactors = Object.entries(entry.breakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)

  const parts = [`${entry.runner.name} ranks #${rank} of ${rankedEntries.length} on weighted composite scoring.`]

  if (rankedFactors.length > 0) {
    const summary = rankedFactors
      .map(([factor, score]) => `${FACTOR_LABELS[factor] || factor} ${score}`)
      .join(', ')
    parts.push(`Best factors: ${summary}.`)
  }

  if (entry.runner.lastStarts) {
    parts.push(`Recent form line: ${entry.runner.lastStarts}.`)
  }

  if (toNumber(entry.runner.bestTime) != null && fieldAvgTime != null) {
    const diff = fieldAvgTime - entry.runner.bestTime
    if (diff > 0) {
      parts.push(`Best time ${entry.runner.bestTime}s is ${diff.toFixed(2)}s quicker than the field average.`)
    } else if (diff < 0) {
      parts.push(`Best time ${entry.runner.bestTime}s is ${Math.abs(diff).toFixed(2)}s off the field average.`)
    }
  }

  if (mode === 'value') {
    const topScore = rankedEntries[0]?.compositeScore ?? entry.compositeScore
    parts.push(`Chosen as the value play: within ${Math.abs(topScore - entry.compositeScore)} points of the top scorer without being the headline pick.`)
  }

  if (mode === 'longshot') {
    parts.push(`Chosen as the long shot: ranked outside the top three overall but still carrying a real speed edge.`)
  }

  return parts.join(' ')
}

function buildScoredEntry(runner, fieldAvgTime, fieldSize) {
  const enrichedRunner = {
    ...runner,
    fieldSize: runner.fieldSize ?? fieldSize,
  }
  const { breakdown, boxBiasSource } = buildScoreProfile(enrichedRunner, fieldAvgTime)
  const compositeScore = getCompositeScore(breakdown)

  return {
    runner,
    breakdown,
    compositeScore,
    score: compositeScore,
    confidence: Math.min(92, Math.round((compositeScore / MAX_COMPOSITE_SCORE) * 100)),
    boxBiasSource,
  }
}

/**
 * Select the best runner for the given mode.
 * @param {import('./scraper').RunnerData[]} runners
 * @param {'safest'|'value'|'longshot'} mode
 */
function applyMode(runners, mode) {
  if (!['safest', 'value', 'longshot'].includes(mode)) {
    throw new Error(`Unknown mode: ${mode}`)
  }
  if (!Array.isArray(runners) || runners.length === 0) {
    throw new Error('No runners supplied')
  }

  const times = runners.map(runner => toNumber(runner.bestTime)).filter(time => time != null)
  const fieldAvgTime = times.length > 0
    ? times.reduce((sum, time) => sum + time, 0) / times.length
    : null
  const fieldSize = runners.length

  const scored = runners
    .map(runner => buildScoredEntry(runner, fieldAvgTime, fieldSize))
    .sort((a, b) => b.compositeScore - a.compositeScore || (a.runner.odds ?? Infinity) - (b.runner.odds ?? Infinity))

  const topEntry = scored[0]
  let selected = topEntry

  if (mode === 'value') {
    const candidates = scored.filter((entry, index) =>
      index > 0 &&
      entry.compositeScore > 55 &&
      (topEntry.compositeScore - entry.compositeScore) <= 15
    )
    selected = candidates[0] || scored[Math.min(1, scored.length - 1)]
  } else if (mode === 'longshot') {
    const candidates = scored.filter((entry, index) =>
      index >= 3 &&
      entry.compositeScore > 40 &&
      entry.breakdown.bestTime > 70
    )
    selected = candidates[0] || scored[Math.min(3, scored.length - 1)]
  }

  const reasoning = buildReasoning(selected, scored, mode, fieldAvgTime)

  return {
    runner: selected.runner,
    score: selected.compositeScore,
    compositeScore: selected.compositeScore,
    confidence: selected.confidence,
    breakdown: {
      recentForm: selected.breakdown.recentForm,
      bestTime: selected.breakdown.bestTime,
      boxDraw: selected.breakdown.boxDraw,
      classConsistency: selected.breakdown.classConsistency,
      trainerStrikeRate: selected.breakdown.trainerStrikeRate,
      daysSinceLastRun: selected.breakdown.daysSinceLastRun,
    },
    boxBiasSource: selected.boxBiasSource,
    mode,
    reasoning,
    allScores: scored.map(entry => ({
      name: entry.runner.name,
      box: entry.runner.box,
      barrier: entry.runner.barrier,
      odds: entry.runner.odds,
      score: entry.compositeScore,
      compositeScore: entry.compositeScore,
      confidence: entry.confidence,
      breakdown: {
        recentForm: entry.breakdown.recentForm,
        bestTime: entry.breakdown.bestTime,
        boxDraw: entry.breakdown.boxDraw,
        classConsistency: entry.breakdown.classConsistency,
        trainerStrikeRate: entry.breakdown.trainerStrikeRate,
        daysSinceLastRun: entry.breakdown.daysSinceLastRun,
      },
      boxBiasSource: entry.boxBiasSource,
    })),
  }
}

module.exports = {
  FACTOR_WEIGHTS,
  buildScoreBreakdown,
  getDefaultBoxBiasTable,
  scoreRunner,
  scoreRecentForm,
  scoreBestTime,
  scoreBoxDraw,
  scoreClassConsistency,
  scoreTrainerStrikeRate,
  scoreDaysSinceLastRun,
  applyMode,
}
