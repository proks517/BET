import { useCallback, useEffect, useRef, useState } from 'react'
import '../App.css'
import capabilityMatrix from '../../shared/capabilities.json'
import {
  checkResults,
  createBestBetsStream,
  getBets,
  pingHealth,
  placeBet,
  updateBetResult,
} from './api/client'

const MODE_SECTIONS = [
  { key: 'safest', title: 'Safest', subtitle: 'Best chance of landing cleanly.' },
  { key: 'value', title: 'Value', subtitle: 'Strong overlays against the current market.' },
  { key: 'longshot', title: 'Longshot', subtitle: 'Rougher prices with enough upside to justify the swing.' },
]

const DEFAULT_SUMMARY = {
  totalBets: 0,
  settledBets: 0,
  pendingBets: 0,
  wins: 0,
  losses: 0,
  strikeRate: 0,
  totalPnl: 0,
  totalStaked: 0,
  roi: 0,
}

function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(new Date())
}

function formatOdds(value) {
  return value != null ? `$${Number(value).toFixed(2)}` : 'Odds TBC'
}

function formatCurrency(value) {
  const numeric = Number(value) || 0
  return `${numeric >= 0 ? '+' : '-'}$${Math.abs(numeric).toFixed(2)}`
}

function formatPlacedAt(value) {
  if (!value) return 'Not yet placed'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString('en-AU', {
    timeZone: 'Australia/Sydney',
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function getPickKey(pick) {
  return `${pick.mode}-${pick.track}-${pick.raceNumber}-${pick.runnerName}`
}

function formatTrackList(tracks = []) {
  if (!tracks.length) return ''
  return tracks.join(', ')
}

export default function App() {
  const [scanDate, setScanDate] = useState(todayStr())
  const [scanLoading, setScanLoading] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [scanLog, setScanLog] = useState([])
  const [scanProgress, setScanProgress] = useState({
    totalMeetings: 0,
    totalRacesScanned: 0,
    currentTrack: '',
  })
  const [bets, setBets] = useState([])
  const [summary, setSummary] = useState(DEFAULT_SUMMARY)
  const [serverConnected, setServerConnected] = useState(false)
  const [checkingResults, setCheckingResults] = useState(false)
  const [placingPickKey, setPlacingPickKey] = useState(null)
  const [stakeValue, setStakeValue] = useState(() => {
    try {
      return localStorage.getItem('raceedge-stake') || '10'
    } catch {
      return '10'
    }
  })
  const [confirmedOdds, setConfirmedOdds] = useState('')
  const [placingBet, setPlacingBet] = useState(false)
  const [resultOddsDrafts, setResultOddsDrafts] = useState({})
  const [savingResultId, setSavingResultId] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const bestBetsStreamRef = useRef(null)

  const appendScanLog = useCallback(message => {
    setScanLog(current => [...current.slice(-15), message])
  }, [])

  const loadBets = useCallback(async () => {
    try {
      const response = await getBets()
      setBets(response.bets || [])
      setSummary(response.summary || DEFAULT_SUMMARY)
      setResultOddsDrafts(current => {
        const next = { ...current }
        for (const bet of response.bets || []) {
          if (next[bet.id] == null) {
            next[bet.id] = bet.confirmedOdds != null ? String(bet.confirmedOdds) : ''
          }
        }
        return next
      })
    } catch (err) {
      setError(err.message)
    }
  }, [])

  const closeStream = useCallback(() => {
    if (bestBetsStreamRef.current) {
      bestBetsStreamRef.current.close()
      bestBetsStreamRef.current = null
    }
  }, [])

  useEffect(() => {
    loadBets()
  }, [loadBets])

  useEffect(() => {
    let cancelled = false

    async function refreshHealth() {
      const alive = await pingHealth()
      if (!cancelled) {
        setServerConnected(alive)
      }
    }

    refreshHealth()
    const intervalId = setInterval(refreshHealth, 20000)
    return () => {
      cancelled = true
      clearInterval(intervalId)
    }
  }, [])

  useEffect(() => () => closeStream(), [closeStream])

  useEffect(() => {
    if (!error) return undefined
    const timeoutId = setTimeout(() => setError(''), 6000)
    return () => clearTimeout(timeoutId)
  }, [error])

  useEffect(() => {
    if (!notice) return undefined
    const timeoutId = setTimeout(() => setNotice(''), 4500)
    return () => clearTimeout(timeoutId)
  }, [notice])

  async function handleRunScan() {
    closeStream()
    setError('')
    setNotice('')
    setScanLoading(true)
    setScanResult(null)
    setScanLog([])
    setScanProgress({ totalMeetings: 0, totalRacesScanned: 0, currentTrack: '' })

    const stream = createBestBetsStream({ date: scanDate, type: 'greyhound' })
    bestBetsStreamRef.current = stream
    let completed = false

    stream.onmessage = event => {
      const payload = JSON.parse(event.data)

      if (payload.type === 'scan_start') {
        appendScanLog(`Scan started for ${scanDate}.`)
        setScanProgress(current => ({
          ...current,
          totalMeetings: payload.totalMeetings || 0,
        }))
        return
      }

      if (payload.type === 'meeting_start') {
        appendScanLog(`Scanning ${payload.track} (${payload.raceCount} races).`)
        setScanProgress(current => ({
          ...current,
          currentTrack: payload.track || '',
        }))
        return
      }

      if (payload.type === 'race_done') {
        setScanProgress(current => ({
          ...current,
          currentTrack: payload.track || current.currentTrack,
          totalRacesScanned: payload.totalRacesScanned || current.totalRacesScanned,
          totalMeetings: payload.totalMeetings || current.totalMeetings,
        }))
        return
      }

      if (payload.type === 'meeting_done') {
        appendScanLog(`Finished ${payload.track}.`)
        setScanProgress(current => ({
          ...current,
          currentTrack: payload.track || current.currentTrack,
          totalRacesScanned: payload.totalRacesScanned || current.totalRacesScanned,
          totalMeetings: payload.totalMeetings || current.totalMeetings,
        }))
        return
      }

      if (payload.type === 'complete') {
        completed = true
        closeStream()
        setScanLoading(false)
        setScanResult(payload)
        if ((payload.totalMeetings || 0) === 0) {
          setNotice(payload.meetingDiagnostics?.reason || `No greyhound meetings were found for ${scanDate}.`)
          setScanProgress(current => ({
            ...current,
            currentTrack: 'No meetings found',
          }))
          appendScanLog(payload.meetingDiagnostics?.reason || `No greyhound meetings found for ${scanDate}.`)
        } else if ((payload.meetingDiagnostics?.skippedPastCount || 0) > 0 || (payload.meetingDiagnostics?.skippedMissingTimeCount || 0) > 0) {
          setNotice(payload.meetingDiagnostics?.reason || '')
          appendScanLog(payload.meetingDiagnostics?.reason || 'Same-day upcoming filter skipped some meetings.')
        } else {
          appendScanLog(`Scan complete: ${payload.totalRacesScanned} races assessed.`)
        }
        return
      }

      if (payload.type === 'error') {
        completed = true
        closeStream()
        setScanLoading(false)
        setError(payload.message || 'Scan failed')
      }
    }

    stream.onerror = () => {
      if (completed) return
      closeStream()
      setScanLoading(false)
      setError('Scan stream disconnected before completion')
    }
  }

  function openStakeForm(pick) {
    setPlacingPickKey(getPickKey(pick))
    setConfirmedOdds(pick.decimalOdds != null ? String(pick.decimalOdds) : '')
  }

  function closeStakeForm() {
    setPlacingPickKey(null)
    setConfirmedOdds('')
  }

  async function handlePlaceBet(pick) {
    const parsedStake = Number(stakeValue)
    const parsedOdds = Number(confirmedOdds)

    if (!Number.isFinite(parsedStake) || parsedStake <= 0) {
      setError('Stake must be a positive number')
      return
    }

    if (!Number.isFinite(parsedOdds) || parsedOdds <= 0) {
      setError('Confirmed odds must be a positive number')
      return
    }

    setPlacingBet(true)
    try {
      await placeBet({
        date: scanResult.date,
        track: pick.track,
        raceNumber: pick.raceNumber,
        raceType: 'greyhound',
        raceGrade: pick.grade,
        raceDistance: pick.distance,
        runnerName: pick.runnerName,
        box: pick.box,
        mode: pick.mode,
        confidence: pick.confidence,
        stake: parsedStake,
        confirmedOdds: parsedOdds,
        oddsSource: 'confirmed',
        winProbability: pick.winProbability,
        ev: pick.ev,
        expectedReturn: pick.expectedReturn,
      })

      try {
        localStorage.setItem('raceedge-stake', String(parsedStake))
      } catch {}

      await loadBets()
      closeStakeForm()
      setNotice(`${pick.runnerName} recorded in the bet ledger.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setPlacingBet(false)
    }
  }

  async function handleCheckResults() {
    setCheckingResults(true)
    try {
      const summaryResponse = await checkResults()
      await loadBets()
      setNotice(`Checked ${summaryResponse.checked} bets and resolved ${summaryResponse.resolved}.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setCheckingResults(false)
    }
  }

  async function handleManualResult(bet, result) {
    const draftOdds = Number(resultOddsDrafts[bet.id])
    const odds = result === 'win'
      ? (Number.isFinite(draftOdds) && draftOdds > 0 ? draftOdds : bet.confirmedOdds)
      : null

    if (result === 'win' && (!Number.isFinite(Number(odds)) || Number(odds) <= 0)) {
      setError('A winning result needs confirmed odds.')
      return
    }

    setSavingResultId(bet.id)
    try {
      await updateBetResult(bet.id, { result, odds })
      await loadBets()
      setNotice(`${bet.runnerName} marked as ${result}.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setSavingResultId(null)
    }
  }

  return (
    <div className="simple-app-shell">
      <header className="hero-shell">
        <div>
          <p className="eyebrow">Greyhound-first scan workflow</p>
          <h1>RaceEdge</h1>
          <p className="hero-copy">
            Scan the day, review the top 5 bets in each class, confirm what you actually place,
            and let the ledger track P/L with auto-settlement plus manual override.
          </p>
        </div>
        <div className="hero-status-stack">
          <div className={`connection-chip ${serverConnected ? 'online' : 'offline'}`}>
            <span className="connection-dot" />
            <span>{serverConnected ? 'API connected' : 'API offline'}</span>
          </div>
          <div className="release-note">
            <strong>{capabilityMatrix.release.title}</strong>
            <span>{capabilityMatrix.release.summary}</span>
          </div>
          <div className="release-note warning">
            <strong>Experimental sources stay visible</strong>
            <span>Amber warnings appear whenever experimental sources help build a pick.</span>
          </div>
        </div>
      </header>

      {(error || notice) && (
        <div className={`status-banner ${error ? 'error' : 'success'}`}>
          {error || notice}
        </div>
      )}

      <main className="single-screen-layout">
        <section className="app-card scan-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Step 1</p>
              <h2>Scan Day</h2>
            </div>
            <button className="secondary-button" onClick={handleCheckResults} disabled={checkingResults}>
              {checkingResults ? 'Checking results...' : 'Check results'}
            </button>
          </div>

          <div className="scan-controls">
            <label>
              <span>Scan date</span>
              <input type="date" value={scanDate} onChange={event => setScanDate(event.target.value)} />
            </label>

            <div className="scan-mode-chip">Greyhounds only for this version</div>

            <button className="primary-button" onClick={handleRunScan} disabled={scanLoading}>
              {scanLoading ? 'Scanning the day...' : 'Run scan'}
            </button>
          </div>

          <div className="scan-summary-row">
            <span>{scanProgress.totalMeetings || 0} meetings queued</span>
            <span>{scanProgress.totalRacesScanned || 0} races scanned</span>
            <span>{scanProgress.currentTrack || 'Waiting to start'}</span>
          </div>

          {(scanLoading || scanLog.length > 0) && (
            <div className="scan-log-shell">
              <div className="section-subtitle">Live scan feed</div>
              <div className="scan-log-list">
                {scanLog.map((entry, index) => (
                  <div key={`${entry}-${index}`} className="scan-log-line">{entry}</div>
                ))}
              </div>
            </div>
          )}

          {scanResult?.meetingDiagnostics && (
            scanResult.totalMeetings === 0 ||
            (scanResult.meetingDiagnostics.skippedPastCount || 0) > 0 ||
            (scanResult.meetingDiagnostics.skippedMissingTimeCount || 0) > 0
          ) && (
            <div className="scan-diagnostics">
              <div className="section-subtitle">Scan diagnostics</div>
              <p>{scanResult.meetingDiagnostics.reason}</p>
              {scanResult.meetingDiagnostics.note && (
                <p>{scanResult.meetingDiagnostics.note}</p>
              )}
              <p>
                Source matched {scanResult.meetingDiagnostics.matchedDateCount || 0} meetings for {scanResult.date}.
                Kept {scanResult.meetingDiagnostics.keptCount || 0}.
                Skipped {scanResult.meetingDiagnostics.skippedPastCount || 0} already-started meetings
                and {scanResult.meetingDiagnostics.skippedMissingTimeCount || 0} meetings with no reliable first listed race time.
              </p>
              {scanResult.meetingDiagnostics.currentDate === scanResult.date && (
                <p>
                  Same-day comparison used {scanResult.meetingDiagnostics.currentTime} in {scanResult.meetingDiagnostics.timezone}.
                </p>
              )}
              {!!scanResult.meetingDiagnostics.skippedPastTracks?.length && (
                <p>Skipped as already started: {formatTrackList(scanResult.meetingDiagnostics.skippedPastTracks)}</p>
              )}
              {!!scanResult.meetingDiagnostics.skippedMissingTimeTracks?.length && (
                <p>Skipped because time was unavailable: {formatTrackList(scanResult.meetingDiagnostics.skippedMissingTimeTracks)}</p>
              )}
            </div>
          )}
        </section>

        <section className="app-card board-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Step 2</p>
              <h2>Best Bets Board</h2>
            </div>
            {scanResult && (
              <div className="board-meta">
                <span>{scanResult.totalMeetings} meetings</span>
                <span>{scanResult.totalRacesScanned} races</span>
                <span>{formatPlacedAt(scanResult.generatedAt)}</span>
              </div>
            )}
          </div>

          {!scanResult && !scanLoading && (
            <div className="empty-state">
              Run the day scan to populate the safest, value, and longshot boards.
            </div>
          )}

          <div className="mode-board-grid">
            {MODE_SECTIONS.map(section => {
              const picks = scanResult?.picks?.[section.key] || []

              return (
                <article key={section.key} className="mode-column">
                  <div className="mode-column-head">
                    <div>
                      <h3>{section.title}</h3>
                      <p>{section.subtitle}</p>
                    </div>
                    <span className={`mode-chip ${section.key}`}>{picks.length} picks</span>
                  </div>

                  {picks.length === 0 ? (
                    <div className="empty-state compact">No picks available yet.</div>
                  ) : (
                    <div className="pick-stack">
                      {picks.map(pick => {
                        const pickKey = getPickKey(pick)
                        const isPlacing = placingPickKey === pickKey

                        return (
                          <div key={pickKey} className="pick-card">
                            <div className="pick-head">
                              <div>
                                <div className="pick-rank">#{pick.rank} {pick.track} R{pick.raceNumber}</div>
                                <div className="pick-runner">{pick.runnerName}</div>
                              </div>
                              <div className="pick-box">{pick.box != null ? `Box ${pick.box}` : 'Box TBC'}</div>
                            </div>

                            <div className="pick-metrics">
                              <span>{formatOdds(pick.decimalOdds)}</span>
                              <span>{pick.confidence}% confidence</span>
                              <span>{pick.confidenceLabel}</span>
                            </div>

                            {pick.experimentalWarning && (
                              <div className="warning-strip">Experimental sources contributed to this pick.</div>
                            )}

                            <div className="source-badge-row">
                              {pick.sourceBadges.map(source => (
                                <span
                                  key={`${pickKey}-${source.sourceName}`}
                                  className={`source-badge ${source.trustStatus}`}
                                  title={source.note}
                                >
                                  {source.displayName} · {source.trustLabel}
                                </span>
                              ))}
                            </div>

                            <button className="stake-button" onClick={() => openStakeForm(pick)}>
                              Stake
                            </button>

                            {isPlacing && (
                              <div className="stake-form">
                                <label>
                                  <span>Stake amount</span>
                                  <input type="number" min="0.01" step="0.01" value={stakeValue} onChange={event => setStakeValue(event.target.value)} />
                                </label>
                                <label>
                                  <span>Confirmed odds</span>
                                  <input type="number" min="1.01" step="0.01" value={confirmedOdds} onChange={event => setConfirmedOdds(event.target.value)} />
                                </label>
                                <div className="form-actions">
                                  <button className="primary-button" onClick={() => handlePlaceBet(pick)} disabled={placingBet}>
                                    {placingBet ? 'Saving...' : 'Confirm bet'}
                                  </button>
                                  <button className="ghost-button" onClick={closeStakeForm} disabled={placingBet}>
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </article>
              )
            })}
          </div>
        </section>

        <section className="app-card ledger-card">
          <div className="section-head">
            <div>
              <p className="eyebrow">Step 3 and 4</p>
              <h2>Placed Bet Ledger</h2>
            </div>
            <div className="board-meta">
              <span>{summary.pendingBets} pending</span>
              <span>{summary.wins} wins</span>
              <span>{summary.losses} losses</span>
            </div>
          </div>

          <div className="ledger-summary-grid">
            <div className="summary-card">
              <span>Total bets</span>
              <strong>{summary.totalBets}</strong>
            </div>
            <div className="summary-card">
              <span>Strike rate</span>
              <strong>{summary.strikeRate}%</strong>
            </div>
            <div className="summary-card">
              <span>Total staked</span>
              <strong>${Number(summary.totalStaked || 0).toFixed(2)}</strong>
            </div>
            <div className="summary-card">
              <span>Total P/L</span>
              <strong className={(summary.totalPnl || 0) >= 0 ? 'positive' : 'negative'}>
                {formatCurrency(summary.totalPnl || 0)}
              </strong>
            </div>
          </div>

          {bets.length === 0 ? (
            <div className="empty-state">No confirmed bets yet. Stake a pick from the board to start the ledger.</div>
          ) : (
            <div className="ledger-stack">
              {bets.map(bet => (
                <article key={bet.id} className="ledger-entry">
                  <div className="ledger-entry-head">
                    <div>
                      <div className="pick-rank">{bet.track} R{bet.raceNumber} · {bet.mode}</div>
                      <div className="pick-runner">{bet.runnerName}</div>
                    </div>
                    <div className={`ledger-result ${bet.result}`}>{bet.result}</div>
                  </div>

                  <div className="ledger-metrics">
                    <span>Placed {formatPlacedAt(bet.placedAt)}</span>
                    <span>Stake ${Number(bet.stake || 0).toFixed(2)}</span>
                    <span>{formatOdds(bet.confirmedOdds)}</span>
                    <span className={bet.pnl == null ? '' : bet.pnl >= 0 ? 'positive' : 'negative'}>
                      {bet.pnl == null ? 'P/L pending' : formatCurrency(bet.pnl)}
                    </span>
                  </div>

                  <div className="ledger-override-row">
                    <label>
                      <span>Win odds override</span>
                      <input
                        type="number"
                        min="1.01"
                        step="0.01"
                        value={resultOddsDrafts[bet.id] ?? ''}
                        onChange={event => setResultOddsDrafts(current => ({
                          ...current,
                          [bet.id]: event.target.value,
                        }))}
                      />
                    </label>
                    <div className="result-action-row">
                      <button className="settle-button win" onClick={() => handleManualResult(bet, 'win')} disabled={savingResultId === bet.id}>Win</button>
                      <button className="settle-button loss" onClick={() => handleManualResult(bet, 'loss')} disabled={savingResultId === bet.id}>Loss</button>
                      <button className="settle-button scratched" onClick={() => handleManualResult(bet, 'scratched')} disabled={savingResultId === bet.id}>Scratched</button>
                    </div>
                  </div>

                  {bet.resolvedAutomatically && (
                    <div className="auto-note">
                      Auto-settled from result scraping. Manual buttons above will override it.
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  )
}
