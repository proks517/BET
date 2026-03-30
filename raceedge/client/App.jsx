import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'
import ReactDOM from 'react-dom/client'

const SOURCES = {
  greyhound: ['thedogs.com.au', 'racingandsports.com.au', 'grv.org.au', 'tab.com.au', 'thegreyhoundrecorder.com.au', 'gbota.com.au'],
  horse:     ['racingaustralia.horse', 'racingandsports.com.au', 'tab.com.au', 'racenet.com.au', 'punters.com.au'],
}

const SCORE_FACTORS = [
  { key: 'recentForm', label: 'Recent Form', weight: '30%' },
  { key: 'bestTime', label: 'Best Time', weight: '25%' },
  { key: 'boxDraw', label: 'Box/Barrier Draw', weight: '15%' },
  { key: 'classConsistency', label: 'Class Consistency', weight: '15%' },
  { key: 'trainerStrikeRate', label: 'Trainer Strike Rate', weight: '10%' },
  { key: 'daysSinceLastRun', label: 'Days Since Last Run', weight: '5%' },
]

const HEALTH_SOURCE_LABELS = {
  thedogs: 'TheDogs',
  racingandsports: 'Racing & Sports',
  grv: 'GRV',
  tab: 'TAB',
  greyhoundrecorder: 'Greyhound Recorder',
  gbota: 'GBOTA',
  racingaustralia: 'Racing Australia',
  racenet: 'Racenet',
  punters: 'Punters',
}

const SCRAPER_HEALTH_SOURCES = Object.keys(HEALTH_SOURCE_LABELS)
const DASHBOARD_TABS = [
  { key: 'bestBets', label: 'BEST BETS', icon: '🎯' },
  { key: 'overview', label: 'Overview', icon: '◫' },
  { key: 'predictions', label: 'Predictions', icon: '⟲' },
  { key: 'journal', label: 'Journal', icon: '✎' },
  { key: 'boxBias', label: 'Box Bias', icon: '◎' },
  { key: 'sourceHealth', label: 'Source Health', icon: '◉' },
]
const MODE_CARDS = [
  { key: 'safest', label: 'SAFEST', icon: '🛡', accent: 'blue' },
  { key: 'value', label: 'VALUE', icon: '🎯', accent: 'gold' },
  { key: 'longshot', label: 'LONGSHOT', icon: '⚡', accent: 'red' },
]
const RACE_NUMBERS = Array.from({ length: 12 }, (_, index) => index + 1)
const DEFAULT_ADVANCED_STATS = {
  byTrack: [],
  byGrade: [],
  byBox: { overall: [], byTrack: [] },
  byMonth: [],
  calibration: [],
  streaks: { current: 0, longest: 0, currentLoss: 0, longestLoss: 0 },
  profitCurve: [],
}

function todayStr() {
  return new Date().toLocaleDateString('en-CA') // YYYY-MM-DD in local time
}

function truncateText(text, maxLength = 60) {
  if (!text) return 'No recent errors'
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}...` : text
}

function formatCheckedAt(value) {
  if (!value) return 'Never'
  return new Date(`${value.replace(' ', 'T')}Z`).toLocaleString()
}

function formatClock(value) {
  return value.toLocaleString('en-AU', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatTimestamp(value) {
  if (!value) return '—'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return '—'
  return parsed.toLocaleString('en-AU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getHealthTone(row) {
  if (!row.total_attempts) return 'unknown'
  if (row.success_rate_pct > 70) return 'good'
  if (row.success_rate_pct >= 40) return 'warn'
  return 'bad'
}

function getFactorTone(score) {
  if (score >= 70) return 'good'
  if (score >= 40) return 'warn'
  return 'bad'
}

function getBoxBiasTone(winRate) {
  if (winRate > 30) return 'good'
  if (winRate >= 15) return 'warn'
  return 'bad'
}

function getResultTone(result) {
  const status = formatPredictionResult(result)
  if (status === 'win') return 'good'
  if (status === 'loss') return 'bad'
  if (status === 'scratched') return 'muted'
  return 'warn'
}

function formatModeLabel(mode) {
  return mode ? mode.charAt(0).toUpperCase() + mode.slice(1) : '—'
}

function formatPredictionResult(result) {
  return result || 'pending'
}

function formatSignedCurrency(value) {
  const amount = Number(value) || 0
  return `${amount >= 0 ? '+' : '-'}$${Math.abs(amount).toFixed(2)}`
}

function formatProbability(probability) {
  const numeric = Number(probability)
  if (!Number.isFinite(numeric)) return '—'
  return `${Math.round(numeric * 100)}%`
}

function formatOdds(odds) {
  const numeric = Number(odds)
  if (!Number.isFinite(numeric)) return 'NO ODDS'
  return `$${numeric.toFixed(2)}`
}

function formatEdge(ev) {
  const numeric = Number(ev)
  if (!Number.isFinite(numeric)) return 'NO ODDS'
  const edgePct = Math.round(numeric * 100)
  return `${edgePct >= 0 ? '+' : ''}${edgePct}% EDGE`
}

function getEdgeTone(ev) {
  const numeric = Number(ev)
  if (!Number.isFinite(numeric)) return 'neutral'
  if (numeric > 0) return 'good'
  if (numeric >= -0.1) return 'warn'
  return 'bad'
}

function buildManualOddsRows(runners = []) {
  return runners.map(runner => ({
    box: runner.box ?? runner.barrier ?? null,
    runnerName: runner.name,
    decimalOdds: runner.decimalOdds != null ? String(runner.decimalOdds) : '',
    winProbability: runner.winProbability ?? null,
  }))
}

function calculateManualEV(winProbability, decimalOdds) {
  const probability = Number(winProbability)
  const odds = Number(decimalOdds)
  if (!Number.isFinite(probability) || !Number.isFinite(odds)) return null
  return (probability * odds) - 1
}

function getHeroWinRateTone(winRate) {
  if (winRate > 35) return 'good'
  if (winRate >= 20) return 'warn'
  return 'bad'
}

function getAnalyticsWinRateTone(winRate) {
  if (winRate > 40) return 'good'
  if (winRate >= 20) return 'warn'
  return 'bad'
}

function formatMonthLabel(monthKey) {
  if (!monthKey || !monthKey.includes('-')) return monthKey || '—'
  const [year, month] = monthKey.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, (month || 1) - 1, 1))
  return parsed.toLocaleString('en-AU', { month: 'short', year: 'numeric', timeZone: 'UTC' })
}

function getStreakDisplay(streaks) {
  if (streaks?.current > 0) {
    return { label: `W${streaks.current}`, tone: 'good' }
  }

  if (streaks?.currentLoss > 0) {
    return { label: `L${streaks.currentLoss}`, tone: 'bad' }
  }

  return { label: '—', tone: 'neutral' }
}

function getCalibrationTone(actualWinRate, predictedPct, total) {
  if (!total) return 'neutral'
  return actualWinRate >= predictedPct ? 'good' : 'bad'
}

function mergeScraperHealthRows(rows = []) {
  const bySource = new Map(rows.map(row => [row.source_name, row]))
  const knownRows = SCRAPER_HEALTH_SOURCES.map(source_name => ({
    source_name,
    display_name: HEALTH_SOURCE_LABELS[source_name] || source_name,
    total_attempts: 0,
    success_count: 0,
    success_rate_pct: null,
    average_response_time_ms: null,
    last_seen_error: null,
    last_checked: null,
    ...(bySource.get(source_name) || {}),
  }))
  const extraRows = rows
    .filter(row => !bySource.has(row.source_name) || !SCRAPER_HEALTH_SOURCES.includes(row.source_name))
    .map(row => ({
      ...row,
      display_name: row.source_name,
    }))
  return [...knownRows, ...extraRows]
}

function getBoxBadgeClass(box) {
  const value = Number(box)
  if (!Number.isFinite(value) || value < 1 || value > 8) return 'box-badge-neutral'
  return `box-badge-${value}`
}

function computeCurrentStreak(predictions = []) {
  const settled = predictions.filter(prediction => ['win', 'loss'].includes(formatPredictionResult(prediction.result)))
  if (settled.length === 0) return { label: '—', tone: 'neutral' }

  const ordered = [...settled].sort((left, right) => right.id - left.id)
  const streakResult = formatPredictionResult(ordered[0].result)
  let count = 0

  for (const prediction of ordered) {
    if (formatPredictionResult(prediction.result) !== streakResult) break
    count += 1
  }

  return {
    label: `${streakResult === 'win' ? 'W' : 'L'}${count}`,
    tone: streakResult === 'win' ? 'good' : 'bad',
  }
}

function sortPredictions(rows, sort) {
  const direction = sort.direction === 'asc' ? 1 : -1

  return [...rows].sort((left, right) => {
    const leftValue = left[sort.key]
    const rightValue = right[sort.key]

    if (leftValue == null && rightValue == null) return 0
    if (leftValue == null) return 1
    if (rightValue == null) return -1

    if (typeof leftValue === 'number' && typeof rightValue === 'number') {
      return (leftValue - rightValue) * direction
    }

    return String(leftValue).localeCompare(String(rightValue)) * direction
  })
}

function App() {
  // Controls
  const [date,       setDate]       = useState(todayStr())
  const [raceType,   setRaceType]   = useState('greyhound')
  const [meetings,   setMeetings]   = useState([])
  const [meeting,    setMeeting]    = useState('')
  const [raceNum,    setRaceNum]    = useState(1)
  const [distance,   setDistance]   = useState(400)
  const [mode,       setMode]       = useState('safest')
  const [stake,      setStake]      = useState(() => parseFloat(localStorage.getItem('raceedge-stake')) || 10)

  // UI
  const [loading,    setLoading]    = useState(false)
  const [loadMsg,    setLoadMsg]    = useState('')
  const [activeSourceIdx, setActiveSourceIdx] = useState(-1)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState('')
  const [notice,     setNotice]     = useState(null)
  const [now,        setNow]        = useState(() => new Date())
  const [serverConnected, setServerConnected] = useState(false)
  const [aiAnalysisPending, setAiAnalysisPending] = useState(false)
  const [tracksideMode, setTracksideMode] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth < 480 : false
  ))

  // Record result
  const [odds,       setOdds]       = useState('')
  const [recording,  setRecording]  = useState(false)
  const [recorded,   setRecorded]   = useState(false)

  // Stats
  const [stats,      setStats]      = useState(null)
  const [advancedStats, setAdvancedStats] = useState(DEFAULT_ADVANCED_STATS)
  const [predictions, setPredictions] = useState([])
  const [predictionSort, setPredictionSort] = useState({ key: 'date', direction: 'desc' })
  const [scraperHealth, setScraperHealth] = useState(() => mergeScraperHealthRows())
  const [healthLoading, setHealthLoading] = useState(false)
  const [pendingPredictions, setPendingPredictions] = useState([])
  const [checkingResults, setCheckingResults] = useState(false)
  const [dashboardTab, setDashboardTab] = useState('bestBets')
  const [bestBetsDate, setBestBetsDate] = useState(todayStr())
  const [bestBetsType, setBestBetsType] = useState('greyhound')
  const [bestBetsMode, setBestBetsMode] = useState('value')
  const [bestBetsLoading, setBestBetsLoading] = useState(false)
  const [bestBetsResult, setBestBetsResult] = useState(null)
  const [bestBetsLog, setBestBetsLog] = useState([])
  const [bestBetsProgress, setBestBetsProgress] = useState({ totalMeetings: 0, meetingsCompleted: 0, racesChecked: 0, currentTrack: '' })
  const [quickBetTarget, setQuickBetTarget] = useState(null)
  const [boxBiasTrack, setBoxBiasTrack] = useState('')
  const [boxBiasDistance, setBoxBiasDistance] = useState(400)
  const [boxBiasData, setBoxBiasData] = useState({ source: 'default', message: 'Select a track and distance', boxes: [] })
  const [boxBiasLoading, setBoxBiasLoading] = useState(false)
  const [journalEntries, setJournalEntries] = useState([])
  const [journalLoading, setJournalLoading] = useState(false)
  const [expandedJournalId, setExpandedJournalId] = useState(null)
  const [manualOddsOpen, setManualOddsOpen] = useState(false)
  const [manualOddsRows, setManualOddsRows] = useState([])
  const [applyingOdds, setApplyingOdds] = useState(false)
  const bestBetsStreamRef = useRef(null)

  const loadStats = useCallback(() => {
    fetch('/api/stats').then(r => r.json()).then(setStats).catch(() => {})
  }, [])

  const loadAdvancedStats = useCallback(() => {
    fetch('/api/stats/advanced')
      .then(r => r.json())
      .then(data => setAdvancedStats({
        ...DEFAULT_ADVANCED_STATS,
        ...data,
        byBox: {
          ...DEFAULT_ADVANCED_STATS.byBox,
          ...(data?.byBox || {}),
        },
        streaks: {
          ...DEFAULT_ADVANCED_STATS.streaks,
          ...(data?.streaks || {}),
        },
      }))
      .catch(() => {})
  }, [])

  const loadPredictions = useCallback(() => {
    fetch('/api/predictions')
      .then(r => r.json())
      .then(data => setPredictions(data.predictions || []))
      .catch(() => {})
  }, [])

  const loadScraperHealth = useCallback(() => {
    setHealthLoading(true)
    fetch('/api/scraper-health')
      .then(r => r.json())
      .then(data => setScraperHealth(mergeScraperHealthRows(data.sources || [])))
      .catch(() => {})
      .finally(() => setHealthLoading(false))
  }, [])

  const loadPending = useCallback(() => {
    fetch('/api/pending')
      .then(r => r.json())
      .then(data => setPendingPredictions(data.predictions || []))
      .catch(() => {})
  }, [])

  const loadBoxBias = useCallback((track = boxBiasTrack, meters = boxBiasDistance) => {
    if (!track || !meters) return
    setBoxBiasLoading(true)
    fetch(`/api/box-bias?track=${encodeURIComponent(track)}&distance=${encodeURIComponent(meters)}`)
      .then(r => r.json())
      .then(data => setBoxBiasData(data))
      .catch(() => {})
      .finally(() => setBoxBiasLoading(false))
  }, [boxBiasTrack, boxBiasDistance])

  const loadJournal = useCallback((limit = 20) => {
    setJournalLoading(true)
    fetch(`/api/journal?limit=${limit}`)
      .then(r => r.json())
      .then(data => setJournalEntries(data.entries || []))
      .catch(() => {})
      .finally(() => setJournalLoading(false))
  }, [])

  const closeBestBetsStream = useCallback(() => {
    if (bestBetsStreamRef.current) {
      bestBetsStreamRef.current.close()
      bestBetsStreamRef.current = null
    }
  }, [])

  const appendBestBetsLog = useCallback(message => {
    setBestBetsLog(current => [...current.slice(-29), message])
  }, [])

  useEffect(() => {
    loadStats()
    loadAdvancedStats()
    loadPredictions()
    loadScraperHealth()
    loadPending()
    loadJournal()
  }, [loadStats, loadAdvancedStats, loadPredictions, loadScraperHealth, loadPending, loadJournal])

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(''), 8000)
    return () => clearTimeout(timer)
  }, [error])

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    document.title = result
      ? `${result.runner} — RaceEdge`
      : 'RaceEdge — Racing Research & Predictions'
  }, [result])

  useEffect(() => {
    const intervalId = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(intervalId)
  }, [])

  useEffect(() => {
    async function pingServer() {
      try {
        const response = await fetch('/api/health')
        setServerConnected(response.ok)
      } catch {
        setServerConnected(false)
      }
    }

    pingServer()
    const intervalId = setInterval(pingServer, 15000)
    return () => clearInterval(intervalId)
  }, [])

  useEffect(() => {
    function handleResize() {
      if (window.innerWidth < 480) {
        setTracksideMode(true)
      }
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    if (!date) return
    setMeeting('')
    fetch(`/api/meetings?date=${date}&type=${raceType}`)
      .then(r => r.json())
      .then(d => {
        setMeetings(d.meetings || [])
        if (d.meetings?.length) {
          setMeeting(d.meetings[0])
          setBoxBiasTrack(current => current || d.meetings[0])
        }
      })
      .catch(() => {})
  }, [date, raceType])

  useEffect(() => {
    if (!boxBiasTrack || !boxBiasDistance) return
    loadBoxBias(boxBiasTrack, boxBiasDistance)
  }, [boxBiasTrack, boxBiasDistance, loadBoxBias])

  useEffect(() => {
    if (!result?.allRunners?.length) {
      setManualOddsRows([])
      setManualOddsOpen(false)
      return
    }

    setManualOddsRows(buildManualOddsRows(result.allRunners))
    setOdds(result.odds != null ? String(result.odds) : '')
    setManualOddsOpen(!result.oddsAvailable)
  }, [result])

  useEffect(() => () => {
    closeBestBetsStream()
  }, [closeBestBetsStream])

  useEffect(() => {
    if (!quickBetTarget) return
    if (quickBetTarget.date !== date || quickBetTarget.raceType !== raceType) return
    if (meetings.length === 0) return

    setMeeting(quickBetTarget.track)
    setRaceNum(quickBetTarget.raceNumber)
    setDistance(quickBetTarget.distance || 0)
    setMode(quickBetTarget.mode)
    setBoxBiasTrack(quickBetTarget.track)
    if (quickBetTarget.distance) {
      setBoxBiasDistance(quickBetTarget.distance)
    }
    setQuickBetTarget(null)
  }, [quickBetTarget, meetings, date, raceType])

  async function handleResearch() {
    if (!meeting) return
    setLoading(true)
    setError('')
    setResult(null)
    setRecorded(false)
    setOdds('')
    setAiAnalysisPending(true)

    const srcs = SOURCES[raceType]
    const animPromise = (async () => {
      for (let i = 0; i < srcs.length; i++) {
        setActiveSourceIdx(i)
        setLoadMsg(`Checking ${srcs[i]}... (${i + 1}/${srcs.length})`)
        await new Promise(r => setTimeout(r, 600))
      }
      setLoadMsg('Analysing runners...')
      setActiveSourceIdx(srcs.length)
      setLoadMsg('Consulting AI analyst...')
    })()

    try {
      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, meeting, raceNumber: raceNum, raceType, mode, stake, distance }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Research failed')
      await animPromise
      setResult(data)
    } catch (e) {
      await animPromise
      setError(e.message)
    } finally {
      setLoading(false)
      setLoadMsg('')
      setActiveSourceIdx(-1)
      setAiAnalysisPending(false)
      loadStats()
      loadAdvancedStats()
      loadPredictions()
      loadScraperHealth()
      loadPending()
      loadJournal()
      setBoxBiasTrack(meeting)
      setBoxBiasDistance(distance)
    }
  }

  async function handleRecord(outcome) {
    if (!result?.predictionId) return
    setRecording(true)
    try {
      const res = await fetch(`/api/predictions/${result.predictionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: outcome, odds: odds ? parseFloat(odds) : (result.odds ?? null) }),
      })
      if (!res.ok) throw new Error('Failed to record result')
      setRecorded(true)
      loadStats()
      loadAdvancedStats()
      loadPredictions()
      loadPending()
    } catch (e) {
      setError(e.message)
    } finally {
      setRecording(false)
    }
  }

  function handleManualOddsChange(index, value) {
    setManualOddsRows(current => current.map((row, rowIndex) => (
      rowIndex === index
        ? { ...row, decimalOdds: value }
        : row
    )))
  }

  async function handleApplyOdds() {
    if (!result?.predictionId) return

    const parsedOdds = manualOddsRows
      .map(row => ({
        box: row.box,
        runnerName: row.runnerName,
        decimalOdds: parseFloat(row.decimalOdds),
      }))
      .filter(row => Number.isFinite(row.decimalOdds) && row.decimalOdds >= 1.01)

    if (parsedOdds.length === 0) {
      setError('Enter at least one valid decimal price before applying odds.')
      return
    }

    setApplyingOdds(true)
    try {
      const response = await fetch('/api/apply-odds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          predictionId: result.predictionId,
          odds: parsedOdds,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || 'Failed to apply manual odds')

      setResult(current => ({
        ...current,
        ...data,
        aiAnalysis: current?.aiAnalysis ?? null,
        sourcesUsed: current?.sourcesUsed || [],
        sourcesSkipped: current?.sourcesSkipped || [],
        warning: current?.warning || null,
      }))
      setNotice({
        kind: 'success',
        message: `Odds applied. ${data.picks?.length || 0} pick${data.picks?.length === 1 ? '' : 's'} recalculated with EV.`,
      })
      loadPredictions()
      loadJournal()
    } catch (e) {
      setError(e.message)
    } finally {
      setApplyingOdds(false)
    }
  }

  async function handleCheckResults() {
    setCheckingResults(true)
    try {
      const res = await fetch('/api/check-results', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to check results')

      const errorSuffix = data.errors?.length ? `, ${data.errors.length} error${data.errors.length === 1 ? '' : 's'}` : ''
      setNotice({
        kind: 'success',
        message: `${data.checked} results checked, ${data.resolved} resolved automatically${errorSuffix}.`,
      })

      loadStats()
      loadAdvancedStats()
      loadPredictions()
      loadPending()
    } catch (e) {
      setError(e.message)
    } finally {
      setCheckingResults(false)
    }
  }

  function handleQuickBet(pick) {
    const selectedDate = bestBetsResult?.date || bestBetsDate
    const selectedType = bestBetsResult?.type || bestBetsType

    setQuickBetTarget({
      date: selectedDate,
      raceType: selectedType,
      track: pick.track,
      raceNumber: pick.raceNumber,
      distance: pick.distance || 0,
      mode: pick.mode || bestBetsMode,
    })
    setDate(selectedDate)
    setRaceType(selectedType)
    setRaceNum(pick.raceNumber)
    setDistance(pick.distance || 0)
    setMode(pick.mode || bestBetsMode)
    setBoxBiasTrack(pick.track)
    if (pick.distance) {
      setBoxBiasDistance(pick.distance)
    }
    setDashboardTab('overview')
    window.scrollTo({ top: 0, behavior: 'smooth' })
    setNotice({
      kind: 'success',
      message: `Prefilled ${pick.track} R${pick.raceNumber} for a full research deep-dive.`,
    })
  }

  function handleBestBetsScan() {
    if (bestBetsLoading) return

    closeBestBetsStream()
    setBestBetsLoading(true)
    setBestBetsResult(null)
    setBestBetsLog([])
    setBestBetsProgress({ totalMeetings: 0, meetingsCompleted: 0, racesChecked: 0, currentTrack: '' })

    const params = new URLSearchParams({
      date: bestBetsDate,
      type: bestBetsType,
      mode: bestBetsMode,
    })

    appendBestBetsLog(`⏳ Starting day scan for ${bestBetsDate} (${bestBetsType}, all modes)...`)

    const stream = new EventSource(`/api/best-bets/stream?${params.toString()}`)
    let completed = false
    bestBetsStreamRef.current = stream

    stream.onmessage = event => {
      let payload

      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }

      if (payload.type === 'scan_start') {
        setBestBetsProgress(current => ({
          ...current,
          totalMeetings: payload.totalMeetings || 0,
        }))
        appendBestBetsLog(`⏳ Scanning ${payload.totalMeetings || 0} meetings. This cannot be cancelled once started.`)
        return
      }

      if (payload.type === 'meeting_start') {
        setBestBetsProgress(current => ({
          ...current,
          currentTrack: payload.track || current.currentTrack,
          totalMeetings: payload.totalMeetings ?? current.totalMeetings,
        }))
        appendBestBetsLog(`⏳ ${payload.track} — scanning ${payload.raceCount} races...`)
        return
      }

      if (payload.type === 'race_done') {
        const runnersFound = payload.runnersFound || 0
        const prefix = payload.error ? '❌' : runnersFound > 0 ? '✅' : '•'
        const suffix = payload.error ? payload.error : `${runnersFound} runner${runnersFound === 1 ? '' : 's'} found`

        setBestBetsProgress(current => ({
          ...current,
          racesChecked: payload.totalRacesScanned ?? (current.racesChecked + 1),
          currentTrack: payload.track || current.currentTrack,
          totalMeetings: payload.totalMeetings ?? current.totalMeetings,
        }))
        appendBestBetsLog(`${prefix} ${payload.track} R${payload.raceNumber} — ${suffix}`)
        return
      }

      if (payload.type === 'meeting_done') {
        setBestBetsProgress(current => ({
          ...current,
          meetingsCompleted: current.meetingsCompleted + 1,
          racesChecked: payload.totalRacesScanned ?? current.racesChecked,
          currentTrack: payload.track || current.currentTrack,
          totalMeetings: payload.totalMeetings ?? current.totalMeetings,
        }))
        appendBestBetsLog(`✅ ${payload.track} complete — ${payload.racesScanned} races checked.`)
        return
      }

      if (payload.type === 'complete') {
        completed = true
        closeBestBetsStream()
        setBestBetsLoading(false)
        setBestBetsResult(payload)
        setBestBetsProgress(current => ({
          ...current,
          racesChecked: payload.totalRacesScanned ?? current.racesChecked,
          meetingsCompleted: payload.totalMeetings ?? current.meetingsCompleted,
          totalMeetings: payload.totalMeetings ?? current.totalMeetings,
        }))
        appendBestBetsLog(
          payload.cached
            ? `✅ Cached result loaded from ${payload.cacheAgeMinutes || 0} minute(s) ago.`
            : `✅ Scan complete — ${payload.picks?.length || 0} picks ranked from ${payload.totalRacesScanned} races.`
        )
        return
      }

      if (payload.type === 'error') {
        completed = true
        closeBestBetsStream()
        setBestBetsLoading(false)
        appendBestBetsLog(`❌ ${payload.message}`)
        setError(payload.message || 'Best bets scan failed')
      }
    }

    stream.onerror = () => {
      if (completed) return
      closeBestBetsStream()
      setBestBetsLoading(false)
      setError('Best bets scan stream disconnected')
    }
  }

  function togglePredictionSort(key) {
    setPredictionSort(current => ({
      key,
      direction: current.key === key && current.direction === 'asc' ? 'desc' : 'asc',
    }))
  }

  const overviewStreak = getStreakDisplay(advancedStats.streaks)
  const sortedPredictions = sortPredictions(predictions, predictionSort)
  const recentResultSquares = [...predictions].sort((left, right) => right.id - left.id).slice(0, 20)
  const modePerformance = ['safest', 'value', 'longshot'].map(modeKey => (
    stats?.by_mode?.find(row => row.mode === modeKey) || { mode: modeKey, total: 0, wins: 0, win_rate: 0, pnl: 0 }
  ))
  const aiStats = stats?.ai_agreement || { totalWithAI: 0, agreedCount: 0, agreedWinRate: 0, disagreedWinRate: 0 }
  const aiAgreementRate = aiStats.totalWithAI > 0
    ? Math.round((aiStats.agreedCount / aiStats.totalWithAI) * 100)
    : 0
  const advancedByTrack = advancedStats.byTrack || []
  const advancedByBox = advancedStats.byBox?.overall || []
  const advancedByMonth = advancedStats.byMonth || []
  const calibrationRows = advancedStats.calibration || []
  const profitCurve = advancedStats.profitCurve || []
  const monthTotals = advancedByMonth.reduce((totals, row) => ({
    total: totals.total + (row.total || 0),
    wins: totals.wins + (row.wins || 0),
    pnl: totals.pnl + (row.pnl || 0),
  }), { total: 0, wins: 0, pnl: 0 })
  const monthTotalsWinRate = monthTotals.total > 0
    ? Math.round((monthTotals.wins / monthTotals.total) * 1000) / 10
    : 0
  const currentMonthKey = todayStr().slice(0, 7)
  const profitChartWidth = 560
  const profitChartHeight = 240
  const profitChartPadding = 18
  const profitMinPnl = Math.min(0, ...profitCurve.map(point => Number(point.runningPnl) || 0))
  const profitMaxPnl = Math.max(0, ...profitCurve.map(point => Number(point.runningPnl) || 0))
  const profitRange = Math.max(1, profitMaxPnl - profitMinPnl)
  const profitX = index => (
    profitCurve.length <= 1
      ? profitChartWidth / 2
      : profitChartPadding + ((profitChartWidth - (profitChartPadding * 2)) * index) / (profitCurve.length - 1)
  )
  const profitY = value => (
    profitChartPadding + ((profitMaxPnl - value) / profitRange) * (profitChartHeight - (profitChartPadding * 2))
  )
  const profitPoints = profitCurve
    .map((point, index) => `${profitX(index)},${profitY(Number(point.runningPnl) || 0)}`)
    .join(' ')
  const zeroLineY = profitY(0)
  const boxBiasRows = Array.from({ length: 8 }, (_, index) => {
    const box = index + 1
    return boxBiasData.boxes?.find(entry => Number(entry.box) === box) || {
      box,
      total_predictions: 0,
      win_count: 0,
      win_rate_pct: 0,
    }
  })
  const sourceRows = result
    ? SOURCES[raceType].map(sourceName => {
        const skipped = result.sourcesSkipped?.find(source => source.source === sourceName)
        const healthRow = scraperHealth.find(row => (row.display_name || row.source_name) === sourceName)
        return {
          sourceName,
          status: result.sourcesUsed?.includes(sourceName)
            ? 'success'
            : skipped
              ? 'failed'
              : 'idle',
          hoverCopy: healthRow?.average_response_time_ms != null
            ? `Avg response ${healthRow.average_response_time_ms}ms`
            : skipped?.reason || 'No recent timing data',
        }
      })
    : []
  const displayedPicks = tracksideMode
    ? (result?.picks || []).slice(0, 1)
    : (result?.picks || [])
  const currentTopPick = result?.picks?.[0] || null
  const bestBetsBuckets = [
    {
      key: 'safest',
      title: "Today's Safest Bets",
      picks: bestBetsResult?.picks?.safest || [],
    },
    {
      key: 'value',
      title: "Today's Value Bets",
      picks: bestBetsResult?.picks?.value || [],
    },
    {
      key: 'longshot',
      title: "Today's Long Shots",
      picks: bestBetsResult?.picks?.longshot || [],
    },
  ]

  return (
    <div className={`app-shell ${tracksideMode ? 'trackside-mode' : ''}`}>
      <header className="topbar">
        <div className="brand-block">
          <div className="brand-mark">🏁 RACEEDGE</div>
          <div className="brand-subtitle">Australian Racing Research &amp; Prediction Tracker</div>
        </div>
        <div className="topbar-meta">
          <div className={`live-chip ${serverConnected ? 'online' : 'offline'}`}>
            <span className="live-dot" />
            <span>{serverConnected ? 'LIVE' : 'OFFLINE'}</span>
          </div>
          <button className={`trackside-toggle ${tracksideMode ? 'active' : ''}`} onClick={() => setTracksideMode(current => !current)}>
            📱 TRACKSIDE
          </button>
          <div className="clock-block">
            <span className="clock-label">Sydney Time</span>
            <strong className="clock-value">{formatClock(now)}</strong>
          </div>
        </div>
      </header>

      {error && (
        <div className="toast toast-error">
          <span>{error}</span>
          <button className="toast-dismiss" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}

      {notice && (
        <div className="toast toast-success">
          <span>{notice.message}</span>
          <button className="toast-dismiss" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-card selector-card">
            <div className="section-title">Race Selector</div>

            <div className="selector-stack">
              <label>
                Date
                <input type="date" value={date} onChange={e => setDate(e.target.value)} />
              </label>

              <div>
                <div className="control-label">Race Type</div>
                <div className="race-type-toggle">
                  <button className={`race-type-button ${raceType === 'greyhound' ? 'active' : ''}`} onClick={() => setRaceType('greyhound')}>
                    🐕 GREYHOUNDS
                  </button>
                  <button className={`race-type-button ${raceType === 'horse' ? 'active' : ''}`} onClick={() => setRaceType('horse')}>
                    🐎 HORSES
                  </button>
                </div>
              </div>

              <label>
                Meeting
                <select value={meeting} onChange={e => setMeeting(e.target.value)} disabled={!meetings.length}>
                  {!meetings.length
                    ? <option>Loading…</option>
                    : meetings.map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </label>

              <div>
                <div className="control-label">Race Number</div>
                <div className="race-number-grid">
                  {RACE_NUMBERS.map(number => (
                    <button
                      key={number}
                      className={`race-number-button ${raceNum === number ? 'active' : ''}`}
                      onClick={() => setRaceNum(number)}
                    >
                      {number}
                    </button>
                  ))}
                </div>
              </div>

              <label>
                Distance (m)
                <input type="number" min="100" step="10" value={distance} onChange={e => setDistance(Number(e.target.value) || 0)} />
              </label>

              <label>
                Stake ($)
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={stake}
                  onChange={e => {
                    const nextStake = parseFloat(e.target.value) || 10
                    setStake(nextStake)
                    localStorage.setItem('raceedge-stake', String(nextStake))
                  }}
                />
              </label>

              <div>
                <div className="control-label">Prediction Mode</div>
                <div className="mode-card-grid">
                  {MODE_CARDS.map(card => (
                    <button
                      key={card.key}
                      className={`mode-card ${card.accent} ${mode === card.key ? 'active' : ''}`}
                      onClick={() => setMode(card.key)}
                    >
                      <span className="mode-icon">{card.icon}</span>
                      <span className="mode-title">{card.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              <button className={`research-button ${loading ? 'loading' : ''}`} onClick={handleResearch} disabled={loading || !meeting}>
                <span className={loading ? 'button-spinner' : ''} />
                <span>{loading ? 'RESEARCHING...' : 'RESEARCH & PICK'}</span>
              </button>

              {loading && (
                <div className="terminal-panel">
                  <div className="section-title">Source Feed</div>
                  <div className="terminal-lines">
                    {SOURCES[raceType]
                      .slice(0, Math.min(activeSourceIdx + 1, SOURCES[raceType].length))
                      .map((sourceName, index) => {
                        const isCurrent = index === activeSourceIdx && activeSourceIdx < SOURCES[raceType].length
                        return (
                          <div key={sourceName} className={`terminal-line ${isCurrent ? 'checking' : 'success'}`}>
                            {isCurrent ? `⏳ Checking ${sourceName}...` : `✅ ${sourceName} — source checked`}
                          </div>
                        )
                      })}
                  </div>
                  {loadMsg && <div className="terminal-status">{loadMsg}</div>}
                </div>
              )}

              {result && (
                <div className="odds-entry-shell">
                  <button
                    className={`panel-button secondary odds-entry-toggle ${manualOddsOpen ? 'open' : ''}`}
                    onClick={() => setManualOddsOpen(current => !current)}
                  >
                    <span>ODDS ENTRY</span>
                    <span>{manualOddsOpen ? '−' : '+'}</span>
                  </button>

                  {manualOddsOpen && (
                    <div className="odds-entry-panel">
                      <div className="dashboard-copy">
                        {result.oddsAvailable
                          ? 'Adjust the current market prices to re-rank the race by expected value.'
                          : 'Odds not scraped — enter manually for EV calculation.'}
                      </div>

                      <div className="odds-entry-table">
                        <div className="odds-entry-header">
                          <span>Box</span>
                          <span>Runner</span>
                          <span>Odds</span>
                          <span>Live EV</span>
                        </div>

                        {manualOddsRows.map((row, index) => {
                          const previewEv = calculateManualEV(row.winProbability, row.decimalOdds)
                          return (
                            <div className="odds-entry-row" key={`${row.runnerName}-${row.box ?? index}`}>
                              <span className={`box-pill compact ${getBoxBadgeClass(row.box)}`}>{row.box ?? '—'}</span>
                              <span className="odds-entry-runner">{row.runnerName}</span>
                              <input
                                type="number"
                                min="1.01"
                                step="0.05"
                                value={row.decimalOdds}
                                onChange={event => handleManualOddsChange(index, event.target.value)}
                              />
                              <span className={`edge-pill ${getEdgeTone(previewEv)}`}>{formatEdge(previewEv)}</span>
                            </div>
                          )
                        })}
                      </div>

                      <button className={`panel-button ${applyingOdds ? 'loading' : ''}`} onClick={handleApplyOdds} disabled={applyingOdds}>
                        <span className={applyingOdds ? 'button-spinner' : ''} />
                        <span>{applyingOdds ? 'APPLYING ODDS...' : 'APPLY ODDS'}</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </aside>

        <main className="main-content">

          {!result && !loading && !tracksideMode && (
            <section className="hero-panel">
              <div className="section-eyebrow">Market Console</div>
              <h2>Research a meeting to surface your top pick, factor breakdown, and full race dashboard.</h2>
              <p>RaceEdge now runs like a dark broadcast desk: live status, source monitoring, journal history, and race-ready trackside mode.</p>
            </section>
          )}

          {loading && !tracksideMode && (
            <section className="dashboard-card ai-analyst-card loading">
              <div className="section-title">🤖 AI Form Analyst</div>
              <div className="ai-analyst-loading">Consulting AI analyst...</div>
            </section>
          )}

          {result && !loading && (
            <div className={`results-panel ${tracksideMode ? 'trackside' : ''}`}>
              <section className={`dashboard-card top-picks-shell ${tracksideMode ? 'trackside' : ''}`}>
                <div className="tab-toolbar">
                  <div>
                    <div className="section-eyebrow">Top Picks</div>
                    <div className="section-title">Mode-Calibrated EV Board</div>
                    <div className="dashboard-copy">Three ranked selections built from model probability, current odds, and expected value.</div>
                  </div>
                  <div className="journal-chip-row">
                    <span className={`edge-pill ${result.oddsAvailable ? 'good' : 'neutral'}`}>
                      {result.oddsAvailable ? `Odds source: ${result.oddsSource || 'market'}` : 'Odds pending'}
                    </span>
                    <span className="meta-pill">{formatModeLabel(result.mode)}</span>
                    {result.distance && <span className="meta-pill">{result.distance}m</span>}
                  </div>
                </div>

                <div className={`top-picks-grid ${tracksideMode ? 'trackside' : ''}`}>
                  {displayedPicks.map((pick, index) => (
                    <article className={`top-pick-card ${index === 0 ? 'featured' : ''}`} key={`${pick.name}-${pick.rank}`}>
                      <div className="top-pick-head">
                        <div className="top-pick-heading">
                          <div className="journal-chip-row">
                            <span className={`rank-badge ${pick.rank === 1 ? 'gold' : pick.rank === 2 ? 'silver' : 'bronze'}`}>#{pick.rank}</span>
                            {(pick.box ?? pick.barrier) != null && (
                              <span className={`box-pill ${getBoxBadgeClass(pick.box ?? pick.barrier)}`}>
                                {pick.box != null ? `BOX ${pick.box}` : `BARRIER ${pick.barrier}`}
                              </span>
                            )}
                          </div>
                          <div className="runner-name">{pick.name}</div>
                          <div className="runner-meta">
                            <span className="meta-pill">Win {formatProbability(pick.winProbability)}</span>
                            <span className="meta-pill">{formatOdds(pick.decimalOdds)}</span>
                            {pick.oddsClassification && <span className="meta-pill">{pick.oddsClassification}</span>}
                          </div>
                        </div>
                        <div className="confidence-cluster">
                          <div className="confidence-caption">Confidence</div>
                          <div className="confidence-number">{pick.confidence}%</div>
                        </div>
                      </div>

                      <div className="pick-metric-grid">
                        <div className="pick-metric-card">
                          <span className="confidence-caption">Composite</span>
                          <strong>{pick.compositeScore}</strong>
                        </div>
                        <div className="pick-metric-card">
                          <span className="confidence-caption">Model Win %</span>
                          <strong>{formatProbability(pick.winProbability)}</strong>
                        </div>
                        <div className="pick-metric-card">
                          <span className="confidence-caption">Expected Return</span>
                          <strong>{pick.expectedReturn != null ? `${pick.expectedReturn >= 0 ? '+' : ''}${Math.round(pick.expectedReturn * 100)}%` : '—'}</strong>
                        </div>
                        <div className={`edge-pill large ${getEdgeTone(pick.ev)}`}>
                          {formatEdge(pick.ev)}
                        </div>
                      </div>

                      <div>
                        <div className="confidence-caption">Composite Score</div>
                        <div className="confidence-meter">
                          <div className="confidence-meter-fill" style={{ width: `${pick.compositeScore}%` }} />
                        </div>
                      </div>

                      <div className="top-pick-reasoning">{pick.summary}</div>

                      <div className="breakdown-grid">
                        {SCORE_FACTORS.map(factor => {
                          const score = pick.breakdown?.[factor.key] ?? 0
                          return (
                            <div className="breakdown-row compact" key={`${pick.name}-${factor.key}`}>
                              <div className="breakdown-label-group">
                                <span>{factor.label}</span>
                                <span>{factor.weight}</span>
                              </div>
                              <div className="breakdown-bar-shell">
                                <div className={`breakdown-bar ${getFactorTone(score)}`} style={{ width: `${score}%` }} />
                              </div>
                              <div className="breakdown-score">{score}</div>
                            </div>
                          )
                        })}
                      </div>
                    </article>
                  ))}
                </div>

                {currentTopPick && (tracksideMode || !recorded) && (
                  <div className={`record-panel ${tracksideMode ? 'trackside' : ''}`}>
                    <div className="section-eyebrow">Result Tracker</div>
                    {!recorded ? (
                      <>
                        <div className="dashboard-copy">Recording against #{currentTopPick.rank} {currentTopPick.name}.</div>
                        <label className="record-input">
                          <span>Odds</span>
                          <input
                            type="number"
                            step="0.05"
                            min="1"
                            placeholder={currentTopPick.decimalOdds?.toFixed(2) ?? '2.50'}
                            value={odds}
                            onChange={e => setOdds(e.target.value)}
                          />
                        </label>
                        <div className="record-actions">
                          <button className="result-btn win" onClick={() => handleRecord('win')} disabled={recording}>Win</button>
                          <button className="result-btn loss" onClick={() => handleRecord('loss')} disabled={recording}>Loss</button>
                          <button className="result-btn scratched" onClick={() => handleRecord('scratched')} disabled={recording}>Scratched</button>
                        </div>
                      </>
                    ) : (
                      <div className="recorded-chip">Result recorded</div>
                    )}
                  </div>
                )}
              </section>

              {!tracksideMode && (
                <section className={`dashboard-card ai-analyst-card ${result.aiAnalysis ? 'ready' : 'unavailable'}`}>
                  <div className="section-title">🤖 AI Form Analyst</div>

                  {!result.aiAnalysis ? (
                    <div className="empty-state-card ai-analyst-empty">AI analysis unavailable — check `ANTHROPIC_API_KEY` in server `.env`.</div>
                  ) : (
                    <div className="ai-analyst-body">
                      <div className="ai-analyst-recommendation">
                        <div className="section-eyebrow">Recommendation</div>
                        <div className={`ai-runner-name ${result.aiAnalysis.modelAgreement ? 'agreement' : 'difference'}`}>
                          {result.aiAnalysis.recommendation.runner}
                        </div>
                        <div className="journal-chip-row">
                          {result.aiAnalysis.recommendation.box != null && (
                            <span className={`box-pill ${getBoxBadgeClass(result.aiAnalysis.recommendation.box)}`}>BOX {result.aiAnalysis.recommendation.box}</span>
                          )}
                          <span className={`agreement-badge ${result.aiAnalysis.modelAgreement ? 'agree' : 'differs'}`}>
                            {result.aiAnalysis.modelAgreement ? '✅ AGREES WITH MODEL' : '⚠️ DIFFERS FROM MODEL'}
                          </span>
                        </div>
                        <div className="ai-analyst-reasoning">{result.aiAnalysis.recommendation.reasoning}</div>
                      </div>

                      <div className="ai-analyst-section">
                        <div className="section-eyebrow">Value Watch</div>
                        <div className="ai-supporting-runner">{result.aiAnalysis.valueWatch?.runner || '—'}</div>
                        <div className="dashboard-copy">{result.aiAnalysis.valueWatch?.reasoning || 'No alternative highlighted.'}</div>
                      </div>

                      <div className="ai-analyst-section">
                        <div className="section-eyebrow">Race Dynamic</div>
                        <div className="dashboard-copy">{result.aiAnalysis.raceDynamic}</div>
                      </div>

                      <div className="ai-confidence-row">
                        <span className={`ai-confidence-badge ${String(result.aiAnalysis.confidence || '').toLowerCase()}`}>
                          {result.aiAnalysis.confidence}
                        </span>
                        <span className="dashboard-copy">{result.aiAnalysis.confidenceReason}</span>
                      </div>

                      {result.aiAnalysis.concerns && (
                        <div className="ai-concerns-box">
                          <div className="section-eyebrow">Concerns</div>
                          <div>{result.aiAnalysis.concerns}</div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
              )}

              {!tracksideMode && result.allRunners?.length > 0 && (
                <section className="dashboard-card">
                  <div className="section-title">Full Field</div>
                  <div className="table-shell">
                    <table className="field-table">
                      <thead>
                        <tr>
                          <th>Rank</th>
                          <th>Box</th>
                          <th>Name</th>
                          <th>Form</th>
                          <th>Win %</th>
                          <th>Odds</th>
                          <th>EV</th>
                          <th>Composite</th>
                          <th>Factors</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.allRunners.map((runnerScore, index) => (
                          <tr
                            key={runnerScore.name}
                            className={`${runnerScore.name === currentTopPick?.name ? 'highlight' : ''} ${runnerScore.scratched ? 'scratched' : ''}`.trim()}
                          >
                            <td>{index + 1}</td>
                            <td><span className={`box-pill compact ${getBoxBadgeClass(runnerScore.box ?? runnerScore.barrier)}`}>{runnerScore.box ?? runnerScore.barrier ?? '—'}</span></td>
                            <td>{runnerScore.name}</td>
                            <td>{runnerScore.breakdown?.recentForm ?? '—'}</td>
                            <td>{formatProbability(runnerScore.winProbability)}</td>
                            <td>{runnerScore.decimalOdds != null ? `$${runnerScore.decimalOdds.toFixed(2)}` : '—'}</td>
                            <td><span className={`edge-pill compact ${getEdgeTone(runnerScore.ev)}`}>{formatEdge(runnerScore.ev)}</span></td>
                            <td className="composite-cell">{runnerScore.compositeScore ?? runnerScore.score}</td>
                            <td>
                              <div className="factor-dot-row">
                                {SCORE_FACTORS.map(factor => (
                                  <span
                                    key={`${runnerScore.name}-${factor.key}`}
                                    className={`factor-dot ${getFactorTone(runnerScore.breakdown?.[factor.key] ?? 0)}`}
                                    title={`${factor.label}: ${runnerScore.breakdown?.[factor.key] ?? 0}`}
                                  />
                                ))}
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}

              {!tracksideMode && (
                <section className="dashboard-card sources-card">
                  <div className="section-title">Sources</div>
                  <div className="source-pill-grid">
                    {sourceRows.map(source => (
                      <span
                        key={source.sourceName}
                        className={`source-pill ${source.status}`}
                        title={source.hoverCopy}
                      >
                        {source.sourceName}
                      </span>
                    ))}
                  </div>
                  {result.boxBiasSource && <div className="micro-note">Box bias source: {result.boxBiasSource}</div>}
                  {result.warning && <div className="warning-panel">{result.warning}</div>}
                </section>
              )}
            </div>
          )}

          {!tracksideMode && stats && (
            <section className="dashboard-shell">
              <div className="dashboard-tab-strip">
                {DASHBOARD_TABS.map(tab => (
                  <button
                    key={tab.key}
                    className={`dashboard-tab-button ${tab.key === 'bestBets' ? 'best-bets-tab' : ''} ${dashboardTab === tab.key ? 'active' : ''}`}
                    onClick={() => setDashboardTab(tab.key)}
                  >
                    <span className="dashboard-tab-icon">{tab.icon}</span>
                    <span>{tab.label}</span>
                    {tab.key === 'predictions' && pendingPredictions.length > 0 && (
                      <span className="dashboard-tab-badge">{pendingPredictions.length}</span>
                    )}
                  </button>
                ))}
              </div>

              <div className="dashboard-stage" key={dashboardTab}>
                {dashboardTab === 'bestBets' && (
                  <section className="dashboard-card best-bets-shell">
                    <div className="tab-toolbar">
                      <div>
                        <div className="section-title">Today&apos;s Best Bets</div>
                        <div className="dashboard-copy">Scan every meeting for a day, surface the strongest EV opportunities in each mode, and jump straight into a race for a deeper research pass.</div>
                      </div>
                    </div>

                    <div className="best-bets-controls">
                      <label>
                        Scan Date
                        <input type="date" value={bestBetsDate} onChange={event => setBestBetsDate(event.target.value)} />
                      </label>

                      <div>
                        <div className="control-label">Race Type</div>
                        <div className="race-type-toggle">
                          <button className={`race-type-button ${bestBetsType === 'greyhound' ? 'active' : ''}`} onClick={() => setBestBetsType('greyhound')}>
                            🐕 GREYHOUNDS
                          </button>
                          <button className={`race-type-button ${bestBetsType === 'horse' ? 'active' : ''}`} onClick={() => setBestBetsType('horse')}>
                            🐎 HORSES
                          </button>
                        </div>
                      </div>

                      <button className={`research-button best-bets-button ${bestBetsLoading ? 'loading' : ''}`} onClick={handleBestBetsScan} disabled={bestBetsLoading}>
                        <span className={bestBetsLoading ? 'button-spinner' : ''} />
                        <span>{bestBetsLoading ? 'SCANNING ALL RACES...' : 'SCAN ALL RACES'}</span>
                      </button>

                      <div className="micro-note">Scanning all races may take 2-3 minutes. Once started, this scan cannot be cancelled.</div>
                    </div>

                    {bestBetsLoading && (
                      <>
                        <div className="scan-progress">
                          <strong>Scanning {bestBetsProgress.totalMeetings || '…'} meetings... {bestBetsProgress.racesChecked} races checked so far.</strong>
                          <span>{bestBetsProgress.currentTrack ? `Current meeting: ${bestBetsProgress.currentTrack}` : 'Waiting for the first meeting to begin...'}</span>
                        </div>

                        <div className="terminal-panel">
                          <div className="section-title">Live Scan Feed</div>
                          <div className="terminal-lines">
                            {bestBetsLog.map((entry, index) => (
                              <div
                                key={`${entry}-${index}`}
                                className={`terminal-line ${entry.startsWith('❌') ? 'failed' : entry.startsWith('✅') ? 'success' : 'checking'}`}
                              >
                                {entry}
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}

                    {!bestBetsLoading && !bestBetsResult && (
                      <div className="empty-state-card">Run a day-wide scan to surface the strongest ranked opportunities for the selected date.</div>
                    )}

                    {bestBetsResult && (
                      <div className="best-bets-results">
                        <div className="best-bets-heading">
                          <div className="section-eyebrow">TODAY&apos;S CURATED BOARD</div>
                          <h3 className="best-bets-title">Top EV Opportunities For {bestBetsResult.date}</h3>
                          <div className="dashboard-copy">Generated {formatTimestamp(bestBetsResult.generatedAt)} · {bestBetsResult.totalMeetings} meetings · {bestBetsResult.totalRacesScanned} races checked</div>
                          {bestBetsResult.cached && (
                            <div className="micro-note">Cached result from {bestBetsResult.cacheAgeMinutes || 0} minute(s) ago.</div>
                          )}
                        </div>

                        <div className="best-bets-buckets">
                          {bestBetsBuckets.map(bucket => (
                            <section className="best-bets-bucket" key={bucket.key}>
                              <div className="bucket-heading-row">
                                <div className="section-title">{bucket.title}</div>
                                <span className={`mode-badge ${bucket.key}`}>{formatModeLabel(bucket.key)}</span>
                              </div>

                              {bucket.picks.length > 0 ? (
                                <div className="best-bets-grid">
                                  {bucket.picks.map(pick => (
                                    <article className="best-bet-card" key={`${bucket.key}-${pick.track}-${pick.raceNumber}-${pick.runnerName}`}>
                                      <div className="best-bet-head">
                                        <span className={`rank-badge ${pick.rank === 1 ? 'gold' : pick.rank === 2 ? 'silver' : 'bronze'}`}>#{pick.rank}</span>
                                        <div className="best-bet-heading-copy">
                                          <div className="best-bet-meta">{pick.track} · Race {pick.raceNumber} · {pick.distance ? `${pick.distance}m` : 'Distance TBC'}</div>
                                          <div className="best-bet-runner">{pick.runnerName}</div>
                                        </div>
                                        {pick.box != null && <span className={`box-pill ${getBoxBadgeClass(pick.box)}`}>BOX {pick.box}</span>}
                                      </div>

                                      <div className="best-bet-submeta">
                                        {pick.estimatedStartTime && <span className="meta-pill">Start {pick.estimatedStartTime}</span>}
                                        {pick.grade && <span className="meta-pill">{pick.grade}</span>}
                                        <span className="meta-pill">Win {formatProbability(pick.winProbability)}</span>
                                      </div>

                                      <div className="best-bet-metrics">
                                        <span className="meta-pill">{formatOdds(pick.decimalOdds)}</span>
                                        <span className={`edge-pill ${getEdgeTone(pick.ev)}`}>{formatEdge(pick.ev)}</span>
                                        <span className="journal-meta-pill">Composite {pick.compositeScore}</span>
                                      </div>

                                      <div className="confidence-caption">Confidence</div>
                                      <div className="confidence-meter">
                                        <div className="confidence-meter-fill" style={{ width: `${pick.confidence}%` }} />
                                      </div>

                                      <button className="panel-button quick-bet-button" onClick={() => handleQuickBet(pick)}>
                                        QUICK BET
                                      </button>
                                    </article>
                                  ))}
                                </div>
                              ) : (
                                <div className="empty-state-card">No qualifying {bucket.key} bets were found in this scan.</div>
                              )}
                            </section>
                          ))}
                        </div>

                        <div className="best-bets-actions">
                          <button className="panel-button secondary" onClick={handleBestBetsScan} disabled={bestBetsLoading}>
                            SCAN AGAIN
                          </button>
                          {bestBetsResult.cached && <span className="micro-note">Cache window lasts 30 minutes for the same date, race type, and mode.</span>}
                        </div>
                      </div>
                    )}
                  </section>
                )}

                {dashboardTab === 'overview' && (
                  <>
                    <section className="dashboard-card analytics-toolbar-card">
                      <div>
                        <div className="section-title">Advanced Overview</div>
                        <div className="dashboard-copy">Track splits, calibration, streaks, monthly form, and profitability in one racing board.</div>
                      </div>
                      <div className="analytics-toolbar-actions">
                        <span className={`pending-pill ${pendingPredictions.length > 0 ? 'active' : ''}`}>Pending {pendingPredictions.length}</span>
                        <button className={`panel-button ${checkingResults ? 'loading' : ''}`} onClick={handleCheckResults} disabled={checkingResults}>
                          <span className={checkingResults ? 'button-spinner' : ''} />
                          <span>{checkingResults ? 'CHECKING RESULTS...' : 'CHECK RESULTS'}</span>
                        </button>
                      </div>
                    </section>

                    <div className="stats-hero-grid">
                      <article className="stat-tile">
                        <span className="stat-heading">Overall Win Rate</span>
                        <strong className={`stat-number ${getHeroWinRateTone(stats?.overall_win_rate ?? 0)}`}>{stats?.overall_win_rate ?? 0}%</strong>
                        <span className="stat-subtext">Settled predictions across the ledger</span>
                      </article>

                      <article className="stat-tile">
                        <span className="stat-heading">Total P&amp;L</span>
                        <strong className={`stat-number ${(stats?.total_pnl ?? 0) >= 0 ? 'positive' : 'negative'}`}>
                          {formatSignedCurrency(stats?.total_pnl ?? 0)}
                        </strong>
                        <span className="stat-subtext">Realised result after all updates</span>
                      </article>

                      <article className="stat-tile">
                        <span className="stat-heading">Predictions Made</span>
                        <strong className="stat-number">{predictions.length}</strong>
                        <span className="stat-subtext">Stored selections and follow-up outcomes</span>
                      </article>

                      <article className="stat-tile">
                        <span className="stat-heading">Current Streak</span>
                        <strong className={`stat-number ${overviewStreak.tone}`}>{overviewStreak.label}</strong>
                        <span className="stat-subtext">
                          Best ever W{advancedStats.streaks.longest} / L{advancedStats.streaks.longestLoss}
                        </span>
                      </article>
                    </div>

                    <div className="advanced-overview-stack">
                      <section className="dashboard-card">
                        <div className="section-title">Recent Form Strip</div>
                        <div className="dashboard-copy">Last 20 outcomes at a glance. Hover any tile for the race date and result.</div>
                        <div className="advanced-result-strip">
                          {recentResultSquares.length > 0 ? recentResultSquares.map(prediction => {
                            const status = formatPredictionResult(prediction.result)
                            const letter = status === 'win' ? 'W' : status === 'loss' ? 'L' : 'P'
                            return (
                              <span
                                key={prediction.id}
                                className={`result-letter-tile ${status}`}
                                title={`${prediction.date} · ${prediction.track} R${prediction.race_number} · ${status}`}
                              >
                                {letter}
                              </span>
                            )
                          }) : (
                            <div className="empty-state-card">No prediction history yet.</div>
                          )}
                        </div>
                      </section>

                      <section className="dashboard-card">
                        <div className="section-title">Performance By Mode</div>
                        <div className="mode-performance-grid">
                          {modePerformance.map(modeRow => (
                            <article className={`mode-performance-card ${getHeroWinRateTone(modeRow.win_rate)} ${modeRow.mode}`} key={modeRow.mode}>
                              <span className="mode-mini-title">{formatModeLabel(modeRow.mode)}</span>
                              <strong>{modeRow.win_rate}%</strong>
                              <span>{modeRow.total} bets</span>
                              <span>{formatSignedCurrency(modeRow.pnl || 0)}</span>
                            </article>
                          ))}
                        </div>
                      </section>

                      <section className="dashboard-card">
                        <div className="section-title">Win Rate By Track</div>
                        <div className="dashboard-copy">Tracks with at least three recorded predictions are ranked by strike rate.</div>
                        {advancedByTrack.length > 0 ? (
                          <div className="track-performance-list">
                            {advancedByTrack.map(row => {
                              const tone = getAnalyticsWinRateTone(row.winRate)
                              return (
                                <div className="track-performance-row" key={row.track}>
                                  <div className="track-performance-meta">
                                    <strong>{row.track}</strong>
                                    <span>{row.total} predictions</span>
                                  </div>
                                  <div className="track-performance-bar-shell">
                                    <div className={`track-performance-bar ${tone}`} style={{ width: `${Math.max(4, row.winRate)}%` }} />
                                  </div>
                                  <div className={`track-performance-value ${tone}`}>{row.winRate}%</div>
                                </div>
                              )
                            })}
                          </div>
                        ) : (
                          <div className="empty-state-card">Track splits unlock after three settled predictions at a venue.</div>
                        )}
                      </section>

                      <section className="dashboard-card">
                        <div className="section-title">Win Rate By Box Number</div>
                        <div className="box-performance-grid">
                          {(advancedByBox.length > 0 ? advancedByBox : Array.from({ length: 8 }, (_, index) => ({
                            box: index + 1,
                            total: 0,
                            wins: 0,
                            winRate: 0,
                            avgCompositeScore: null,
                          }))).map(row => {
                            const tone = getAnalyticsWinRateTone(row.winRate)
                            return (
                              <article className={`box-performance-card ${tone}`} key={`overview-box-${row.box}`}>
                                <span className={`box-pill ${getBoxBadgeClass(row.box)}`}>Box {row.box}</span>
                                <strong>{row.winRate}%</strong>
                                <span>{row.total} samples</span>
                                <span>{row.avgCompositeScore != null ? `Avg score ${row.avgCompositeScore}` : 'No score history yet'}</span>
                              </article>
                            )
                          })}
                        </div>
                        <div className="micro-note">Updates with empirical data after 10+ samples per box.</div>
                      </section>

                      <section className="dashboard-card">
                        <div className="section-title">Monthly Performance</div>
                        <div className="table-shell">
                          <table className="monthly-table">
                            <thead>
                              <tr>
                                <th>Month</th>
                                <th>Bets</th>
                                <th>Wins</th>
                                <th>Win Rate</th>
                                <th>P&amp;L</th>
                              </tr>
                            </thead>
                            <tbody>
                              {advancedByMonth.map(row => (
                                <tr key={row.month} className={row.month === currentMonthKey ? 'current-month' : ''}>
                                  <td>{formatMonthLabel(row.month)}</td>
                                  <td>{row.total}</td>
                                  <td>{row.wins}</td>
                                  <td className={getAnalyticsWinRateTone(row.winRate)}>{row.winRate}%</td>
                                  <td className={row.pnl >= 0 ? 'positive' : 'negative'}>{formatSignedCurrency(row.pnl)}</td>
                                </tr>
                              ))}
                            </tbody>
                            <tfoot>
                              <tr>
                                <td>Running Total</td>
                                <td>{monthTotals.total}</td>
                                <td>{monthTotals.wins}</td>
                                <td>{monthTotalsWinRate}%</td>
                                <td className={monthTotals.pnl >= 0 ? 'positive' : 'negative'}>{formatSignedCurrency(monthTotals.pnl)}</td>
                              </tr>
                            </tfoot>
                          </table>
                        </div>
                      </section>

                      <section className="dashboard-card calibration-card">
                        <div className="section-title">Am I Confident In The Right Races?</div>
                        <div className="dashboard-copy">A well-calibrated model wins about 75% of races it rates 70-79% confident. Red means overconfident, green means underconfident.</div>
                        <div className="calibration-stack">
                          {calibrationRows.map(row => {
                            const tone = getCalibrationTone(row.actualWinRate, row.predictedPct, row.total)
                            return (
                              <div className="calibration-row" key={row.bucket}>
                                <div className="calibration-meta">
                                  <strong>{row.bucket}</strong>
                                  <span>{row.total} samples</span>
                                </div>
                                <div className="calibration-track">
                                  <div className="calibration-bar predicted" style={{ width: `${row.predictedPct}%` }} />
                                  <div className={`calibration-bar actual ${tone}`} style={{ width: `${row.actualWinRate}%` }} />
                                </div>
                                <div className="calibration-values">
                                  <span>Pred {row.predicted}</span>
                                  <span>Act {row.actualWinRate}%</span>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </section>

                      {aiStats.totalWithAI > 0 && (
                        <section className="dashboard-card ai-performance-card">
                          <div className="section-title">AI Analyst Performance</div>
                          <div className="ai-performance-grid">
                            <div className="mode-mini-card">
                              <span className="mode-mini-title">AI-Assisted</span>
                              <strong>{aiStats.totalWithAI}</strong>
                              <span>Predictions with Claude analysis</span>
                            </div>
                            <div className="mode-mini-card">
                              <span className="mode-mini-title">Agreement Rate</span>
                              <strong>{aiAgreementRate}%</strong>
                              <span>{aiStats.agreedCount}/{aiStats.totalWithAI} aligned</span>
                            </div>
                            <div className="mode-mini-card">
                              <span className="mode-mini-title">AI Agrees</span>
                              <strong>{aiStats.agreedWinRate}%</strong>
                              <span>Model and Claude on the same page</span>
                            </div>
                            <div className="mode-mini-card">
                              <span className="mode-mini-title">AI Differs</span>
                              <strong>{aiStats.disagreedWinRate}%</strong>
                              <span>Performance when opinions split</span>
                            </div>
                          </div>
                          {aiStats.totalWithAI < 10 && (
                            <div className="micro-note">Check back after 10 AI-assisted predictions for meaningful stats.</div>
                          )}
                        </section>
                      )}

                      <section className="dashboard-card">
                        <div className="section-title">P&amp;L Curve</div>
                        {profitCurve.length >= 5 ? (
                          <div className="profit-curve-wrap">
                            <svg className="profit-curve-chart" viewBox={`0 0 ${profitChartWidth} ${profitChartHeight}`} preserveAspectRatio="none">
                              <defs>
                                <clipPath id="profit-positive-clip">
                                  <rect x="0" y="0" width={profitChartWidth} height={zeroLineY} />
                                </clipPath>
                                <clipPath id="profit-negative-clip">
                                  <rect x="0" y={zeroLineY} width={profitChartWidth} height={profitChartHeight - zeroLineY} />
                                </clipPath>
                              </defs>
                              <line
                                x1={profitChartPadding}
                                x2={profitChartWidth - profitChartPadding}
                                y1={zeroLineY}
                                y2={zeroLineY}
                                className="profit-baseline"
                              />
                              <polyline points={profitPoints} className="profit-line positive" clipPath="url(#profit-positive-clip)" />
                              <polyline points={profitPoints} className="profit-line negative" clipPath="url(#profit-negative-clip)" />
                              {profitCurve.map((point, index) => (
                                <circle
                                  key={`${point.date}-${index}`}
                                  cx={profitX(index)}
                                  cy={profitY(Number(point.runningPnl) || 0)}
                                  r={index === profitCurve.length - 1 ? 4 : 2.5}
                                  className="profit-point"
                                />
                              ))}
                            </svg>
                            <div className="profit-curve-meta">
                              <span>Start {formatSignedCurrency(profitCurve[0]?.runningPnl || 0)}</span>
                              <span>End {formatSignedCurrency(profitCurve[profitCurve.length - 1]?.runningPnl || 0)}</span>
                            </div>
                          </div>
                        ) : (
                          <div className="empty-state-card">At least 5 predictions are needed before the P&amp;L curve becomes meaningful.</div>
                        )}
                      </section>
                    </div>
                  </>
                )}

                {dashboardTab === 'predictions' && (
                  <section className="dashboard-card">
                    <div className="tab-toolbar">
                      <div>
                        <div className="section-title">Predictions Ledger</div>
                        <div className="dashboard-copy">Sortable ledger of every stored prediction, including auto-resolved and manual result entries.</div>
                      </div>
                      <span className={`pending-pill ${pendingPredictions.length > 0 ? 'active' : ''}`}>Pending {pendingPredictions.length}</span>
                    </div>

                    <div className="table-shell">
                      <table className="predictions-table">
                        <thead>
                          <tr>
                            <th><button className="sort-button" onClick={() => togglePredictionSort('date')}>Date {predictionSort.key === 'date' ? (predictionSort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
                            <th><button className="sort-button" onClick={() => togglePredictionSort('track')}>Track {predictionSort.key === 'track' ? (predictionSort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
                            <th><button className="sort-button" onClick={() => togglePredictionSort('race_number')}>Race {predictionSort.key === 'race_number' ? (predictionSort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
                            <th><button className="sort-button" onClick={() => togglePredictionSort('runner')}>Pick {predictionSort.key === 'runner' ? (predictionSort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
                            <th><button className="sort-button" onClick={() => togglePredictionSort('mode')}>Mode {predictionSort.key === 'mode' ? (predictionSort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
                            <th><button className="sort-button" onClick={() => togglePredictionSort('odds')}>Odds {predictionSort.key === 'odds' ? (predictionSort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
                            <th><button className="sort-button" onClick={() => togglePredictionSort('pnl')}>P&amp;L {predictionSort.key === 'pnl' ? (predictionSort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
                            <th><button className="sort-button" onClick={() => togglePredictionSort('result')}>Result {predictionSort.key === 'result' ? (predictionSort.direction === 'asc' ? '↑' : '↓') : ''}</button></th>
                          </tr>
                        </thead>
                        <tbody>
                          {sortedPredictions.length > 0 ? sortedPredictions.map(prediction => {
                            const resultStatus = formatPredictionResult(prediction.result)

                            return (
                              <tr key={prediction.id} className={`prediction-row ${resultStatus}`}>
                                <td>{prediction.date}</td>
                                <td>{prediction.track}</td>
                                <td>R{prediction.race_number}</td>
                                <td>
                                  <div className="prediction-pick">
                                    <span>{prediction.race_type === 'greyhound' ? '🐕' : '🐎'}</span>
                                    <span>{prediction.runner}</span>
                                  </div>
                                </td>
                                <td><span className={`mode-badge ${prediction.mode}`}>{formatModeLabel(prediction.mode)}</span></td>
                                <td>{prediction.odds ? `$${prediction.odds.toFixed(2)}` : '—'}</td>
                                <td className={`pnl-cell ${prediction.pnl == null ? '' : prediction.pnl >= 0 ? 'positive' : 'negative'}`}>
                                  {prediction.pnl != null ? `${prediction.pnl >= 0 ? '+' : ''}$${prediction.pnl.toFixed(2)}` : '—'}
                                </td>
                                <td>
                                  <div className="result-chip-row">
                                    <span className={`status-badge ${resultStatus}`}>{resultStatus}</span>
                                    {resultStatus !== 'pending' && (
                                      <span
                                        className="resolution-icon"
                                        title={prediction.resolved_automatically ? 'Resolved automatically' : 'Recorded manually'}
                                      >
                                        {prediction.resolved_automatically ? '🤖' : '✋'}
                                      </span>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            )
                          }) : (
                            <tr>
                              <td colSpan="8" className="empty-state">No predictions have been stored yet.</td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {dashboardTab === 'boxBias' && (
                  <section className="dashboard-card">
                    <div className="tab-toolbar">
                      <div>
                        <div className="section-title">Box Bias</div>
                        <div className="dashboard-copy">Track-specific box performance with a fallback to default scoring when the sample is still thin.</div>
                      </div>
                      <button className="panel-button secondary" onClick={() => loadBoxBias()} disabled={boxBiasLoading || !boxBiasTrack || !boxBiasDistance}>
                        {boxBiasLoading ? 'REFRESHING...' : 'REFRESH BOX BIAS'}
                      </button>
                    </div>

                    <div className="compact-control-grid">
                      <label>
                        Track
                        <input list="track-options" value={boxBiasTrack} onChange={e => setBoxBiasTrack(e.target.value)} />
                        <datalist id="track-options">
                          {Array.from(new Set(meetings.filter(Boolean))).map(trackName => (
                            <option key={trackName} value={trackName} />
                          ))}
                        </datalist>
                      </label>

                      <label>
                        Distance (m)
                        <input type="number" min="100" step="10" value={boxBiasDistance} onChange={e => setBoxBiasDistance(Number(e.target.value) || 0)} />
                      </label>
                    </div>

                    <div className="micro-note">
                      {boxBiasData.source === 'empirical'
                        ? 'Source: empirical history from RaceEdge prediction outcomes.'
                        : boxBiasData.message || 'Source: default box profile because there is not enough local history yet.'}
                    </div>

                    <div className="table-shell">
                      <table className="health-table">
                        <thead>
                          <tr>
                            <th>Box</th>
                            <th>Win Rate</th>
                            <th>Sample Size</th>
                          </tr>
                        </thead>
                        <tbody>
                          {boxBiasRows.map(box => (
                            <tr key={box.box}>
                              <td>Box {box.box}</td>
                              <td><span className={`health-rate ${getBoxBiasTone(box.win_rate_pct)}`}>{box.win_rate_pct}%</span></td>
                              <td>{box.total_predictions}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}

                {dashboardTab === 'journal' && (
                  <section className="dashboard-card">
                    <div className="tab-toolbar">
                      <div>
                        <div className="section-title">Prediction Journal</div>
                        <div className="dashboard-copy">Open any journal snapshot to inspect source coverage, winner breakdown, and the full ranked field.</div>
                      </div>
                      <button className="panel-button secondary" onClick={() => loadJournal()} disabled={journalLoading}>
                        {journalLoading ? 'REFRESHING...' : 'REFRESH JOURNAL'}
                      </button>
                    </div>

                    {journalEntries.length > 0 ? (
                      <div className="journal-stack">
                        {journalEntries.map(entry => {
                          const isExpanded = expandedJournalId === entry.prediction_id

                          return (
                            <article key={entry.id} className={`journal-entry ${isExpanded ? 'expanded' : ''}`}>
                              <button
                                className="journal-summary-row"
                                onClick={() => setExpandedJournalId(current => current === entry.prediction_id ? null : entry.prediction_id)}
                              >
                                <span>{entry.race_date}</span>
                                <span>{entry.track}</span>
                                <span>R{entry.race_number}</span>
                                <span>{entry.winner_name}</span>
                                <span className={`mode-badge ${entry.mode_used}`}>{formatModeLabel(entry.mode_used)}</span>
                              </button>

                              {isExpanded && (
                                <div className="journal-expand">
                                  <div className="journal-chip-row">
                                    <span className="journal-meta-pill">Box Data: {entry.box_bias_source || 'default'}</span>
                                    <span className="journal-meta-pill">Winner Score: {entry.winner_composite_score}</span>
                                    <span className="journal-meta-pill">Distance: {entry.race_distance ? `${entry.race_distance}m` : '—'}</span>
                                  </div>

                                  <div className="journal-breakdown-grid">
                                    {SCORE_FACTORS.map(factor => {
                                      const score = entry.winner_breakdown?.[factor.key] ?? 0
                                      return (
                                        <div className="breakdown-row" key={`${entry.id}-${factor.key}`}>
                                          <div className="breakdown-label-group">
                                            <span>{factor.label}</span>
                                            <span>{factor.weight}</span>
                                          </div>
                                          <div className="breakdown-bar-shell">
                                            <div className={`breakdown-bar ${getFactorTone(score)}`} style={{ width: `${score}%` }} />
                                          </div>
                                          <div className="breakdown-score">{score}</div>
                                        </div>
                                      )
                                    })}
                                  </div>

                                  <div className="table-shell">
                                    <table className="journal-field-table">
                                      <thead>
                                        <tr>
                                          <th>Rank</th>
                                          <th>Runner</th>
                                          <th>Score</th>
                                          <th>Box</th>
                                          <th>Odds</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {entry.all_runners?.map((runnerScore, index) => (
                                          <tr key={`${entry.id}-${runnerScore.name}`} className={runnerScore.name === entry.winner_name ? 'highlight' : ''}>
                                            <td>{index + 1}</td>
                                            <td>{runnerScore.name}</td>
                                            <td>{runnerScore.compositeScore ?? runnerScore.score ?? '—'}</td>
                                            <td>{runnerScore.box ?? runnerScore.barrier ?? '—'}</td>
                                            <td>{runnerScore.odds ? `$${runnerScore.odds.toFixed(2)}` : '—'}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  </div>

                                  <div className="journal-chip-row">
                                    {entry.sources_consulted?.map(source => (
                                      <span
                                        key={`${entry.id}-${source.source}`}
                                        className={`source-pill ${source.status === 'success' ? 'success' : 'failed'}`}
                                        title={source.error || `${source.recordsReturned || 0} records returned`}
                                      >
                                        {source.source}
                                      </span>
                                    ))}
                                  </div>

                                  {entry.ai_analysis && (
                                    <div className="journal-ai-panel">
                                      <div className="section-eyebrow">AI Form Analyst</div>
                                      <div className={`ai-runner-name ${entry.ai_analysis.modelAgreement ? 'agreement' : 'difference'}`}>
                                        {entry.ai_analysis.recommendation?.runner || 'No recommendation'}
                                      </div>
                                      <div className="journal-chip-row">
                                        <span className={`agreement-badge ${entry.ai_analysis.modelAgreement ? 'agree' : 'differs'}`}>
                                          {entry.ai_analysis.modelAgreement ? '✅ AGREES WITH MODEL' : '⚠️ DIFFERS FROM MODEL'}
                                        </span>
                                        <span className={`ai-confidence-badge ${String(entry.ai_analysis.confidence || '').toLowerCase()}`}>
                                          {entry.ai_analysis.confidence}
                                        </span>
                                      </div>
                                      <div className="dashboard-copy">{entry.ai_analysis.recommendation?.reasoning}</div>
                                      <div className="dashboard-copy">Value watch: {entry.ai_analysis.valueWatch?.runner || '—'} — {entry.ai_analysis.valueWatch?.reasoning || 'No note'}</div>
                                      <div className="dashboard-copy">Race dynamic: {entry.ai_analysis.raceDynamic}</div>
                                      {entry.ai_analysis.concerns && <div className="ai-concerns-box compact">{entry.ai_analysis.concerns}</div>}
                                    </div>
                                  )}

                                  <pre className="journal-summary">{entry.raw_data_summary}</pre>
                                </div>
                              )}
                            </article>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="empty-state-card">No journal entries saved yet.</div>
                    )}
                  </section>
                )}

                {dashboardTab === 'sourceHealth' && (
                  <section className="dashboard-card">
                    <div className="tab-toolbar">
                      <div>
                        <div className="section-title">Source Health</div>
                        <div className="dashboard-copy">Seven-day view of scraper reliability, latency, and the latest observed failures by source.</div>
                      </div>
                      <button className="panel-button secondary" onClick={loadScraperHealth} disabled={healthLoading}>
                        {healthLoading ? 'REFRESHING...' : 'REFRESH HEALTH'}
                      </button>
                    </div>

                    <div className="table-shell">
                      <table className="health-table">
                        <thead>
                          <tr>
                            <th>Source</th>
                            <th>Success Rate</th>
                            <th>Avg Response</th>
                            <th>Last Error</th>
                            <th>Last Checked</th>
                          </tr>
                        </thead>
                        <tbody>
                          {scraperHealth.map(row => (
                            <tr key={row.source_name}>
                              <td>{row.display_name || HEALTH_SOURCE_LABELS[row.source_name] || row.source_name}</td>
                              <td><span className={`health-rate ${getHealthTone(row)}`}>{row.total_attempts ? `${row.success_rate_pct}%` : '—'}</span></td>
                              <td>{row.average_response_time_ms != null ? `${row.average_response_time_ms} ms` : '—'}</td>
                              <td title={row.last_seen_error || 'No recent errors'}>{truncateText(row.last_seen_error)}</td>
                              <td>{formatCheckedAt(row.last_checked)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </section>
                )}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
