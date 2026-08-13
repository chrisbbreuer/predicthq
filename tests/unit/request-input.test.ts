import { describe, expect, it } from 'bun:test'
import { requestBoolean, requestString } from '../../app/Support/request-input'

function requestWith(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] }
}

describe('request input normalization', () => {
  it('normalizes decoded JSON values and arrays to strings', () => {
    const request = requestWith({ count: 20, enabled: true, selected: ['first', 'second'] })
    expect(requestString(request, 'count')).toBe('20')
    expect(requestString(request, 'enabled')).toBe('true')
    expect(requestString(request, 'selected')).toBe('first')
    expect(requestString(request, 'missing', 'fallback')).toBe('fallback')
  })

  it('accepts decoded booleans as well as form-style values', () => {
    expect(requestBoolean(requestWith({ value: true }), 'value')).toBeTrue()
    expect(requestBoolean(requestWith({ value: 'on' }), 'value')).toBeTrue()
    expect(requestBoolean(requestWith({ value: 1 }), 'value')).toBeTrue()
    expect(requestBoolean(requestWith({ value: false }), 'value', true)).toBeFalse()
    expect(requestBoolean(requestWith({ value: '0' }), 'value', true)).toBeFalse()
  })

  it('uses the caller fallback for absent or unrecognized values', () => {
    expect(requestBoolean(requestWith({}), 'value', true)).toBeTrue()
    expect(requestBoolean(requestWith({ value: 'maybe' }), 'value')).toBeFalse()
  })
})
