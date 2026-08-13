import { describe, expect, it } from 'bun:test'
import { authenticatedUserId } from '../../app/Support/request-auth'

describe('authenticatedUserId', () => {
  it('reads the current async Stacks user method with its request receiver', async () => {
    const request = {
      _authenticatedUser: { id: 42 },
      async user() {
        return this._authenticatedUser
      },
    }

    expect(await authenticatedUserId(request)).toBe(42)
  })

  it('accepts the legacy user property and middleware fallback', async () => {
    expect(await authenticatedUserId({ user: { id: 7 } })).toBe(7)
    expect(await authenticatedUserId({ _authenticatedUser: { id: '9' } })).toBe(9)
  })

  it('rejects missing and invalid identifiers', async () => {
    expect(await authenticatedUserId()).toBeNull()
    expect(await authenticatedUserId({ user: { id: 0 } })).toBeNull()
    expect(await authenticatedUserId({ user: { id: 1.5 } })).toBeNull()
  })
})
