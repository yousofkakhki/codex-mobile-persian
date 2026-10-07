import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof fs>()
  return { ...actual, stat: vi.fn(actual.stat), open: vi.fn(actual.open) }
})
beforeEach(() => { vi.clearAllMocks() })
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks() })

describe('configured runtime model windows', () => {
  it('calculates effective context for exact aliases with per-model limits and overrides', async () => {
    const api = await import('./runtimeModelCatalog').catch(() => null)
    expect(api?.getConfiguredContextWindows, 'configured context mapping must exist').toBeTypeOf('function')
    expect(api!.getConfiguredContextWindows({ models: [
      { slug: 'cx/gpt-6.1-sol', context_window: 1050000 },
      { slug: 'cx/gpt-6-sol[1m]', context_window: 872000, effective_context_window_percent: 95 },
      { slug: 'invalid', context_window: -1 }, null,
    ] })).toEqual({ 'cx/gpt-6.1-sol': 997500, 'cx/gpt-6-sol[1m]': 828400 })
    expect(api!.getConfiguredContextWindows({ models: [
      { slug: 'model', context_window: 200000, max_context_window: 300000, effective_context_window_percent: 90 },
    ] }, 500000)).toEqual({ model: 270000 })
    expect(api!.getConfiguredContextWindows(null)).toEqual({})
  })
  it('coalesces catalog IO and invalidates changed files while applying overrides independently', async () => {
    const api = await import('./runtimeModelCatalog')
    expect(api.readConfiguredContextWindows, 'catalog reader must exist').toBeTypeOf('function')
    vi.stubEnv('CODEXUI_MODEL_CATALOG_JSON', '/synthetic/catalog.json')
    const catalog = JSON.stringify({ models: [{ slug: 'exact[1m]', context_window: 1000, max_context_window: 2000 }] })
    const stat = vi.spyOn(fs, 'stat').mockResolvedValue({ mtimeMs: 1, ctimeMs: 1, size: catalog.length, ino: 1, dev: 1 } as never)
    const read = vi.fn(async (buffer: Buffer, _offset: number, _length: number, position: number) => { if (position) return { bytesRead: 0, buffer }; buffer.write(catalog); return { bytesRead: catalog.length, buffer } })
    const close = vi.fn(async () => undefined)
    const open = vi.spyOn(fs, 'open').mockResolvedValue({ read, close } as never)
    expect(await Promise.all([api.readConfiguredContextWindows(), api.readConfiguredContextWindows(2000)]))
      .toEqual([{ 'exact[1m]': 950 }, { 'exact[1m]': 1900 }])
    expect(open).toHaveBeenCalledTimes(1)
    expect(close).toHaveBeenCalledTimes(1)
    await api.readConfiguredContextWindows()
    expect(open).toHaveBeenCalledTimes(1)
    stat.mockResolvedValue({ mtimeMs: 2, ctimeMs: 2, size: catalog.length, ino: 1, dev: 1 } as never)
    expect(await api.readConfiguredContextWindows()).toEqual({ 'exact[1m]': 950 })
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('rejects oversized catalog files before opening them and recovers from missing or malformed metadata', async () => {
    const { readConfiguredContextWindows } = await import('./runtimeModelCatalog')
    vi.stubEnv('CODEXUI_MODEL_CATALOG_JSON', '/synthetic/bounded.json')
    const stat = vi.spyOn(fs, 'stat').mockResolvedValue({ mtimeMs: 1, ctimeMs: 1, size: 4 * 1024 * 1024 + 1 } as never)
    const open = vi.spyOn(fs, 'open').mockImplementation(async () => { throw new Error('must not open oversized file') })
    expect(await readConfiguredContextWindows()).toEqual({})
    expect(open).not.toHaveBeenCalled()
    stat.mockRejectedValueOnce(new Error('missing'))
    expect(await readConfiguredContextWindows()).toEqual({})
    stat.mockResolvedValue({ mtimeMs: 2, ctimeMs: 2, size: 2 } as never)
    const close = vi.fn(async () => undefined)
    open.mockResolvedValue({ read: async (buffer: Buffer, _offset: number, _length: number, position: number) => { if (position) return { bytesRead: 0 }; buffer.write('{!'); return { bytesRead: 2 } }, close } as never)
    expect(await readConfiguredContextWindows()).toEqual({})
    expect(close).toHaveBeenCalledTimes(1)
    open.mockResolvedValue({ read: async (buffer: Buffer, _offset: number, _length: number, position: number) => { if (position) return { bytesRead: 0 }; buffer.write('{}'); return { bytesRead: 2 } }, close } as never)
    expect(await readConfiguredContextWindows()).toEqual({})
    expect(open).toHaveBeenCalledTimes(2)
    vi.stubEnv('CODEXUI_MODEL_CATALOG_JSON', '')
    expect(await readConfiguredContextWindows()).toEqual({})
    expect(open).toHaveBeenCalledTimes(2)
  })

  it('reads short filesystem chunks to EOF without caching a partial catalog', async () => {
    const { readConfiguredContextWindows } = await import('./runtimeModelCatalog')
    vi.stubEnv('CODEXUI_MODEL_CATALOG_JSON', '/synthetic/partial.json')
    const data = Buffer.from(JSON.stringify({ models: [{ slug: 'partial', context_window: 1000 }] }))
    vi.spyOn(fs, 'stat').mockResolvedValue({ mtimeMs: 8, ctimeMs: 8, size: data.length } as never)
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Math.max(0, Math.min(7, length, data.length - position))
      data.copy(buffer, offset, position, position + bytesRead)
      return { bytesRead, buffer }
    })
    const close = vi.fn(async () => undefined)
    vi.spyOn(fs, 'open').mockResolvedValue({ read, close } as never)
    expect(await readConfiguredContextWindows()).toEqual({ partial: 950 })
    expect(read.mock.calls.length).toBeGreaterThan(1)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('ignores invalid limits and supports literal prototype-like catalog tokens safely', async () => {
    const { getConfiguredContextWindows } = await import('./runtimeModelCatalog')
    expect(getConfiguredContextWindows({ models: [
      { slug: '__proto__', context_window: 1000 }, { slug: 'constructor', context_window: 1000 },
      { slug: 'nan', context_window: 1000, effective_context_window_percent: NaN },
      { slug: 'infinite', context_window: Infinity }, { slug: 'fractional', context_window: 1.5 },
      { slug: 'zero-percent', context_window: 1000, effective_context_window_percent: 0 },
      { slug: 'large-percent', context_window: 1000, effective_context_window_percent: 101 },
    ] })).toEqual({ ['__proto__']: 950, constructor: 950 })
  })

})
