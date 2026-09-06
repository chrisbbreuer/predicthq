import { describe, expect, it } from 'bun:test'
import { tsCloud } from '../../config/cloud'

describe('production service topology', () => {
  it('exposes HTTP and realtime services on their reserved ports', () => {
    expect(tsCloud.sites?.main?.port).toBe(3070)
    expect(tsCloud.sites?.api?.port).toBe(3071)
    expect(tsCloud.sites?.scheduler?.port).toBe(3072)
    expect(tsCloud.sites?.scheduler?.domain).toBe('realtime.predicthq.org')
    expect(tsCloud.sites?.scheduler?.healthCheck?.path).toBe('/health')

    for (const name of ['worker', 'oddsWatcher'] as const)
      expect(tsCloud.sites?.[name]?.port).toBeUndefined()
  })

  it('has exactly one scheduler runtime and colocates it with realtime', () => {
    expect(tsCloud.sites?.main?.scheduler).toBe(false)
    expect(tsCloud.sites?.scheduler?.start).toBe('bun app/Runtimes/RealtimeScheduler.ts')
    expect(tsCloud.sites?.scheduler?.env?.BROADCAST_PORT).toBe('3072')
  })
})
