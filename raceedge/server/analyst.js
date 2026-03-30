const Anthropic = require('@anthropic-ai/sdk')

const MODEL = 'claude-sonnet-4-20250514'
let warnedMissingKey = false

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeRunnerName(value) {
  return cleanText(value).toLowerCase()
}

function formatLastFour(formString) {
  const tokens = String(formString || '')
    .split(/[^A-Za-z0-9]+/)
    .map(token => token.trim())
    .filter(Boolean)
    .slice(0, 4)

  return tokens.length > 0 ? tokens.join('-') : 'N/A'
}

function buildRunnerSummary(runner, index) {
  const box = runner.box ?? runner.barrier ?? '—'
  const bestTime = runner.bestTime != null ? `${runner.bestTime}` : 'N/A'
  const factors = [
    `recent form ${runner.breakdown?.recentForm ?? 0}`,
    `best time ${runner.breakdown?.bestTime ?? 0}`,
    `draw ${runner.breakdown?.boxDraw ?? 0}`,
    `class ${runner.breakdown?.classConsistency ?? 0}`,
    `trainer ${runner.breakdown?.trainerStrikeRate ?? 0}`,
    `freshness ${runner.breakdown?.daysSinceLastRun ?? 0}`,
  ].join(', ')

  return `${index + 1}. ${runner.name} | Box ${box} | Last 4: ${formatLastFour(runner.lastStarts)} | Best time: ${bestTime} | Composite: ${runner.compositeScore ?? runner.score ?? 0} | Factors: ${factors}`
}

function buildPrompt(runners, raceContext) {
  const runnerLines = runners.map(buildRunnerSummary).join('\n')
  const topModelRunner = runners[0]?.name || 'Unknown'

  return `
You are an expert Australian ${raceContext.raceType === 'horse' ? 'horse racing' : 'greyhound racing'} form analyst.

Race context:
- Date: ${raceContext.date}
- Track: ${raceContext.track}
- Race Number: ${raceContext.raceNumber}
- Distance: ${raceContext.distance ?? 'Unknown'}m
- Grade/Class: ${raceContext.grade || 'Unknown'}
- Top model scorer from our quantitative model: ${topModelRunner}

Runner sheet:
${runnerLines}

Respond with JSON only using this shape:
{
  "recommendation": { "runner": "string", "box": 1, "reasoning": "2-3 sentences" },
  "valueWatch": { "runner": "string", "reasoning": "1-2 sentences" },
  "raceDynamic": "string",
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "confidenceReason": "string",
  "concerns": "string",
  "modelAgreement": true
}

Reason about pace, draw, sectional speed, suitability to track and distance, class profile, and risk. The recommendation should read like a professional local form preview, not generic AI commentary.
`.trim()
}

function extractJsonObject(text) {
  const trimmed = cleanText(text)
  if (!trimmed) return null

  const fencedMatch = trimmed.match(/```json\s*([\s\S]+?)```/i) || trimmed.match(/```\s*([\s\S]+?)```/i)
  const candidate = fencedMatch?.[1] || trimmed
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return null
  }
}

async function analyseRace(runners, raceContext) {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    if (!warnedMissingKey) {
      console.warn('[AI Analyst] ANTHROPIC_API_KEY not set; skipping AI analysis')
      warnedMissingKey = true
    }
    return null
  }

  if (!Array.isArray(runners) || runners.length === 0) {
    return null
  }

  try {
    const client = new Anthropic({ apiKey })
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 900,
      temperature: 0.35,
      messages: [
        {
          role: 'user',
          content: buildPrompt(runners, raceContext),
        },
      ],
    })

    const text = response.content
      ?.filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')

    const parsed = extractJsonObject(text)
    if (!parsed || !parsed.recommendation?.runner) {
      return null
    }

    const agreed = normalizeRunnerName(parsed.recommendation.runner) === normalizeRunnerName(runners[0]?.name)

    return {
      recommendation: {
        runner: cleanText(parsed.recommendation.runner),
        box: parsed.recommendation.box ?? null,
        reasoning: cleanText(parsed.recommendation.reasoning),
      },
      valueWatch: {
        runner: cleanText(parsed.valueWatch?.runner),
        reasoning: cleanText(parsed.valueWatch?.reasoning),
      },
      raceDynamic: cleanText(parsed.raceDynamic),
      confidence: ['HIGH', 'MEDIUM', 'LOW'].includes(parsed.confidence) ? parsed.confidence : 'MEDIUM',
      confidenceReason: cleanText(parsed.confidenceReason),
      concerns: cleanText(parsed.concerns),
      modelAgreement: agreed,
    }
  } catch (err) {
    console.warn('[AI Analyst] Claude analysis failed:', err.message)
    return null
  }
}

module.exports = {
  analyseRace,
}
