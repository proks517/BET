async function jsonRequest(url, options = {}) {
  const response = await fetch(url, options)
  const data = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`)
  }

  return data
}

export function createBestBetsStream(params) {
  return new EventSource(`/api/best-bets/stream?${new URLSearchParams(params).toString()}`)
}

export async function pingHealth() {
  try {
    const response = await fetch('/api/health')
    if (!response.ok) return false
    await response.json().catch(() => null)
    return true
  } catch {
    return false
  }
}

export function getCapabilities() {
  return jsonRequest('/api/capabilities')
}

export function getBets() {
  return jsonRequest('/api/bets')
}

export function placeBet(payload) {
  return jsonRequest('/api/bets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function updateBetResult(betId, payload) {
  return jsonRequest(`/api/bets/${betId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
}

export function checkResults() {
  return jsonRequest('/api/check-results', { method: 'POST' })
}
