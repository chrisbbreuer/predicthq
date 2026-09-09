import { describe, expect, it } from 'bun:test'
import { oauthContextCookie, readSignupContext, signupQuery } from '../../app/Support/signup-context'

describe('signup attribution context', () => {
  it('preserves only bounded referral and group invitation identifiers', () => {
    expect(signupQuery('A'.repeat(24), 'b'.repeat(64))).toBe(`?ref=${'a'.repeat(24)}&invite=${'b'.repeat(64)}`)
    expect(signupQuery('https://attacker.example', '/admin')).toBe('')
  })
  it('binds context to the verified OAuth state and ignores mismatches', () => {
    const raw = JSON.stringify({ state: 'expected', referralCode: 'a'.repeat(24), invite: 'b'.repeat(64) })
    expect(readSignupContext(raw, 'wrong')).toEqual({ referralCode: null, invite: '' })
    expect(readSignupContext(raw, 'expected').referralCode).toBe('a'.repeat(24))
    expect(readSignupContext('{broken', 'expected').invite).toBe('')
    expect(oauthContextCookie('apple', { state: 'expected' })).toContain('HttpOnly; Secure; SameSite=None; Max-Age=600')
  })
})
