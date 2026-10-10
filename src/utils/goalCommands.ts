export type GoalCommand = { action: 'show' | 'pause' | 'resume' | 'clear' } | { action: 'set'; objective: string }

export function parseGoalCommand(text: string): GoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return null
  const argument = (match[1] ?? '').trim().replace(/^(?:\$[\w-]+\s+)+/, '').trim()
  if (!argument) return { action: 'show' }
  if (argument === 'pause' || argument === 'resume' || argument === 'clear') return { action: argument }
  if (argument.length > 4000) throw new Error('Goal objectives must be at most 4,000 characters')
  return { action: 'set', objective: argument }
}
