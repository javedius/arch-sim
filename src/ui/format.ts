export function fmtNum(x: number, digits = 1): string {
  if (!Number.isFinite(x)) return '∞'
  const a = Math.abs(x)
  if (a >= 1e9) return (x / 1e9).toFixed(digits) + 'B'
  if (a >= 1e6) return (x / 1e6).toFixed(digits) + 'M'
  if (a >= 1e4) return (x / 1e3).toFixed(0) + 'k'
  if (a >= 1e3) return (x / 1e3).toFixed(digits) + 'k'
  if (a >= 100) return x.toFixed(0)
  if (a >= 10) return x.toFixed(1).replace(/\.0$/, '')
  return x.toFixed(2).replace(/\.?0+$/, '') || '0'
}
export function fmtMs(ms: number): string {
  if (!Number.isFinite(ms)) return '∞'
  if (ms >= 10000) return (ms / 1000).toFixed(0) + ' с'
  if (ms >= 1000) return (ms / 1000).toFixed(2) + ' с'
  return ms.toFixed(ms < 10 ? 1 : 0) + ' мс'
}
export function fmtMoney(x: number): string {
  return '$' + Math.round(x).toLocaleString('ru-RU')
}
export function fmtPct(x: number, d = 1): string {
  return (x * 100).toFixed(d).replace(/\.0$/, '') + '%'
}
export const STATUS_COLOR: Record<string, string> = {
  idle: '#64748b',
  ok: '#22c55e',
  warn: '#eab308',
  hot: '#ef4444',
  down: '#7f1d1d',
}
