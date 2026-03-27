import { useState, useEffect, useCallback } from 'react'
import './App.css'
import ReactDOM from 'react-dom/client'

const SOURCES = {
  greyhound: ['thedogs.com.au', 'racingandsports.com.au', 'grv.org.au', 'tab.com.au'],
  horse:     ['racingaustralia.horse', 'racingandsports.com.au', 'tab.com.au', 'racenet.com.au', 'punters.com.au'],
}

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

function App() {
  // Controls
  const [date,       setDate]       = useState(todayStr())
  const [raceType,   setRaceType]   = useState('greyhound')
  const [meetings,   setMeetings]   = useState([])
  const [meeting,    setMeeting]    = useState('')
  const [raceNum,    setRaceNum]    = useState(1)
  const [mode,       setMode]       = useState('safest')

  // UI
  const [loading,    setLoading]    = useState(false)
  const [loadMsg,    setLoadMsg]    = useState('')
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState('')

  // Record result
  const [odds,       setOdds]       = useState('')
  const [recording,  setRecording]  = useState(false)
  const [recorded,   setRecorded]   = useState(false)

  // Stats
  const [stats,      setStats]      = useState(null)

  const loadStats = useCallback(() => {
    fetch('/api/stats').then(r => r.json()).then(setStats).catch(() => {})
  }, [])

  useEffect(() => { loadStats() }, [loadStats])

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

    // Animate source checking
    const srcs = SOURCES[raceType]
    for (let i = 0; i < srcs.length; i++) {
      setLoadMsg(`Checking ${srcs[i]}… (${i + 1}/${srcs.length})`)
      await new Promise(r => setTimeout(r, 350))
    }
    setLoadMsg('Analysing runners…')

    try {
      const res = await fetch('/api/research', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date, meeting, raceNumber: raceNum, raceType, mode }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Research failed')
      setResult(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
      setLoadMsg('')
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
        <h1>RaceEdge</h1>
        <div className="subtitle">Australian Racing Research &amp; Prediction Tracker</div>
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
            {SOURCES[raceType].map(src => (
              <div className="source-item" key={src}>
                <div className="spinner" />
                <span>{src}</span>
              </div>
            ))}
            <div className="loading-msg">{loadMsg}</div>
          </div>
        )}
      </div>

      {error && <div className="error-msg">⚠️ {error}</div>}

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
              <div className="stat-label">Total P&amp;L ($10 stake)</div>
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
