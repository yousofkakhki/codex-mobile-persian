import { describe, expect, it } from 'vitest'
import { parseGoalCommand } from './goalCommands'

describe('goal commands', () => {
  it('recognizes only complete goal commands and keeps multiline objectives', () => {
    expect(parseGoalCommand('/goal')).toEqual({ action: 'show' })
    expect(parseGoalCommand('/goal pause')).toEqual({ action: 'pause' })
    expect(parseGoalCommand('/goal resume')).toEqual({ action: 'resume' })
    expect(parseGoalCommand('/goal clear')).toEqual({ action: 'clear' })
    expect(parseGoalCommand('/goal $planning-with-files Finish\nthen verify')).toEqual({ action: 'set', objective: 'Finish\nthen verify' })
    expect(parseGoalCommand('/goals')).toBeNull()
    expect(parseGoalCommand('Explain /goal')).toBeNull()
    expect(() => parseGoalCommand('/goal ' + 'x'.repeat(4001))).toThrow('4,000')
  })
})
