/**
 * Score a single runner 0–100.
 * @param {import('./scraper').RunnerData} runner
 * @param {number|null} fieldAvgTime
 */
function scoreRunner(runner, fieldAvgTime) {
  let score = 0

  // Recent form: win=5pts, place=2pts, show=1pt, cap at 20
  if (runner.lastStarts) {
    const places = runner.lastStarts.split('-').map(Number).filter(n => !isNaN(n)).slice(0, 6)
    for (const p of places) {
      if (p === 1) score += 5
      else if (p === 2) score += 2
      else if (p === 3) score += 1
    }
    score = Math.min(score, 20)
  }

  // Best time vs field average: up to 15pts
  if (runner.bestTime && fieldAvgTime) {
    const diff = fieldAvgTime - runner.bestTime
    if (diff > 0) score += Math.min(diff * 10, 15)
  }

  // Box/barrier advantage (boxes 1–4): 5pts
  if (runner.box && runner.box <= 4) score += 5

  // Trainer strike rate
  if (runner.trainerStrike) {
    if (runner.trainerStrike >= 25)      score += 10
    else if (runner.trainerStrike >= 20) score += 7
    else if (runner.trainerStrike >= 15) score += 4
  }

  // Class consistency: all top-3 in last 4 starts
  if (runner.lastStarts) {
    const last4 = runner.lastStarts.split('-').map(Number).filter(n => !isNaN(n)).slice(0, 4)
    if (last4.length >= 4 && last4.every(p => p <= 3)) score += 3
  }

  return Math.min(Math.max(Math.round(score), 0), 100)
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

  const times = runners.map(r => r.bestTime).filter(Boolean)
  const fieldAvgTime = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : null

  const scored = runners
    .map(r => ({ runner: r, score: scoreRunner(r, fieldAvgTime) }))
    .sort((a, b) => b.score - a.score)

  let selected

  if (mode === 'safest') {
    selected = scored[0]

  } else if (mode === 'value') {
    const minOdds = Math.min(...runners.map(r => r.odds || 999))
    const nonFav = scored.filter(s => !s.runner.odds || s.runner.odds > minOdds * 1.1) // 10% margin handles co-favourites
    selected = nonFav.length > 0 ? nonFav[0] : scored[Math.min(1, scored.length - 1)]

  } else { // longshot
    const minOdds = Math.min(...runners.map(r => r.odds || 999))
    const candidates = scored.filter(s => {
      const r = s.runner
      if (r.odds && r.odds <= minOdds) return false // exclude favourite
      const hasOdds      = !r.odds || r.odds >= 3.00
      const hasBestTime  = r.bestTime && fieldAvgTime && r.bestTime < fieldAvgTime
      const hasRecentWin = r.lastStarts && r.lastStarts.split('-').slice(0, 3).includes('1')
      const hasBoxAdv    = r.box && r.box <= 3
      return hasOdds && (hasBestTime || hasRecentWin || hasBoxAdv)
    })
    selected = candidates.length > 0 ? candidates[0] : scored[Math.min(2, scored.length - 1)]
  }

  const maxScore    = scored[0].score
  const confidence  = maxScore > 0 ? Math.round((selected.score / maxScore) * 0.85 * 100) / 100 : 0.50
  const reasoning   = buildReasoning(selected.runner, scored, mode, fieldAvgTime)

  return {
    runner:    selected.runner,
    score:     selected.score,
    confidence,
    mode,
    reasoning,
    allScores: scored.map(s => ({ name: s.runner.name, score: s.score, odds: s.runner.odds })),
  }
}

function buildReasoning(runner, scored, mode, fieldAvgTime) {
  const rank  = scored.findIndex(s => s.runner.name === runner.name) + 1
  const parts = [`${runner.name} ranks #${rank} of ${scored.length} on composite score.`]

  if (runner.lastStarts) parts.push(`Recent form: ${runner.lastStarts}.`)

  if (runner.bestTime && fieldAvgTime) {
    const diff = fieldAvgTime - runner.bestTime
    if (diff > 0) parts.push(`Best time ${runner.bestTime}s is ${diff.toFixed(2)}s faster than field average.`)
  }

  if (runner.box && runner.box <= 4) parts.push(`Box ${runner.box} is an advantaged draw.`)
  if (runner.barrier) parts.push(`Barrier ${runner.barrier}.`)
  if (runner.trainerStrike >= 20) parts.push(`Trainer strike rate ${runner.trainerStrike}% is above average.`)

  if (mode === 'value'    && runner.odds) parts.push(`At $${runner.odds.toFixed(2)} offers value over the favourite.`)
  if (mode === 'longshot')                parts.push(`Selected as longshot — lower market profile with specific form indicators.`)

  return parts.join(' ')
}

module.exports = { scoreRunner, applyMode }
