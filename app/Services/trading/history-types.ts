/** USD amounts are kept at source precision and rounded only for display. */
export interface HistoryActivity {
  id: string
  marketId: string
  title: string
  side: string
  kind: 'buy' | 'sell' | 'trade' | 'settlement'
  size: number
  amount: number
  fee: number | null
  at: string
  voided?: boolean
}

/** One market's lifetime record. Realized excludes changing market marks. */
export interface HistoryBet {
  marketId: string
  title: string
  side: string
  status: 'open' | 'closed'
  traded: number
  realized: number | null
  fees: number | null
  at: string
}

export interface VenueHistory {
  bets: HistoryBet[]
  activity: HistoryActivity[]
  notes: string[]
}

export function historyNumber(value: unknown): number {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)))
    throw new Error('The exchange returned an incomplete history amount.')
  return Number(value)
}

export function historyTime(value: unknown): string {
  const date = new Date(String(value))
  if (!Number.isFinite(date.getTime())) throw new Error('The exchange returned an invalid history date.')
  return date.toISOString()
}

/** Stable exchange IDs collapse overlaps between recent and archival pages. */
export function uniqueHistory<T>(rows: T[], key: (row: T) => string): T[] {
  return [...new Map(rows.map(row => [key(row), row])).values()]
}
