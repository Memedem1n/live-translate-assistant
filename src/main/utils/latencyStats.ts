import { LatencyStatSummary } from '../../shared/contracts'

export function percentile(values: number[], ratio: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return Number(sorted[idx].toFixed(2))
}

export function buildLatencySummary(values: number[]): LatencyStatSummary {
  const latest = values.length > 0 ? Number(values[values.length - 1].toFixed(2)) : null
  return {
    latest,
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    count: values.length
  }
}
