const cheerio = require('cheerio')
const { logScraperHealth } = require('./database.js')

/**
 * @typedef {{ name:string, box?:number, barrier?:number, lastStarts?:string,
 *             bestTime?:number, trainer?:string, trainerStrike?:number, odds?:number }} RunnerData
 * @typedef {{ source:string, runners:RunnerData[], error:string|null }} ScraperResult
 */

// ── Config ───────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT = parseInt(process.env.FETCH_TIMEOUT, 10) || 10000
const PUPPETEER_NAV_TIMEOUT = parseInt(process.env.PUPPETEER_NAV_TIMEOUT, 10) || 15000
const PUPPETEER_WAIT_TIMEOUT = parseInt(process.env.PUPPETEER_WAIT_TIMEOUT, 10) || 5000

async function fetchWithRetry(url, opts, retries = 1, backoffMs = 1000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, opts)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (err) {
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, backoffMs * (attempt + 1)))
        continue
      }
      throw err
    }
  }
}

// ── Cache ────────────────────────────────────────────────────────────────────
const _cache = new Map()
const CACHE_TTL = 5 * 60 * 1000

function cacheKey(source, date, track, raceNumber) {
  return `${source}|${date}|${track.toLowerCase()}|${raceNumber}`
}

function getCached(key) {
  const entry = _cache.get(key)
  if (entry && Date.now() - entry.ts < CACHE_TTL) return entry.data
  _cache.delete(key)
  return null
}

function setCache(key, data) {
  _cache.set(key, { data, ts: Date.now() })
}

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

function cleanText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizeTimeText(value) {
  const text = cleanText(value)
  if (!text) return null

  const isoMatch = text.match(/T(\d{2}):(\d{2})/)
  if (isoMatch) {
    return `${isoMatch[1]}:${isoMatch[2]}`
  }

  const direct = text.match(/\b(\d{1,2}):(\d{2})\s*([AP]M)?\b/i)
  if (!direct) return null

  let hours = parseInt(direct[1], 10)
  const minutes = direct[2]
  const meridiem = direct[3]?.toUpperCase()

  if (meridiem === 'PM' && hours < 12) hours += 12
  if (meridiem === 'AM' && hours === 12) hours = 0

  if (hours < 0 || hours > 23) return null
  return `${String(hours).padStart(2, '0')}:${minutes}`
}

function normalizeDateText(value) {
  const text = cleanText(value)
  if (!text) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text

  const slashMatch = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (slashMatch) {
    const [, day, month, year] = slashMatch
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
  }

  const parsed = new Date(text)
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString('en-CA')
  }

  return null
}

function extractInteger(value) {
  const match = cleanText(value).match(/(\d{1,4})/)
  return match ? parseInt(match[1], 10) : null
}

function extractDistanceMetersFromText(value) {
  const text = cleanText(value).toLowerCase()
  const match = text.match(/(\d{3,4})\s?m\b/)
  return match ? parseInt(match[1], 10) : null
}

function extractRaceMeta($) {
  const candidateText = [
    $('.race-header').first().text(),
    $('.race-meta').first().text(),
    $('.meeting-meta').first().text(),
    $('.event-header').first().text(),
    $('.race-summary').first().text(),
    $('body').text(),
  ].map(cleanText).find(Boolean) || ''

  const distance = extractDistanceMetersFromText(candidateText)
  const gradeMatch = candidateText.match(/\b(grade\s*[a-z0-9+/ -]+|maiden|mixed\s*\d\/\d|class\s*\d+|benchmark\s*\d+)\b/i)

  return {
    distance,
    grade: cleanText(gradeMatch?.[1]) || null,
  }
}

function enrichRunnersWithRaceMeta(runners, meta, date, raceType) {
  return runners.map(runner => ({
    ...runner,
    distanceMeters: runner.distanceMeters ?? meta.distance ?? undefined,
    grade: runner.grade ?? meta.grade ?? undefined,
    raceDate: runner.raceDate ?? date,
    raceType: runner.raceType ?? raceType,
  }))
}

function slugifyTrack(track) {
  return cleanText(track)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function extractPlacingNumber(value) {
  const text = cleanText(value).toLowerCase()
  if (!text) return null
  if (/\b(1|1st|first)\b/.test(text)) return 1
  if (/\b(2|2nd|second)\b/.test(text)) return 2
  if (/\b(3|3rd|third)\b/.test(text)) return 3
  return null
}

function extractFinishers($) {
  const finishers = new Map()
  const rowSelectors = [
    '.result-runner',
    '.runner-result',
    '.result-row',
    '.finishing-order-row',
    '.race-result tr',
    '.results-table tr',
    'table.results tr',
    'table.race-results tr',
    '.placings tbody tr',
    '.finish-order li',
    '.result-list li',
    '[data-finish-position]',
    '[data-position]',
  ]

  for (const selector of rowSelectors) {
    $(selector).each((_, row) => {
      if (finishers.size >= 3) return

      const $row = $(row)
      const position = extractPlacingNumber(
        $row.attr('data-finish-position') ||
        $row.attr('data-position') ||
        $row.find('.finish-position, .position, .placing, .rank, .place, .finish, .result-position').first().text()
      )
      const name = cleanText(
        $row.find('.runner-name, .dog-name, .horse-name, .competitor-name, .name, .runner, a').first().text()
      )

      if (position && position <= 3 && name && !finishers.has(position)) {
        finishers.set(position, name)
      }
    })
  }

  const podiumSelectors = {
    1: '.winner .runner-name, .winner .dog-name, .winner .horse-name, .winner .name',
    2: '.second .runner-name, .second .dog-name, .second .horse-name, .second .name',
    3: '.third .runner-name, .third .dog-name, .third .horse-name, .third .name',
  }

  for (const [position, selector] of Object.entries(podiumSelectors)) {
    const name = cleanText($(selector).first().text())
    if (name && !finishers.has(Number(position))) {
      finishers.set(Number(position), name)
    }
  }

  return finishers
}

function hasUnfinishedMarker($) {
  const pageText = cleanText($('body').text()).toLowerCase()
  const markers = [
    'results pending',
    'result pending',
    'race has not run',
    'race has not started',
    'race not run',
    'has not jumped',
    'yet to run',
    'upcoming race',
    'jump time',
    'acceptances',
    'no results available',
    'results unavailable',
  ]

  return markers.some(marker => pageText.includes(marker))
}

function parseRaceResultHtml(html) {
  const $ = cheerio.load(html)
  const finishers = extractFinishers($)

  if (finishers.has(1)) {
    return {
      winner: finishers.get(1),
      second: finishers.get(2) || null,
      third: finishers.get(3) || null,
      finished: true,
    }
  }

  if (hasUnfinishedMarker($)) {
    return { finished: false }
  }

  return { finished: false }
}

function parseGreyhoundResultHtml(html) {
  return parseRaceResultHtml(html)
}

function parseHorseResultHtml(html) {
  return parseRaceResultHtml(html)
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

const FETCH_OPTS = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; RaceEdge/1.0)' }, signal: AbortSignal.timeout(FETCH_TIMEOUT) }

// State lookup for thedogs.com.au URL — extend as needed
const TRACK_STATE = {
  'sandown park': 'VIC', 'the meadows': 'VIC', 'shepparton': 'VIC', 'geelong': 'VIC', 'ballarat': 'VIC',
  'wentworth park': 'NSW', 'dapto': 'NSW', 'richmond': 'NSW',
  'albion park': 'QLD',
  'angle park': 'SA',
}

async function fetchHtmlDocument(url) {
  const res = await fetch(url, FETCH_OPTS)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.text()
}

async function fetchTheDogs(date, track, raceNumber) {
  const slug  = track.toLowerCase().replace(/\s+/g, '-')
  const state = TRACK_STATE[track.toLowerCase()] || 'VIC'
  const url = `https://www.thedogs.com.au/racing/form-guide/${state}/${slug}/${date}/${raceNumber}`
  try {
    const key = cacheKey('thedogs.com.au', date, track, raceNumber)
    const cached = getCached(key)
    if (cached) return cached
    const res = await fetchWithRetry(url, FETCH_OPTS)
    const html = await res.text()
    const meta = extractRaceMeta(cheerio.load(html))
    const runners = enrichRunnersWithRaceMeta(parseTheDogsHtml(html), meta, date, 'greyhound')
    const result = { source: 'thedogs.com.au', runners, error: null }
    setCache(key, result)
    return result
  } catch (err) {
    return { source: 'thedogs.com.au', runners: [], error: err.message }
  }
}

async function fetchGreyhoundResult(date, track, raceNumber) {
  const key = cacheKey('thedogs-result', date, track, raceNumber)
  const cached = getCached(key)
  if (cached) return cached

  const slug = slugifyTrack(track)
  const url = `https://www.thedogs.com.au/racing/${slug}/${date}/${raceNumber}`

  try {
    const html = await fetchHtmlDocument(url)
    if (html == null) return null
    const parsed = parseGreyhoundResultHtml(html)
    setCache(key, parsed)
    return parsed
  } catch {
    return null
  }
}

async function fetchRacingAndSports(date, track, raceNumber, raceType) {
  const seg = raceType === 'greyhound' ? 'greyhounds' : 'horse-racing'
  const slug = track.toLowerCase().replace(/\s+/g, '-')
  const url = `https://www.racingandsports.com.au/${seg}/form/${slug}/${date}/race-${raceNumber}`
  try {
    const key = cacheKey('racingandsports.com.au', date, track, raceNumber)
    const cached = getCached(key)
    if (cached) return cached
    const res = await fetchWithRetry(url, FETCH_OPTS)
    const html = await res.text()
    const meta = extractRaceMeta(cheerio.load(html))
    const runners = enrichRunnersWithRaceMeta(parseRacingAndSportsHtml(html), meta, date, raceType)
    const result = { source: 'racingandsports.com.au', runners, error: null }
    setCache(key, result)
    return result
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
    const key = cacheKey('grv.org.au', date, track, raceNumber)
    const cached = getCached(key)
    if (cached) return cached
    const res = await fetchWithRetry(url, FETCH_OPTS)
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
    const result = { source: 'grv.org.au', runners, error: null }
    setCache(key, result)
    return result
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
    const key = cacheKey('racingaustralia.horse', date, track, raceNumber)
    const cached = getCached(key)
    if (cached) return cached
    const res = await fetchWithRetry(url, FETCH_OPTS)
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
    const result = { source: 'racingaustralia.horse', runners, error: null }
    setCache(key, result)
    return result
  } catch (err) {
    return { source: 'racingaustralia.horse', runners: [], error: err.message }
  }
}

async function fetchGreyhoundRecorder(date, track, raceNumber) {
  const key = cacheKey('thegreyhoundrecorder.com.au', date, track, raceNumber)
  const cached = getCached(key)
  if (cached) return cached
  const slug = track.toLowerCase().replace(/\s+/g, '-')
  const url = `https://www.thegreyhoundrecorder.com.au/form-guide/${slug}/${date}/race-${raceNumber}`
  try {
    const res = await fetchWithRetry(url, FETCH_OPTS)
    const $ = cheerio.load(await res.text())
    const runners = []
    $('.runner-row, .runner, table.form-guide tr').each((_, row) => {
      const name = $(row).find('.dog-name, .runner-name, td:nth-child(2)').first().text().trim()
      if (!name || name.length < 2 || /runner|name|dog/i.test(name)) return
      runners.push({
        name,
        box:        parseInt($(row).find('.box, td:first-child').first().text(), 10) || undefined,
        lastStarts: $(row).find('.last-starts, .form').first().text().trim() || undefined,
        bestTime:   parseFloat($(row).find('.best-time, .time').first().text()) || undefined,
      })
    })
    const result = { source: 'thegreyhoundrecorder.com.au', runners, error: null }
    setCache(key, result)
    return result
  } catch (err) {
    return { source: 'thegreyhoundrecorder.com.au', runners: [], error: err.message }
  }
}

async function fetchGBOTA(date, track, raceNumber) {
  const key = cacheKey('gbota.com.au', date, track, raceNumber)
  const cached = getCached(key)
  if (cached) return cached
  const slug = track.toLowerCase().replace(/\s+/g, '-')
  const url = `https://www.gbota.com.au/racing/form/${slug}/${date}/${raceNumber}`
  try {
    const res = await fetchWithRetry(url, FETCH_OPTS)
    const $ = cheerio.load(await res.text())
    const runners = []
    $('.runner-row, .runner, table tr').each((_, row) => {
      const name = $(row).find('.dog-name, .runner-name, td:nth-child(2)').first().text().trim()
      if (!name || name.length < 2 || /runner|name|dog/i.test(name)) return
      runners.push({
        name,
        box:        parseInt($(row).find('.box, td:first-child').first().text(), 10) || undefined,
        lastStarts: $(row).find('.last-starts, .form').first().text().trim() || undefined,
      })
    })
    const result = { source: 'gbota.com.au', runners, error: null }
    setCache(key, result)
    return result
  } catch (err) {
    return { source: 'gbota.com.au', runners: [], error: err.message }
  }
}

// ── Meeting list ──────────────────────────────────────────────────────────────

const FALLBACK_DOGS   = ['Sandown Park','The Meadows','Shepparton','Geelong','Ballarat','Wentworth Park','Dapto','Richmond','Albion Park','Angle Park']
const FALLBACK_HORSES = ['Flemington','Caulfield','Moonee Valley','Randwick','Rosehill','Doomben','Eagle Farm','Morphettville','Ascot','Ellerslie']

function parseMeetingsForDateHtml(html, date) {
  const $ = cheerio.load(html)
  const seen = new Set()
  const meetings = []

  $('.meeting-card, .racecard-meeting, .meeting-row, .racecard-row, [data-track], [data-meeting]').each((_, element) => {
    const $element = $(element)
    const meetingDate = normalizeDateText(
      $element.attr('data-date') ||
      $element.find('[data-date], .meeting-date, .date, time').first().attr('data-date') ||
      $element.find('[data-date], .meeting-date, .date, time').first().attr('datetime') ||
      $element.find('[data-date], .meeting-date, .date, time').first().text()
    )

    if (meetingDate && meetingDate !== date) return

    const track = cleanText(
      $element.attr('data-track') ||
      $element.attr('data-meeting') ||
      $element.find('.track-name, .meeting-name, .venue-name, h2, h3, h4, .name').first().text()
    )
    if (!track) return

    const raceCount = extractInteger(
      $element.attr('data-race-count') ||
      $element.find('.race-count, .races-count, .race-total, .meta-races').first().text()
    ) || $element.find('[href*="race-"], [href*="/race/"]').length || 12

    const firstRaceTime = normalizeTimeText(
      $element.attr('data-first-race-time') ||
      $element.find('.first-race-time, .meeting-time, .time, time').first().attr('datetime') ||
      $element.find('.first-race-time, .meeting-time, .time, time').first().text()
    )

    const href = $element.find('a[href]').first().attr('href') || ''
    const slugFromHref = href
      .split('/')
      .filter(Boolean)
      .reverse()
      .find(segment => !/^\d+$/.test(segment))
    const slug = cleanText(
      $element.attr('data-slug') ||
      slugFromHref ||
      slugifyTrack(track)
    )

    const key = `${track.toLowerCase()}|${raceCount}|${firstRaceTime || ''}`
    if (seen.has(key)) return
    seen.add(key)

    meetings.push({
      track,
      slug: slug || slugifyTrack(track),
      raceCount,
      firstRaceTime: firstRaceTime || null,
    })
  })

  return meetings
}

async function fetchMeetingsForDate(date, raceType, db) {
  const url = raceType === 'greyhound'
    ? 'https://www.thedogs.com.au/racing/racecards'
    : `https://www.racingandsports.com.au/${raceType === 'greyhound' ? 'greyhounds' : 'horse-racing'}/form/${date}`
  const sourceName = raceType === 'greyhound' ? 'thedogs' : 'racingandsports'
  const startedAt = Date.now()

  try {
    const key = `meetings-for-date|${date}|${raceType}`
    const cached = getCached(key)
    if (cached) return cached

    const res = await fetchWithRetry(url, FETCH_OPTS)
    const html = await res.text()
    const meetings = parseMeetingsForDateHtml(html, date)

    saveScraperHealth(db, {
      source_name: sourceName,
      race_date: date,
      track: 'ALL',
      race_number: 0,
      status: meetings.length > 0 ? 'success' : 'empty',
      response_time_ms: Math.max(0, Date.now() - startedAt),
      records_returned: meetings.length,
      error_message: null,
    })

    if (meetings.length > 0) {
      setCache(key, meetings)
      return meetings
    }

    return []
  } catch (err) {
    saveScraperHealth(db, {
      source_name: sourceName,
      race_date: date,
      track: 'ALL',
      race_number: 0,
      status: /timeout|timed out|abort/i.test(err.message) ? 'timeout' : 'error',
      response_time_ms: Math.max(0, Date.now() - startedAt),
      records_returned: 0,
      error_message: err.message,
    })
    return []
  }
}

async function fetchMeetings(date, raceType, db) {
  const meetings = await fetchMeetingsForDate(date, raceType, db)
  if (meetings.length > 0) {
    return meetings.map(meeting => meeting.track)
  }

  return raceType === 'greyhound' ? FALLBACK_DOGS : FALLBACK_HORSES
}

async function fetchAllRacesForMeeting(date, track, raceCount, raceType, db, onProgress) {
  const totalRaces = Math.max(0, Number(raceCount) || 0)
  const races = []

  for (let raceNumber = 1; raceNumber <= totalRaces; raceNumber += 1) {
    try {
      const scrape = await research(date, track, raceNumber, raceType, db)
      const distance = scrape.runners
        .map(runner => runner.distanceMeters)
        .find(value => Number.isFinite(value)) ?? null
      const grade = scrape.runners
        .map(runner => cleanText(runner.grade))
        .find(Boolean) || null

      onProgress?.({
        type: 'race_done',
        track,
        raceNumber,
        runnersFound: scrape.runners.length,
      })

      if (scrape.runners.length > 0) {
        races.push({
          track,
          raceNumber,
          runners: scrape.runners,
          distance,
          grade,
          sourcesUsed: scrape.sourcesUsed,
          sourcesSkipped: scrape.sourcesSkipped,
        })
      }
    } catch (err) {
      onProgress?.({
        type: 'race_done',
        track,
        raceNumber,
        runnersFound: 0,
        error: err.message,
      })
    }

    if (raceNumber < totalRaces) {
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  return races
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
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    })
    return _browser
  } catch (err) {
    console.error('[Puppeteer] Failed to launch:', err.message)
    _puppeteerAvailable = false
    return null
  }
}

async function puppeteerGetHtml(url, waitSelector, timeout = PUPPETEER_NAV_TIMEOUT) {
  const browser = await getBrowser()
  if (!browser) throw new Error('Puppeteer unavailable')
  const page = await browser.newPage()
  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36')
    await page.goto(url, { waitUntil: 'networkidle2', timeout })
    if (waitSelector) await page.waitForSelector(waitSelector, { timeout: PUPPETEER_WAIT_TIMEOUT }).catch(() => {})
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
    const key = cacheKey('tab.com.au', date, track, raceNumber)
    const cached = getCached(key)
    if (cached) return cached
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
    const result = { source: 'tab.com.au', runners, error: null }
    setCache(key, result)
    return result
  } catch (err) {
    return { source: 'tab.com.au', runners: [], error: err.message }
  }
}

async function fetchRacenet(date, track, raceNumber) {
  const slug = track.toLowerCase().replace(/\s+/g, '-')
  const url = `https://www.racenet.com.au/horse-racing/${slug}/${date}/race-${raceNumber}`
  try {
    const key = cacheKey('racenet.com.au', date, track, raceNumber)
    const cached = getCached(key)
    if (cached) return cached
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
    const result = { source: 'racenet.com.au', runners, error: null }
    setCache(key, result)
    return result
  } catch (err) {
    return { source: 'racenet.com.au', runners: [], error: err.message }
  }
}

async function fetchPunters(date, track, raceNumber) {
  const slug = track.toLowerCase().replace(/\s+/g, '-')
  const url = `https://www.punters.com.au/horse-racing/${slug}/${date}/?race=${raceNumber}`
  try {
    const key = cacheKey('punters.com.au', date, track, raceNumber)
    const cached = getCached(key)
    if (cached) return cached
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
    const result = { source: 'punters.com.au', runners, error: null }
    setCache(key, result)
    return result
  } catch (err) {
    return { source: 'punters.com.au', runners: [], error: err.message }
  }
}

async function fetchHorseResult(date, track, raceNumber) {
  const key = cacheKey('racingandsports-result', date, track, raceNumber)
  const cached = getCached(key)
  if (cached) return cached

  const slug = slugifyTrack(track)
  const urls = [
    `https://www.racingandsports.com.au/horse-racing-results/${slug}/${date}/race-${raceNumber}`,
    `https://www.racingandsports.com.au/results/horse-racing/${slug}/${date}/race-${raceNumber}`,
    `https://www.racingandsports.com.au/horse-racing/results/${slug}/${date}/race-${raceNumber}`,
  ]

  let staticFallback = null

  for (const url of urls) {
    try {
      const html = await fetchHtmlDocument(url)
      if (html == null) continue

      const parsed = parseHorseResultHtml(html)
      if (parsed.finished) {
        setCache(key, parsed)
        return parsed
      }

      staticFallback = parsed
    } catch {
      continue
    }
  }

  for (const url of urls) {
    try {
      const html = await puppeteerGetHtml(url, '.result-runner, .runner-result, .results-table, table.results')
      const parsed = parseHorseResultHtml(html)
      setCache(key, parsed)
      return parsed
    } catch {
      continue
    }
  }

  if (staticFallback) {
    setCache(key, staticFallback)
    return staticFallback
  }

  return null
}

// ── Main research entry point ─────────────────────────────────────────────────

function getScraperStatus(errorMessage, recordsReturned) {
  if (errorMessage) {
    return /timeout|timed out|abort/i.test(errorMessage) ? 'timeout' : 'error'
  }
  return recordsReturned > 0 ? 'success' : 'empty'
}

function saveScraperHealth(db, entry) {
  if (!db) return
  try {
    logScraperHealth(db, entry)
  } catch (err) {
    console.error('[ScraperHealth] Failed to save health record:', err.message)
  }
}

async function runSourceAttempt(db, sourceConfig, date, track, raceNumber) {
  const startedAt = Date.now()

  try {
    const result = await sourceConfig.fetch(date, track, raceNumber)
    const recordsReturned = Array.isArray(result?.runners) ? result.runners.length : 0
    const errorMessage = result?.error || null

    saveScraperHealth(db, {
      source_name: sourceConfig.name,
      race_date: date,
      track,
      race_number: raceNumber,
      status: getScraperStatus(errorMessage, recordsReturned),
      response_time_ms: Math.max(0, Date.now() - startedAt),
      records_returned: recordsReturned,
      error_message: errorMessage,
    })

    return result?.source
      ? result
      : { source: sourceConfig.label, runners: result?.runners || [], error: errorMessage }
  } catch (err) {
    const errorMessage = err?.message || 'Unknown error'

    saveScraperHealth(db, {
      source_name: sourceConfig.name,
      race_date: date,
      track,
      race_number: raceNumber,
      status: getScraperStatus(errorMessage, 0),
      response_time_ms: Math.max(0, Date.now() - startedAt),
      records_returned: 0,
      error_message: errorMessage,
    })

    return { source: sourceConfig.label, runners: [], error: errorMessage }
  }
}

async function research(date, track, raceNumber, raceType, db) {
  const fetchers = raceType === 'greyhound'
    ? [
        { name: 'thedogs', label: 'thedogs.com.au', fetch: fetchTheDogs },
        { name: 'racingandsports', label: 'racingandsports.com.au', fetch: (d, t, r) => fetchRacingAndSports(d, t, r, 'greyhound') },
        { name: 'grv', label: 'grv.org.au', fetch: fetchGRV },
        { name: 'tab', label: 'tab.com.au', fetch: (d, t, r) => fetchTAB(d, t, r, 'greyhound') },
        { name: 'greyhoundrecorder', label: 'thegreyhoundrecorder.com.au', fetch: fetchGreyhoundRecorder },
        { name: 'gbota', label: 'gbota.com.au', fetch: fetchGBOTA },
      ]
    : [
        { name: 'racingaustralia', label: 'racingaustralia.horse', fetch: fetchRacingAustralia },
        { name: 'racingandsports', label: 'racingandsports.com.au', fetch: (d, t, r) => fetchRacingAndSports(d, t, r, 'horse') },
        { name: 'tab', label: 'tab.com.au', fetch: (d, t, r) => fetchTAB(d, t, r, 'horse') },
        { name: 'racenet', label: 'racenet.com.au', fetch: fetchRacenet },
        { name: 'punters', label: 'punters.com.au', fetch: fetchPunters },
      ]

  const scraperResults = await Promise.all(
    fetchers.map(sourceConfig => runSourceAttempt(db, sourceConfig, date, track, raceNumber))
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

module.exports = {
  research,
  fetchMeetings,
  fetchMeetingsForDate,
  fetchAllRacesForMeeting,
  closeBrowser,
  parseTheDogsHtml,
  parseRacingAndSportsHtml,
  parseMeetingsForDateHtml,
  parseGreyhoundResultHtml,
  parseHorseResultHtml,
  fetchGreyhoundResult,
  fetchHorseResult,
  mergeSources,
}
