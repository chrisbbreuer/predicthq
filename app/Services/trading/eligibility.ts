const POLYMARKET_NO_OPEN_COUNTRIES = new Set([
  'AU', 'BE', 'BY', 'BI', 'CF', 'CD', 'CU', 'DE', 'ET', 'FR', 'GB', 'IR',
  'IQ', 'IT', 'KP', 'LB', 'LY', 'MM', 'NI', 'NL', 'PL', 'RU', 'SG', 'SO',
  'SS', 'SD', 'SY', 'TH', 'TW', 'UM', 'US', 'VE', 'YE', 'ZW',
])

const POLYMARKET_NO_OPEN_REGIONS = new Set(['CA-ON', 'UA-43', 'UA-14', 'UA-09'])

/**
 * Product-side eligibility gate. The venue's geoblock sees our execution
 * server, so it cannot replace the user's own recorded jurisdiction.
 */
export function jurisdictionObjection(venue: string, jurisdiction: string): string {
  if (venue !== 'polymarket')
    return ''

  const normalized = jurisdiction.trim().toUpperCase()
  if (!normalized)
    return 'Polymarket jurisdiction has not been attested; reconnect the account'

  const country = normalized.split('-')[0] ?? normalized
  if (POLYMARKET_NO_OPEN_COUNTRIES.has(country) || POLYMARKET_NO_OPEN_REGIONS.has(normalized))
    return `Polymarket does not permit opening positions from ${normalized}`

  return ''
}
