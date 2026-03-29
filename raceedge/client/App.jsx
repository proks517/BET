import { useState, useEffect, useCallback } from 'react'
import './App.css'
import ReactDOM from 'react-dom/client'

const SOURCES = {
  greyhound: ['thedogs.com.au', 'racingandsports.com.au', 'grv.org.au', 'tab.com.au', 'thegreyhoundrecorder.com.au', 'gbota.com.au'],
  horse:     ['racingaustralia.horse', 'racingandsports.com.au', 'tab.com.au', 'racenet.com.au', 'punters.com.au'],
}

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

function getHealthTone(row) {
  if (!row.total_attempts) return 'unknown'
  if (row.success_rate_pct > 70) return 'good'
  if (row.success_rate_pct >= 40) return 'warn'
  return 'bad'
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

function App() {
  // Controls
  const [date,       setDate]       = useState(todayStr())
  const [raceType,   setRaceType]   = useState('greyhound')
  const [meetings,   setMeetings]   = useState([])
  const [meeting,    setMeeting]    = useState('')
  const [raceNum,    setRaceNum]    = useState(1)
  const [mode,       setMode]       = useState('safest')
  const [stake,      setStake]      = useState(() => parseFloat(localStorage.getItem('raceedge-stake')) || 10)

  // UI
  const [loading,    setLoading]    = useState(false)
  const [loadMsg,    setLoadMsg]    = useState('')
  const [activeSourceIdx, setActiveSourceIdx] = useState(-1)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState('')
  const [theme,      setTheme]      = useState(() => localStorage.getItem('raceedge-theme') || 'dark')

  // Record result
  const [odds,       setOdds]       = useState('')
  const [recording,  setRecording]  = useState(false)
  const [recorded,   setRecorded]   = useState(false)

  // Stats
  const [stats,      setStats]      = useState(null)
  const [scraperHealth, setScraperHealth] = useState(() => mergeScraperHealthRows())
  const [healthLoading, setHealthLoading] = useState(false)

  const loadStats = useCallback(() => {
    fetch('/api/stats').then(r => r.json()).then(setStats).catch(() => {})
  }, [])

  const loadScraperHealth = useCallback(() => {
    setHealthLoading(true)
    fetch('/api/scraper-health')
      .then(r => r.json())
      .then(data => setScraperHealth(mergeScraperHealthRows(data.sources || [])))
      .catch(() => {})
      .finally(() => setHealthLoading(false))
  }, [])

  useEffect(() => {
    loadStats()
    loadScraperHealth()
  }, [loadStats, loadScraperHealth])

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem('raceedge-theme', theme)
  }, [theme])

  useEffect(() => {
    if (!error) return
    const timer = setTimeout(() => setError(''), 8000)
    return () => clearTimeout(timer)
  }, [error])

  useEffect(() => {
    document.title = result
      ? `${result.runner} — RaceEdge`
      : 'RaceEdge — Racing Research & Predictions'
  }, [result])

  useEffect(() => {
    if (!date) return
    setMeeting('')
    fetch(`/api/meetings?date=${date}&type=${raceType}`)
      .then(r => r.json())
      .then(d => {
        setMeetings(d.meetings || [])
        if (d.meetings?.length) setMeeting(d.meetings[0])
      })
      .catch(() => {})
  }, [date, raceType])

  async function handleResearch() {
    if (!meeting) return
    setLoading(true)
    setError('')
    setResult(null)
    setRecorded(false)
    setOdds('')

    const srcs = SOURCES[raceType]
    const animPromise = (async () => {
      for (let i = 0; i < srcs.length; i++) {
        setActiveSourceIdx(i)
        setLoadMsg(`Checking ${srcs[i]}... (${i + 1}/${srcs.length})`)
        await new Promise(r => setTimeout(r, 600))
      }
      setLoadMsg('Analysing runners...')
      setActiveSourceIdx(srcs.length)
    })()

    try {
      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, meeting, raceNumber: raceNum, raceType, mode, stake }),
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
      loadScraperHealth()
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
    } catch (e) {
      setError(e.message)
    } finally {
      setRecording(false)
    }
  }

  return (
    <div className="app">
      <div className="app-header">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1>RaceEdge</h1>
            <div className="subtitle">Australian Racing Research &amp; Prediction Tracker</div>
          </div>
          <button className="theme-toggle" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? 'Light' : 'Dark'}
          </button>
        </div>
      </div>

      {/* ── Controls ─────────────────────────────────────── */}
      <div className="panel">
        <h2>Research a Race</h2>

        <div className="controls-grid">
          <label>
            Date
            <input type="date" value={date} onChange={e => setDate(e.target.value)} />
          </label>

          <label>
            Race Type
            <div className="toggle-group">
              <button className={`toggle-btn ${raceType === 'greyhound' ? 'active' : ''}`} onClick={() => setRaceType('greyhound')}>🐕 Greyhounds</button>
              <button className={`toggle-btn ${raceType === 'horse'     ? 'active' : ''}`} onClick={() => setRaceType('horse')}>🐎 Horses</button>
            </div>
          </label>

          <label>
            Meeting
            <select value={meeting} onChange={e => setMeeting(e.target.value)} disabled={!meetings.length}>
              {!meetings.length
                ? <option>Loading…</option>
                : meetings.map(m => <option key={m} value={m}>{m}</option>)
              }
            </select>
          </label>

          <label>
            Race #
            <select value={raceNum} onChange={e => setRaceNum(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map(n =>
                <option key={n} value={n}>Race {n}</option>
              )}
            </select>
          </label>

          <label>
            Stake ($)
            <input type="number" min="1" step="1" value={stake}
              onChange={e => { const v = parseFloat(e.target.value) || 10; setStake(v); localStorage.setItem('raceedge-stake', String(v)) }} />
          </label>
        </div>

        <label style={{ marginBottom: 16 }}>
          Prediction Mode
          <div className="mode-group">
            {[
              { key: 'safest',   label: '✅ Safest Bet'  },
              { key: 'value',    label: '💰 Best Value'  },
              { key: 'longshot', label: '🎲 Long Shot'   },
            ].map(({ key, label }) => (
              <button key={key} className={`mode-btn ${mode === key ? 'active ' + key : ''}`} onClick={() => setMode(key)}>
                {label}
              </button>
            ))}
          </div>
        </label>

        <button className="btn-primary" onClick={handleResearch} disabled={loading || !meeting}>
          {loading ? 'Researching…' : '🔍 Research & Pick'}
        </button>

        {loading && (
          <div className="loading-sources">
            {SOURCES[raceType].map((src, i) => (
              <div className={`source-item ${i < activeSourceIdx ? 'done' : i === activeSourceIdx ? 'active' : 'pending'}`} key={src}>
                <div className={i < activeSourceIdx ? 'check-icon' : i === activeSourceIdx ? 'spinner' : 'dot'} />
                <span>{src}</span>
              </div>
            ))}
            <div className="loading-msg">{loadMsg}</div>
          </div>
        )}
      </div>

      {error && (
        <div className="error-toast">
          <span>Warning: {error}</span>
          <button className="error-dismiss" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}

      {/* ── Result ───────────────────────────────────────── */}
      {result && !loading && (
        <div className="panel">
          <h2>Recommendation</h2>

          <div className="result-card">
            <div className="runner-name">{result.runner}</div>
            <div className="runner-meta">
              {result.box     && `Box ${result.box} · `}
              {result.barrier && `Barrier ${result.barrier} · `}
              {result.odds    && `$${result.odds.toFixed(2)} · `}
              {mode.charAt(0).toUpperCase() + mode.slice(1)} mode
            </div>

            <div className="confidence-wrap">
              <div className="confidence-label">Confidence: {Math.round(result.confidence * 100)}%</div>
              <div className="confidence-bar">
                <div className="confidence-fill" style={{ width: `${result.confidence * 100}%` }} />
              </div>
            </div>

            <div className="reasoning">{result.reasoning}</div>
          </div>

          {result.allScores?.length > 0 && (
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: 6 }}>All runners scored:</div>
              <table className="scores-table">
                <thead><tr><th>#</th><th>Runner</th><th>Score</th><th>Odds</th></tr></thead>
                <tbody>
                  {result.allScores.map((s, i) => (
                    <tr key={s.name} className={s.name === result.runner ? 'sel' : ''}>
                      <td>{i + 1}</td>
                      <td>{s.name}</td>
                      <td>{s.score}</td>
                      <td>{s.odds ? `$${s.odds.toFixed(2)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ marginBottom: 14 }}>
            <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: 6 }}>Sources:</div>
            <div className="sources-row">
              {result.sourcesUsed?.map(s    => <span key={s}         className="src-tag ok"  title="data received">✓ {s}</span>)}
              {result.sourcesSkipped?.map(s => <span key={s.source}  className="src-tag err" title={s.reason}>✗ {s.source}</span>)}
            </div>
            {result.warning && <div className="warning-box">⚠️ {result.warning}</div>}
          </div>

          {!recorded ? (
            <div>
              <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: 8 }}>Record outcome:</div>
              <div className="record-row">
                <div className="odds-input-wrap">
                  <span>Odds $</span>
                  <input
                    type="number" step="0.05" min="1"
                    placeholder={result.odds?.toFixed(2) ?? '2.50'}
                    value={odds}
                    onChange={e => setOdds(e.target.value)}
                  />
                </div>
                <button className="result-btn win"       onClick={() => handleRecord('win')}       disabled={recording}>✓ Win</button>
                <button className="result-btn loss"      onClick={() => handleRecord('loss')}      disabled={recording}>✗ Loss</button>
                <button className="result-btn scratched" onClick={() => handleRecord('scratched')} disabled={recording}>— Scratched</button>
              </div>
            </div>
          ) : (
            <div className="recorded-msg">✓ Result recorded</div>
          )}
        </div>
      )}

      {/* ── Stats Dashboard ───────────────────────────────── */}
      {stats && (
        <div className="panel">
          <h2>Stats Dashboard</h2>

          <div className="stats-grid">
            <div className="stat-card">
              <div className="stat-value">{stats.overall_win_rate}%</div>
              <div className="stat-label">Overall Win Rate</div>
            </div>
            <div className="stat-card">
              <div className={`stat-value ${stats.total_pnl >= 0 ? 'pnl-pos' : 'pnl-neg'}`}>
                {stats.total_pnl >= 0 ? '+' : ''}${stats.total_pnl.toFixed(2)}
              </div>
              <div className="stat-label">Total P&amp;L</div>
            </div>
            {stats.by_mode?.map(m => (
              <div key={m.mode} className="stat-card">
                <div className="stat-value">{m.win_rate}%</div>
                <div className="stat-label">{m.mode.charAt(0).toUpperCase() + m.mode.slice(1)} ({m.total} bets)</div>
              </div>
            ))}
            {stats.by_type?.map(t => (
              <div key={t.race_type} className="stat-card">
                <div className="stat-value">{t.win_rate}%</div>
                <div className="stat-label">{t.race_type === 'greyhound' ? '🐕' : '🐎'} {t.race_type} ({t.total})</div>
              </div>
            ))}
          </div>

          <div className="panel-toolbar">
            <div>
              <div className="subsection-title">Source Health</div>
              <div className="subsection-copy">Last 7 days of scraper performance</div>
            </div>
            <button className="refresh-btn" onClick={loadScraperHealth} disabled={healthLoading}>
              {healthLoading ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          <div className="health-table-wrap">
            <table className="health-table">
              <thead>
                <tr>
                  <th>Source</th>
                  <th>7-day success rate</th>
                  <th>Avg response</th>
                  <th>Last error</th>
                  <th>Last checked</th>
                </tr>
              </thead>
              <tbody>
                {scraperHealth.map(row => (
                  <tr key={row.source_name}>
                    <td>{row.display_name || HEALTH_SOURCE_LABELS[row.source_name] || row.source_name}</td>
                    <td>
                      <span className={`health-rate ${getHealthTone(row)}`}>
                        {row.total_attempts ? `${row.success_rate_pct}%` : '—'}
                      </span>
                    </td>
                    <td>{row.average_response_time_ms != null ? `${row.average_response_time_ms} ms` : '—'}</td>
                    <td title={row.last_seen_error || 'No recent errors'}>{truncateText(row.last_seen_error)}</td>
                    <td>{formatCheckedAt(row.last_checked)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {stats.last10?.length > 0 && (
            <>
              <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: 8 }}>Last 10 predictions</div>
              <div style={{ overflowX: 'auto' }}>
                <table className="preds-table">
                  <thead>
                    <tr><th>Date</th><th>Track</th><th>R</th><th>Runner</th><th>Mode</th><th>Odds</th><th>P&amp;L</th><th>Result</th></tr>
                  </thead>
                  <tbody>
                    {stats.last10.map(p => (
                      <tr key={p.id}>
                        <td>{p.date}</td>
                        <td>{p.track}</td>
                        <td>{p.race_number}</td>
                        <td>{p.runner}</td>
                        <td><span className={`badge ${p.mode}`}>{p.mode}</span></td>
                        <td>{p.odds ? `$${p.odds.toFixed(2)}` : '—'}</td>
                        <td style={{ color: p.pnl > 0 ? '#4ade80' : p.pnl < 0 ? '#f87171' : undefined }}>
                          {p.pnl != null ? `${p.pnl >= 0 ? '+' : ''}$${p.pnl.toFixed(2)}` : '—'}
                        </td>
                        <td><span className={`badge ${p.result}`}>{p.result}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />)
