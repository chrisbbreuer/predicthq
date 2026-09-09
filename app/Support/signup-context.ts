import { normalizeReferralCode } from '@stacksjs/auth'

export function signupContext(ref: unknown, invite: unknown) {
  return {
    referralCode: normalizeReferralCode(ref),
    invite: /^[a-f0-9]{64}$/.test(String(invite || '')) ? String(invite) : '',
  }
}

export function signupQuery(ref: unknown, invite: unknown): string {
  const context = signupContext(ref, invite)
  const query = new URLSearchParams()
  if (context.referralCode) query.set('ref', context.referralCode)
  if (context.invite) query.set('invite', context.invite)
  return query.size ? `?${query}` : ''
}

export function oauthContextCookie(provider: string, context: unknown, maxAge = 600): string {
  return `oauth-context-${provider}=${context ? encodeURIComponent(JSON.stringify(context)) : ''}; Path=/api/auth/${provider}/callback; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`
}

export function readSignupContext(raw: unknown, state: string) {
  try {
    const context = JSON.parse(String(raw || '{}'))
    return context.state === state ? signupContext(context.referralCode, context.invite) : signupContext('', '')
  }
  catch { return signupContext('', '') }
}
