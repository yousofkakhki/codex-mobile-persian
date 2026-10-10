export function formatActivityDuration(seconds: number): string {
  if (seconds > 0 && seconds < 1) return '<1s'
  const duration = Math.max(0, Math.floor(seconds))
  if (duration < 60) return `${duration}s`
  if (duration < 3600) return `${Math.floor(duration / 60)}m ${duration % 60}s`
  return `${Math.floor(duration / 3600)}h ${Math.floor(duration % 3600 / 60)}m`
}
