import { Database } from './db'

export const marketCategories = [
  { slug: 'all', label: 'Home', image: '', icon: 'i-hugeicons-home-01' },
  { slug: 'sports', label: 'Sports', image: 'sports', icon: 'i-hugeicons-champion' },
  { slug: 'politics', label: 'Politics', image: 'politics', icon: 'i-hugeicons-government' },
  { slug: 'crypto', label: 'Crypto', image: 'crypto', icon: 'i-hugeicons-bitcoin-01' },
  { slug: 'weather', label: 'Weather', image: 'weather', icon: 'i-hugeicons-sun-03' },
  { slug: 'culture', label: 'Culture', image: 'culture', icon: 'i-hugeicons-music-note-01' },
  { slug: 'econ', label: 'Econ', image: 'economy', icon: 'i-hugeicons-chart-increase' },
  { slug: 'tech', label: 'Tech', image: 'technology', icon: 'i-hugeicons-cpu' },
] as const

export const marketLeagues = [
  { slug: 'nfl', label: 'NFL', sport: 'Football', image: 'nfl', pattern: 'NFL' },
  { slug: 'nba', label: 'NBA', sport: 'Basketball', image: 'nba', pattern: 'NBA' },
  { slug: 'soccer', label: 'Soccer', sport: 'All competitions', image: 'soccer', pattern: 'Soccer' },
  { slug: 'mlb', label: 'MLB', sport: 'Baseball', image: 'mlb', pattern: 'MLB' },
  { slug: 'mls', label: 'MLS', sport: 'Soccer', image: 'mls', pattern: 'MLS' },
  { slug: 'bundesliga', label: 'Bundesliga', sport: 'Soccer', image: 'bun', pattern: 'Bundesliga' },
  { slug: 'la-liga', label: 'La Liga', sport: 'Soccer', image: 'lal', pattern: 'La Liga' },
  { slug: 'premier-league', label: 'Premier League', sport: 'Soccer', image: 'epl', pattern: 'Premier League' },
  { slug: 'nhl', label: 'NHL', sport: 'Hockey', image: 'nhl', pattern: 'NHL' },
] as const

const categoryTerms: Record<string, string[]> = {
  sports: ['sport', 'football', 'soccer', 'basketball', 'baseball', 'hockey', 'tennis', 'nfl', 'nba', 'mlb', 'nhl', 'mls', 'epl', 'uefa', 'champions league', 'world series', 'premier league', 'bundesliga', 'la liga', 'ucla', 'points scored', 'wins by over'],
  politics: ['politic', 'election', 'presiden', 'democrat', 'republican', 'senate', 'congress', 'signed into law'], crypto: ['crypto', 'bitcoin', 'btc', 'ethereum', 'solana'], weather: ['weather', 'climate'],
  econ: ['econ', 'financ', 'business', 'market cap', 'interest rate', 'inflation'], tech: ['tech', 'science'], culture: ['culture', 'entertainment', 'music', 'pop'],
}
const leagueTerms: Record<string, string[]> = {
  'premier-league': ['premier league', 'epl'], 'bundesliga': ['bundesliga', 'kxbun'],
  'la-liga': ['la liga', 'laliga', 'kxlal'],
  'soccer': ['soccer', 'premier', 'bundesliga', 'liga', 'mls', 'ucl', 'uefa', 'epl', 'kxbun', 'kxlal'],
}

export interface DiscoveryRow {
  id: number, venue: string, external_id: string, question: string,
  outcome_label: string, category: string, status: string,
  last_price: number | null, volume: number, ends_at: string, updated_at: string,
}

export function categorySlug(category: string): string {
  const value = String(category || '').toLowerCase()
  for (const [slug, terms] of Object.entries(categoryTerms)) {
    if (terms.some(term => value.includes(term))) return slug
  }
  return 'all'
}

export function discoveryCard(row: DiscoveryRow) {
  const probability = row.last_price === null ? null : Number(row.last_price)
  const valid = probability !== null && Number.isFinite(probability) && probability >= 0 && probability <= 1
  const category = marketCategories.find(item => item.slug === categorySlug(`${row.category} ${row.question} ${row.external_id}`))!
  const league = marketLeagues.find(item => item.slug !== 'soccer' && (
    (leagueTerms[item.slug] || [item.pattern]).some(term => `${row.external_id} ${row.category} ${row.question}`.toLowerCase().includes(term.toLowerCase()))
  ))
  return {
    ...row,
    image: `/assets/images/markets/${league?.image || category.image || 'sports'}.png`,
    categoryLabel: league?.label || (category.slug === 'all' ? 'Markets' : category.label),
    venueLabel: row.venue === 'kalshi' ? 'Kalshi' : row.venue === 'polymarket-us' ? 'Polymarket US' : 'Polymarket',
    yes: valid ? `${Math.round(probability! * 100)}%` : 'No quote',
    no: valid ? `${Math.round((1 - probability!) * 100)}%` : 'No quote',
    volumeLabel: new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }).format(Number(row.volume) || 0),
    href: `/market?id=${row.id}`,
  }
}

export async function loadDiscovery(input: { category?: unknown, league?: unknown, q?: unknown } = {}) {
  const category = marketCategories.find(item => item.slug === input.category)?.slug || 'all'
  const league = marketLeagues.find(item => item.slug === input.league)
  const query = String(input.q || '').trim().slice(0, 120)
  const db = new Database()
  try {
    // Keep the search bounded and parameterized. No user-controlled SQL fragments.
    const conditions = ["status = 'open'"]
    const values: unknown[] = []
    if (query) {
      conditions.push('(LOWER(question) LIKE ? OR LOWER(outcome_label) LIKE ?)')
      const term = `%${query.toLowerCase().replaceAll('%', '').replaceAll('_', '')}%`
      values.push(term, term)
    }
    if (category !== 'all' && !league) {
      const terms = categoryTerms[category] || [category]
      conditions.push(`(${terms.map(() => '(LOWER(category) LIKE ? OR LOWER(question) LIKE ? OR LOWER(external_id) LIKE ?)').join(' OR ')})`)
      values.push(...terms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`]))
    }
    if (league) {
      const terms = leagueTerms[league.slug] || [league.pattern.toLowerCase()]
      conditions.push(`(${terms.map(() => '(LOWER(category) LIKE ? OR LOWER(question) LIKE ? OR LOWER(external_id) LIKE ?)').join(' OR ')})`)
      values.push(...terms.flatMap(term => [`%${term}%`, `%${term}%`, `%${term}%`]))
    }
    const rows = await db.query<DiscoveryRow>(`SELECT id, venue, external_id, question, outcome_label, category, status, last_price, volume, ends_at, updated_at
      FROM prediction_markets WHERE ${conditions.join(' AND ')} ORDER BY volume DESC, id DESC LIMIT 36`).all(...values)
    return { category, league: league?.slug || '', query, cards: rows.map(discoveryCard), unavailable: false }
  }
  catch {
    return { category, league: league?.slug || '', query, cards: [], unavailable: true }
  }
  finally { db.close() }
}

export async function loadMarket(id: unknown) {
  const value = Number(id)
  if (!Number.isSafeInteger(value) || value < 1) return null
  const db = new Database()
  try {
    const row = await db.query<DiscoveryRow>('SELECT * FROM prediction_markets WHERE id = ?').get(value)
    return row ? discoveryCard(row) : null
  }
  finally { db.close() }
}
