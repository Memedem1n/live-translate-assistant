import { describe, expect, it } from 'vitest'
import { buildLatencySummary, percentile } from './latencyStats'

describe('percentile', () => {
  it('returns null for empty values', () => {
    expect(percentile([], 0.5)).toBeNull()
  })

  it('computes percentile using sorted ceiling index', () => {
    const values = [100, 20, 300, 80, 50]
    expect(percentile(values, 0.5)).toBe(80)
    expect(percentile(values, 0.95)).toBe(300)
  })
})

describe('buildLatencySummary', () => {
  it('builds summary with latest, p50, p95 and count', () => {
    const summary = buildLatencySummary([10, 20, 30, 40, 50])
    expect(summary).toEqual({
      latest: 50,
      p50: 30,
      p95: 50,
      count: 5
    })
  })

  it('returns empty summary for no values', () => {
    const summary = buildLatencySummary([])
    expect(summary).toEqual({
      latest: null,
      p50: null,
      p95: null,
      count: 0
    })
  })
})
