import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBestBetsStream, getBets, placeBet, updateBetResult } from './client'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createBestBetsStream', () => {
  it('opens the best-bets SSE stream with the requested params', () => {
    class MockEventSource {
      constructor(url) {
        this.url = url
      }
    }

    vi.stubGlobal('EventSource', MockEventSource)

    const stream = createBestBetsStream({
      date: '2026-03-31',
      type: 'greyhound',
    })

    expect(stream.url).toBe('/api/best-bets/stream?date=2026-03-31&type=greyhound')
  })
})

describe('bet ledger api helpers', () => {
  it('loads the bet ledger', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bets: [], summary: { totalBets: 0 } }),
    })

    vi.stubGlobal('fetch', fetchMock)

    const payload = await getBets()

    expect(fetchMock).toHaveBeenCalledWith('/api/bets', {})
    expect(payload.summary.totalBets).toBe(0)
  })

  it('creates a placed bet', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bet: { id: 7 } }),
    })

    vi.stubGlobal('fetch', fetchMock)

    await placeBet({ runnerName: 'Fast Dog', stake: 10, confirmedOdds: 3.1 })

    expect(fetchMock).toHaveBeenCalledWith('/api/bets', expect.objectContaining({
      method: 'POST',
    }))
  })

  it('updates a recorded bet result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ bet: { id: 4, result: 'win' } }),
    })

    vi.stubGlobal('fetch', fetchMock)

    await updateBetResult(4, { result: 'win', odds: 3.4 })

    expect(fetchMock).toHaveBeenCalledWith('/api/bets/4', expect.objectContaining({
      method: 'PATCH',
    }))
  })
})
