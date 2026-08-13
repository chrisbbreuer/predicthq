interface InputRequest {
  get?: (key: string) => unknown
}

/** Normalize JSON, form, and query values to one predictable text shape. */
export function requestString(request: InputRequest | undefined, key: string, fallback = ''): string {
  const raw = request?.get?.(key)
  if (raw === undefined || raw === null)
    return fallback

  if (Array.isArray(raw))
    return raw.length ? String(raw[0] ?? fallback) : fallback

  return String(raw)
}

/** Read booleans whether the transport decoded them or left them as text. */
export function requestBoolean(request: InputRequest | undefined, key: string, fallback = false): boolean {
  const raw = request?.get?.(key)
  if (raw === undefined || raw === null || raw === '')
    return fallback
  if (typeof raw === 'boolean')
    return raw
  if (typeof raw === 'number')
    return raw !== 0

  const normalized = String(Array.isArray(raw) ? raw[0] ?? '' : raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(normalized))
    return true
  if (['0', 'false', 'no', 'off'].includes(normalized))
    return false
  return fallback
}
