const NATIVE_TURN_ID = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[\da-f]{4}-[\da-f]{12}$/i

export function mergeThreadTurnOrder(older: string[], newer: string[]): string[] {
  const combined = [...new Set([...older, ...newer])]
  const ordered = [...new Set(newer)]
  const pending: string[] = []
  let lastAnchor = ''
  for (const turnId of new Set(older)) {
    const position = ordered.indexOf(turnId)
    if (position < 0) {
      pending.push(turnId)
      continue
    }
    ordered.splice(position, 0, ...pending)
    pending.length = 0
    lastAnchor = turnId
  }
  const insertionIndex = lastAnchor ? ordered.indexOf(lastAnchor) + 1 : 0
  ordered.splice(insertionIndex, 0, ...pending)
  if (combined.every(turnId => NATIVE_TURN_ID.test(turnId))) {
    const timestamp = (turnId: string) => Number.parseInt(turnId.replace(/-/g, '').slice(0, 12), 16)
    return ordered.sort((first, second) => timestamp(first) - timestamp(second))
  }
  return ordered
}
