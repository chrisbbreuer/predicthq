import { expect, it } from 'bun:test'
import { comboAmountCents, comboOrderStatus, qualifyingComboOffer } from '../../app/Services/trading/live-combo-checkout'

it('only offers the exact maker NO bid that buys the combo YES within the budget and payout floor', () => {
  const rfq = 'a1000000-1234-1234-1234-262626262626'
  const market = 'KXMVE-COMBO'
  const quote = {
    id: 'b1000000-1234-1234-1234-262626262626', rfq_id: rfq, market_ticker: market,
    status: 'open', no_bid_dollars: '0.4000', no_contracts_fp: '1.62', rfq_target_cost_dollars: '1.0000',
    target_cost_excludes_fees: false,
  }
  expect(qualifyingComboOffer(quote, rfq, market, 1, 1.5, 400)).toEqual({ id: quote.id, price: .60, payout: 1.62, maxCost: 1, expires: 400 })
  expect(qualifyingComboOffer({ ...quote, no_contracts_fp: '1.20' }, rfq, market, 1, 1.5, 400)).toBeNull()
  expect(qualifyingComboOffer({ ...quote, no_contracts_fp: '1.80' }, rfq, market, 1, 1.5, 400)).toBeNull()
  expect(qualifyingComboOffer({ ...quote, status: 'cancelled' }, rfq, market, 1, 1.5, 400)).toBeNull()
  expect(qualifyingComboOffer({ ...quote, target_cost_excludes_fees: true }, rfq, market, 1, 1.5, 400)).toBeNull()
  expect(qualifyingComboOffer(quote, rfq, 'KXMVE-DIFFERENT', 1, 1.5, 400)).toBeNull()
})

it('accepts exact custom dollar amounts and checks the venue quote against that amount', () => {
  expect(comboAmountCents('2.75')).toBe(275)
  expect(comboAmountCents('.50')).toBe(50)
  expect(['', '0', '-1', '1.005', '2e3', '90071992547499.92'].map(comboAmountCents)).toEqual(Array(6).fill(null))
  const rfq = 'a1000000-1234-1234-1234-262626262626'
  const market = 'KXMVE-COMBO'
  const quote = {
    id: 'b1000000-1234-1234-1234-262626262626',
    rfq_id: rfq, market_ticker: market, status: 'open',
    no_bid_dollars: '0.5400', no_contracts_fp: '5.80', rfq_target_cost_dollars: '2.7500', target_cost_excludes_fees: false,
  }
  expect(qualifyingComboOffer(quote, rfq, market, 2.75, 1.5, 400)).toMatchObject({ maxCost: 2.75, payout: 5.8 })
  expect(qualifyingComboOffer(quote, rfq, market, 3, 1.5, 400)).toBeNull()
  expect(qualifyingComboOffer({ ...quote, no_contracts_fp: '6.00' }, rfq, market, 2.75, 1.5, 400)).toBeNull()
})

it('verifies an order even when another maker supplied the executed quote at the same price', async () => {
  const intent = { rfq: 'rfq', market: 'COMBO', expires: 100 }
  const client = {
    comboQuotes: async () => [
      { id: 'selected', rfq_id: 'rfq', market_ticker: 'COMBO', status: 'cancelled' },
      { id: 'other-maker', rfq_id: 'rfq', market_ticker: 'COMBO', status: 'executed', executed_ts: 'now', rfq_creator_order_id: 'order' },
    ],
    comboRfqStatus: async () => 'closed',
    fetchOrder: async (id: string) => ({ externalOrderId: id, status: 'filled', filledSize: 2.04, avgFillPrice: .48 }),
  }
  expect(await comboOrderStatus(client, intent, 200)).toEqual({ state: 'executed', orderId: 'order', payout: 2.04 })
})

it('keeps uncertain submissions distinct from exchange-confirmed failures', async () => {
  const intent = { rfq: 'rfq', market: 'COMBO', expires: 100 }
  const client = {
    comboQuotes: async () => [{ id: 'selected', rfq_id: 'rfq', market_ticker: 'COMBO', status: 'cancelled' }],
    comboRfqStatus: async () => 'cancelled',
    fetchOrder: async () => null,
  }
  expect(await comboOrderStatus(client, intent, 50)).toEqual({ state: 'submitted' })
  expect(await comboOrderStatus(client, intent, 200)).toMatchObject({ state: 'not_filled' })
  const unavailable = async () => { throw new Error('Kalshi unavailable') }
  expect(await comboOrderStatus({ ...client, comboQuotes: unavailable }, intent, 200)).toEqual({ state: 'unverified' })
})
