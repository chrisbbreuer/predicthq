import { expect, it } from 'bun:test'
import { qualifyingComboOffer } from '../../app/Services/trading/live-combo-checkout'

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
