import { describe, expect, it } from 'bun:test'
import { fixedContracts, fixedYesPrice } from '../../app/Services/trading/kalshi-trading'
import { conservativePrice } from '../../app/Services/trading/polymarket-trading'
import { jurisdictionObjection } from '../../app/Services/trading/eligibility'

describe('Kalshi V2 order conversion', () => {
  it('quotes YES bids without raising the authorized outcome limit', () => {
    expect(fixedYesPrice(0.56789, false)).toBe('0.5678')
  })

  it('quotes a NO purchase as the complementary YES ask', () => {
    expect(fixedYesPrice(0.43129, true)).toBe('0.5688')
  })

  it('uses fixed-point contract strings', () => {
    expect(fixedContracts(4.239)).toBe('4.23')
  })
})

describe('Polymarket V2 order conversion', () => {
  it('does not let floating point rounding raise a buy limit', () => {
    expect(conservativePrice(0.56789)).toBe(0.5678)
  })
})

describe('Polymarket jurisdiction enforcement', () => {
  it('blocks a US attestation even when the execution server is elsewhere', () => {
    expect(jurisdictionObjection('polymarket', 'US')).toContain('does not permit')
  })

  it('blocks close-only and specifically restricted regions', () => {
    expect(jurisdictionObjection('polymarket', 'SG')).toContain('does not permit')
    expect(jurisdictionObjection('polymarket', 'CA-ON')).toContain('does not permit')
  })

  it('does not invent restrictions for Kalshi or an eligible Polymarket country', () => {
    expect(jurisdictionObjection('kalshi', 'US')).toBe('')
    expect(jurisdictionObjection('polymarket', 'CH')).toBe('')
  })
})
