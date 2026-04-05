import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import App from './App'

function buildFetchMock() {
  return vi.fn().mockImplementation(async (url, options = {}) => {
    if (url === '/api/health') {
      return {
        ok: true,
        json: async () => ({ status: 'ok' }),
      }
    }

    if (url === '/api/bets') {
      return {
        ok: true,
        json: async () => ({
          bets: [],
          summary: {
            totalBets: 0,
            settledBets: 0,
            pendingBets: 0,
            wins: 0,
            losses: 0,
            strikeRate: 0,
            totalPnl: 0,
            totalStaked: 0,
            roi: 0,
          },
        }),
      }
    }

    if (url === '/api/check-results' || (url === '/api/bets' && options.method === 'POST')) {
      return {
        ok: true,
        json: async () => ({}),
      }
    }

    throw new Error(`Unhandled fetch call: ${url}`)
  })
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('App', () => {
  it('renders the single-screen scan workflow and keeps horse controls hidden', async () => {
    const fetchMock = buildFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    render(<App />)

    expect(await screen.findByText('Scan Day')).toBeTruthy()
    expect(screen.getByText('Best Bets Board')).toBeTruthy()
    expect(screen.getByText('Placed Bet Ledger')).toBeTruthy()
    expect(screen.queryByText(/HORSES/i)).toBeNull()
  })

  it('shows scan results with experimental warnings and opens the stake form', async () => {
    const fetchMock = buildFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    let latestStream = null

    class MockEventSource {
      constructor(url) {
        this.url = url
        latestStream = this
      }

      close() {}
    }

    vi.stubGlobal('EventSource', MockEventSource)

    render(<App />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Run scan' }))[0])

    expect(latestStream.url).toContain('/api/best-bets/stream?date=')
    expect(latestStream.url).toContain('type=greyhound')

    latestStream.onmessage({
      data: JSON.stringify({
        type: 'complete',
        date: '2026-03-31',
        totalMeetings: 2,
        totalRacesScanned: 12,
        generatedAt: '2026-03-31T01:00:00.000Z',
        picks: {
          safest: [{
            mode: 'safest',
            rank: 1,
            track: 'Richmond',
            raceNumber: 5,
            runnerName: 'Fast Dog',
            box: 1,
            decimalOdds: 2.8,
            confidence: 81,
            confidenceLabel: 'High',
            sourceBadges: [{
              sourceName: 'grv.org.au',
              displayName: 'GRV',
              trustStatus: 'experimental',
              trustLabel: 'Experimental',
              note: 'Sparse coverage.',
            }],
            experimentalWarning: true,
          }],
          value: [],
          longshot: [],
        },
      }),
    })

    expect(await screen.findByText('Fast Dog')).toBeTruthy()
    expect(screen.getByText('Experimental sources contributed to this pick.')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Stake' }))

    await waitFor(() => {
      expect(screen.getByText('Stake amount')).toBeTruthy()
      expect(screen.getByText('Confirmed odds')).toBeTruthy()
    })
  })

  it('shows no-meetings diagnostics when a scan finishes empty', async () => {
    const fetchMock = buildFetchMock()
    vi.stubGlobal('fetch', fetchMock)

    let latestStream = null

    class MockEventSource {
      constructor(url) {
        this.url = url
        latestStream = this
      }

      close() {}
    }

    vi.stubGlobal('EventSource', MockEventSource)

    render(<App />)

    fireEvent.click((await screen.findAllByRole('button', { name: 'Run scan' }))[0])

    latestStream.onmessage({
      data: JSON.stringify({
        type: 'complete',
        date: '2026-03-31',
        totalMeetings: 0,
        totalRacesScanned: 0,
        generatedAt: '2026-03-31T01:00:00.000Z',
        meetingDiagnostics: {
          selectedDate: '2026-03-31',
          currentDate: '2026-03-31',
          currentTime: '18:30',
          timezone: 'Australia/Sydney',
          matchedDateCount: 2,
          keptCount: 0,
          skippedPastCount: 1,
          skippedMissingTimeCount: 1,
          skippedPastTracks: ['Richmond'],
          skippedMissingTimeTracks: ['Wentworth Park'],
          upcomingOnlyApplied: true,
          filterBasis: 'meeting_first_race_time',
          reason: 'Matched meetings were excluded because some had already started and others had no reliable first listed race time for same-day filtering.',
          note: 'Same-day filtering currently uses each meeting\'s first listed race time because the meeting source does not expose reliable race-by-race start times at this stage.',
        },
        picks: {
          safest: [],
          value: [],
          longshot: [],
        },
      }),
    })

    expect((await screen.findAllByText(/Matched meetings were excluded because some had already started/)).length).toBeGreaterThan(0)
    expect(screen.getByText(/Same-day comparison used 18:30 in Australia\/Sydney/)).toBeTruthy()
    expect(screen.getByText(/Skipped as already started: Richmond/)).toBeTruthy()
    expect(screen.getByText(/Skipped because time was unavailable: Wentworth Park/)).toBeTruthy()
  })
})
