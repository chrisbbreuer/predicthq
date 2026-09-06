import { describe, expect, it } from 'bun:test'
import { tsCloud } from '../../config/cloud'

describe('production service topology', () => {
  it('gives ports only to HTTP services', () => {
    expect(tsCloud.sites?.main?.port).toBe(3070)
    expect(tsCloud.sites?.api?.port).toBe(3071)

    for (const name of ['scheduler', 'worker', 'oddsWatcher'] as const)
      expect(tsCloud.sites?.[name]?.port).toBeUndefined()
  })
})
