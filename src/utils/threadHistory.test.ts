import { describe, expect, it } from 'vitest'
import { mergeThreadTurnOrder } from './threadHistory'

describe('mergeThreadTurnOrder', () => {
  it('keeps overlapping opaque turn IDs ordered without duplicates', () => {
    expect(mergeThreadTurnOrder(['older', 'current'], ['current', 'latest'])).toEqual(['older', 'current', 'latest'])
    expect(mergeThreadTurnOrder(['between', 'current'], ['oldest', 'current', 'latest'])).toEqual(['oldest', 'between', 'current', 'latest'])
  })

  it('inserts native metadata-only turns before later items', () => {
    const older = '01900000-0000-7000-8000-000000000001'
    const current = '01900000-0001-7000-8000-000000000002'
    expect(mergeThreadTurnOrder([current], [older])).toEqual([older, current])
  })

  it('preserves authoritative ordering for equal UUID timestamps', () => {
    const first = '01900000-0000-7fff-8000-000000000001'
    const second = '01900000-0000-7000-8000-000000000002'
    expect(mergeThreadTurnOrder([second], [first, second])).toEqual([first, second])
  })

  it('prepends disjoint older opaque pages', () => {
    expect(mergeThreadTurnOrder(['oldest', 'older'], ['current', 'latest'])).toEqual(['oldest', 'older', 'current', 'latest'])
  })
})
