const cheerio = require('cheerio')

/**
 * @typedef {{ name:string, box?:number, barrier?:number, lastStarts?:string,
 *             bestTime?:number, trainer?:string, trainerStrike?:number, odds?:number }} RunnerData
 * @typedef {{ source:string, runners:RunnerData[], error:string|null }} ScraperResult
 */

// ── HTML parsers (exported for testing) ──────────────────────────────────────

function parseTheDogsHtml(html) {
  const $ = cheerio.load(html)
  const runners = []
  $('.runner-row').each((_, row) => {
    const name = $(row).find('.dog-name').text().trim()
    if (!name) return
    runners.push({
      name,
      box:        parseInt($(row).find('.box-number').text().trim(), 10) || undefined,
      lastStarts: $(row).find('.last-starts').text().trim() || undefined,
      bestTime:   parseFloat($(row).find('.best-time').text().trim()) || undefined,
      trainer:    $(row).find('.trainer-name').text().trim() || undefined,
    })
  })
  return runners
}

function parseRacingAndSportsHtml(html) {
  const $ = cheerio.load(html)
  const runners = []
  $('.form-runner, .runner-form-row').each((_, row) => {
    const name = $(row).find('.runner-name, .horse-name, .dog-name').text().trim()
    if (!name) return
    runners.push({
      name,
      box:        parseInt($(row).find('.box, .barrier').text().trim(), 10) || undefined,
      lastStarts: $(row).find('.form, .last-starts').text().trim() || undefined,
      trainer:    $(row).find('.trainer').text().trim() || undefined,
    })
  })
  return runners
}

// ── Source merging ────────────────────────────────────────────────────────────

function mergeSources(sourceLists) {
  const map = new Map()
  for (const list of sourceLists) {
    for (const runner of list) {
      const key = runner.name.toLowerCase().trim()
      if (!map.has(key)) {
        map.set(key, { ...runner })
      } else {
        const existing = map.get(key)
        for (const [k, v] of Object.entries(runner)) {
          if (v != null && existing[k] == null) existing[k] = v
        }
      }
    }
  }
  return Array.from(map.values())
}

// ── Static fetchers ───────────────────────────────────────────────────────────

const FETCH_OPTS = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RaceEdge/1.0)' }, signal: AbortSignal.timeout(10000) }

// State lookup for thedogs.com.au URL — extend as needed
const TRACK_STATE = {
  'sandown park': 'VIC', 'the meadows': 'VIC', 'shepparton': 'VIC', 'geelong': 'VIC', 'ballarat': 'VIC',
  'wentworth park': 'NSW', 'dapto': 'NSW', 'richmond': 'NSW',
  'albion park': 'QLD',
  'angle park': 'SA',
}

async function fetchTheDogs(date, track, raceNumber) {
  const slug  = track.toLowerCase().replace(/\s+/g, '-')
  const state = TRACK_STATE[track.toLowerCase()] || 'VIC'
  const url = `https://www.thedogs.com.au/racing/form-guide/${state}/${slug}/${date}/${raceNumber}`
  try {
    const res = await fetch(url, FETCH_OPTS)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { source: 'thedogs.com.au', runners: parseTheDogsHtml(await res.text()), error: null }
  } catch (err) {
    return { source: 'thedogs.com.au', runners: [], error: err.message }
  }
}

async function fetchRacingAndSports(date, track, raceNumber, raceType) {
  const seg = raceType === 'greyhound' ? 'greyhounds' : 'horse-racing'
  const slug = track.toLowerCase().replace(/\s+/g, '-')
  const url = `https://www.racingandsports.com.au/${seg}/form/${slug}/${date}/race-${raceNumber}`
  try {
    const res = await fetch(url, FETCH_OPTS)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return { source: 'racingandsports.com.au', runners: parseRacingAndSportsHtml(await res.text()), error: null }
  } catch (err) {
    return { source: 'racingandsports.com.au', runners: [], error: err.message }
  }
}

// NOTE: grv.org.au's form guide URL pattern may require authentication or varies by season.
// This implementation fetches the runner list from their public results page as a best-effort stub.
// Likely returns 0 runners for most races — that's acceptable; the source will appear in sourcesSkipped.
async function fetchGRV(date, track, raceNumber) {
  const slug = track.toLowerCase().replace(/\s+/g, '-')
  const url = `https://www.grv.org.au/racing/form/${slug}/${date}/race/${raceNumber}`
  try {
    const res = await fetch(url, FETCH_OPTS)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const $ = cheerio.load(await res.text())
    const runners = []
    $('table tr, .runner-row').each((_, row) => {
      const cells = $(row).find('td')
      if (cells.length >= 2) {
        const name = $(cells[1]).text().trim()
        if (name && name.length > 1 && !/runner|name/i.test(name)) {
          runners.push({ name, box: parseInt($(cells[0]).text(), 10) || undefined })
        }
      }
    })
    return { source: 'grv.org.au', runners, error: null }
  } catch (err) {
    return { source: 'grv.org.au', runners: [], error: err.message }
  }
}

// NOTE: racingaustralia.horse does not have a clean public form-guide API.
// This fetches their free fields/acceptances page and extracts whatever runner data is present.
// Returns sparse data (name + barrier) when it works; gracefully returns [] on failure.
async function fetchRacingAustralia(date, track, raceNumber) {
  const url = `https://racingaustralia.horse/FreeFields/Calendar_Entries.aspx?Track=${encodeURIComponent(track)}&Date=${date}`
  try {
    const res = await fetch(url, FETCH_OPTS)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const $ = cheerio.load(await res.text())
    const runners = []
    $('table.acceptances tr, .runner-row').each((_, row) => {
      const name = $(row).find('.horse-name, td:nth-child(2)').first().text().trim()
      if (name && name.length > 1) {
        runners.push({
          name,
          barrier: parseInt($(row).find('.barrier, td:first-child').first().text(), 10) || undefined,
          trainer: $(row).find('.trainer, td:nth-child(3)').first().text().trim() || undefined,
        })
      }
    })
    return { source: 'racingaustralia.horse', runners, error: null }
  } catch (err) {
    return { source: 'racingaustralia.horse', runners: [], error: err.message }
  }
}

// ── Meeting list ──────────────────────────────────────────────────────────────

const FALLBACK_DOGS   = ['Sandown Park','The Meadows','Shepparton','Geelong','Ballarat','Wentworth Park','Dapto','Richmond','Albion Park','Angle Park']
const FALLBACK_HORSES = ['Flemington','Caulfield','Moonee Valley','Randwick','Rosehill','Doomben','Eagle Farm','Morphettville','Ascot','Ellerslie']

async function fetchMeetings(date, raceType) {
  const seg = raceType === 'greyhound' ? 'greyhounds' : 'horse-racing'
  const url = `https://www.racingandsports.com.au/${seg}/form/${date}`
  try {
    const res = await fetch(url, FETCH_OPTS)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const $ = cheerio.load(await res.text())
    const meetings = []
    $('.venue-name, .track-name, .meeting-name').each((_, el) => {
      const name = $(el).text().trim()
      if (name && name.length > 2 && !meetings.includes(name)) meetings.push(name)
    })
    return meetings.length > 0 ? meetings : (raceType === 'greyhound' ? FALLBACK_DOGS : FALLBACK_HORSES)
  } catch {
    return raceType === 'greyhound' ? FALLBACK_DOGS : FALLBACK_HORSES
  }
}

// ── Puppeteer layer ───────────────────────────────────────────────────────────

let _browser = null
let _puppeteerAvailable = true

async function getBrowser() {
  if (!_puppeteerAvailable) return null
  if (_browser) return _browser
  try {
    const puppeteer = require('puppeteer')
    _browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
    return _browser
  } catch (err) {
    console.error('[Puppeteer] Failed to launch:', err.message)
    _puppeteerAvailable = false
    return null
  }
}

async function puppeteerGetHtml(url, waitSelector, timeout = 15000) {
  const browser = await getBrowser()
  if (!browser) throw new Error('Puppeteer unavailable')
  const page = await browser.newPage()
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36')
    await page.goto(url, { waitUntil: 'networkidle2', timeout })
    if (waitSelector) await page.waitForSelector(waitSelector, { timeout: 5000 }).catch(() => {})
    return await page.content()
  } finally {
    await page.close()
  }
}

async function fetchTAB(date, track, raceNumber, raceType) {
  const seg = raceType === 'greyhound' ? 'greyhounds' : 'racing'
  const slug = track.toLowerCase().replace(/\s+/g, '-')
  const url = `https://www.tab.com.au/${seg}/meeting/${slug}/${date}/race/${raceNumber}`
  try {
    const html = await puppeteerGetHtml(url, '[class*="runner-name"],[class*="RunnerName"]')
    const $ = cheerio.load(html)
    const runners = []
    $('[class*="runner-row"],[class*="RunnerRow"],[class*="competitor-row"]').each((_, row) => {
      const name = $(row).find('[class*="runner-name"],[class*="RunnerName"],[class*="competitor-name"]').first().text().trim()
      if (!name) return
      const oddsText = $(row).find('[class*="odds"],[class*="price"],[class*="Price"]').first().text().trim()
      runners.push({
        name,
        box:  parseInt($(row).find('[class*="box"],[class*="Box"]').first().text(), 10) || undefined,
        odds: parseFloat(oddsText) || undefined,
      })
    })
    return { source: 'tab.com.au', runners, error: null }
  } catch (err) {
    return { source: 'tab.com.au', runners: [], error: err.message }
  }
}

async function fetchRacenet(date, track, raceNumber) {
  const slug = track.toLowerCase().replace(/\s+/g, '-')
  const url = `https://www.racenet.com.au/horse-racing/${slug}/${date}/race-${raceNumber}`
  try {
    const html = await puppeteerGetHtml(url, '[class*="runner"],[class*="Runner"]')
    const $ = cheerio.load(html)
    const runners = []
    $('[class*="runner-row"],[class*="RunnerRow"],.race-runner').each((_, row) => {
      const name = $(row).find('[class*="horse-name"],[class*="HorseName"],[class*="runner-name"]').first().text().trim()
      if (!name) return
      const oddsText = $(row).find('[class*="odds"],[class*="price"]').first().text().trim()
      runners.push({
        name,
        barrier: parseInt($(row).find('[class*="barrier"],[class*="Barrier"]').first().text(), 10) || undefined,
        trainer: $(row).find('[class*="trainer"],[class*="Trainer"]').first().text().trim() || undefined,
        odds:    parseFloat(oddsText) || undefined,
      })
    })
    return { source: 'racenet.com.au', runners, error: null }
  } catch (err) {
    return { source: 'racenet.com.au', runners: [], error: err.message }
  }
}

async function fetchPunters(date, track, raceNumber) {
  const slug = track.toLowerCase().replace(/\s+/g, '-')
  const url = `https://www.punters.com.au/horse-racing/${slug}/${date}/?race=${raceNumber}`
  try {
    const html = await puppeteerGetHtml(url, '[class*="runner"],[class*="Runner"]')
    const $ = cheerio.load(html)
    const runners = []
    $('[class*="Runner"],[class*="runner-item"],.runner').each((_, row) => {
      const name = $(row).find('[class*="horse"],[class*="name"]').first().text().trim()
      if (!name) return
      const oddsText = $(row).find('[class*="odds"],[class*="price"]').first().text().trim()
      runners.push({
        name,
        barrier: parseInt($(row).find('[class*="barrier"],[class*="cloth"]').first().text(), 10) || undefined,
        trainer: $(row).find('[class*="trainer"]').first().text().trim() || undefined,
        odds:    parseFloat(oddsText) || undefined,
      })
    })
    return { source: 'punters.com.au', runners, error: null }
  } catch (err) {
    return { source: 'punters.com.au', runners: [], error: err.message }
  }
}

// ── Main research entry point ─────────────────────────────────────────────────

async function research(date, track, raceNumber, raceType) {
  const fetchers = raceType === 'greyhound'
    ? [
        fetchTheDogs,
        (d, t, r) => fetchRacingAndSports(d, t, r, 'greyhound'),
        fetchGRV,
        (d, t, r) => fetchTAB(d, t, r, 'greyhound'),
      ]
    : [
        fetchRacingAustralia,
        (d, t, r) => fetchRacingAndSports(d, t, r, 'horse'),
        (d, t, r) => fetchTAB(d, t, r, 'horse'),
        fetchRacenet,
        fetchPunters,
      ]

  const settled = await Promise.allSettled(fetchers.map(fn => fn(date, track, raceNumber)))
  const scraperResults = settled.map(r =>
    r.status === 'fulfilled' ? r.value : { source: 'unknown', runners: [], error: r.reason?.message }
  )

  const successful = scraperResults.filter(r => r.runners.length > 0)
  const runners = mergeSources(successful.map(r => r.runners))

  return {
    runners,
    sources: scraperResults,
    sourcesUsed:    successful.map(r => r.source),
    sourcesSkipped: scraperResults.filter(r => r.error || r.runners.length === 0).map(r => ({ source: r.source, reason: r.error || 'no data' })),
    warning: successful.length < 2 ? `Only ${successful.length} source(s) returned data — predictions may be unreliable` : null,
  }
}

async function closeBrowser() {
  if (_browser) { await _browser.close(); _browser = null }
}

module.exports = { research, fetchMeetings, closeBrowser, parseTheDogsHtml, parseRacingAndSportsHtml, mergeSources }
