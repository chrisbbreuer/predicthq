/**
 * Candidate publishers for the expert-intelligence pipeline.
 *
 * `ready` means the transport itself is usable without bypassing an access
 * control. It does not waive copyright or a publisher's terms: every enabled
 * connector must still retain attribution and the source URL.
 */
export type ExpertAcquisition = 'licensed_feed' | 'official_api' | 'rss' | 'authorized_email' | 'public_web' | 'manual'
export type ExpertAccessPolicy = 'allowed' | 'permission_required' | 'blocked_by_terms' | 'review_required'
export type ExpertSourceStatus = 'ready' | 'planned' | 'blocked'

export interface ExpertSourceDefinition {
  key: string
  name: string
  homepageUrl: string
  termsUrl: string
  acquisition: ExpertAcquisition
  accessPolicy: ExpertAccessPolicy
  status: ExpertSourceStatus
  priority: 1 | 2 | 3
  coverage: string
  notes: string
}

export const expertSources = [
  {
    key: 'authorized-newsletters',
    name: 'Authorized expert newsletters',
    homepageUrl: '',
    termsUrl: '',
    acquisition: 'authorized_email',
    accessPolicy: 'allowed',
    status: 'ready',
    priority: 1,
    coverage: 'Publisher and independent expert picks delivered to a PredictHQ-owned inbox',
    notes: 'Store the original message as a source document and honor unsubscribe and redistribution terms.',
  },
  {
    key: 'expert-podcast-rss',
    name: 'Expert podcast RSS feeds',
    homepageUrl: '',
    termsUrl: '',
    acquisition: 'rss',
    accessPolicy: 'allowed',
    status: 'ready',
    priority: 1,
    coverage: 'Public betting podcasts and show notes from an explicit feed allow-list',
    notes: 'Ingest feed metadata and show notes; license transcripts before storing full text.',
  },
  {
    key: 'youtube-expert-channels',
    name: 'YouTube expert channels',
    homepageUrl: 'https://www.youtube.com/',
    termsUrl: 'https://developers.google.com/youtube/terms/api-services-terms-of-service',
    acquisition: 'official_api',
    accessPolicy: 'allowed',
    status: 'planned',
    priority: 1,
    coverage: 'Allow-listed publisher and analyst videos, descriptions, and captions when licensed',
    notes: 'Use the YouTube Data API; do not scrape pages or download unlicensed transcripts.',
  },
  {
    key: 'rotowire',
    name: 'RotoWire',
    homepageUrl: 'https://www.rotowire.com/betting/advice/',
    termsUrl: 'https://www.rotowire.com/terms.php',
    acquisition: 'licensed_feed',
    accessPolicy: 'permission_required',
    status: 'planned',
    priority: 1,
    coverage: 'Broad expert betting articles, picks, injuries, and projections',
    notes: 'RotoWire advertises content syndication; prefer a commercial feed over page extraction.',
  },
  {
    key: 'covers',
    name: 'Covers',
    homepageUrl: 'https://www.covers.com/picks',
    termsUrl: 'https://www.covers.com/terms',
    acquisition: 'licensed_feed',
    accessPolicy: 'permission_required',
    status: 'planned',
    priority: 1,
    coverage: 'Free expert picks and consensus across major North American sports',
    notes: 'Request syndication or API permission before automated collection.',
  },
  {
    key: 'bettingpros',
    name: 'BettingPros',
    homepageUrl: 'https://www.bettingpros.com/articles/',
    termsUrl: 'https://www.bettingpros.com/about/legal/',
    acquisition: 'licensed_feed',
    accessPolicy: 'permission_required',
    status: 'planned',
    priority: 1,
    coverage: 'Expert articles, picks, consensus tools, and leaderboards',
    notes: 'Ask for a partner feed and historical expert identifiers.',
  },
  {
    key: 'vsin',
    name: 'VSiN',
    homepageUrl: 'https://vsin.com/picks/',
    termsUrl: 'https://vsin.com/terms-of-use/',
    acquisition: 'licensed_feed',
    accessPolicy: 'permission_required',
    status: 'planned',
    priority: 1,
    coverage: 'Daily expert picks, betting splits, power ratings, and newsletters',
    notes: 'Use a commercial partnership or an expressly authorized newsletter inbox.',
  },
  {
    key: 'sportsline',
    name: 'SportsLine',
    homepageUrl: 'https://www.sportsline.com/experts/',
    termsUrl: 'https://legal.paramount.com/us/en/cbsi/sportsline-terms-of-use',
    acquisition: 'licensed_feed',
    accessPolicy: 'blocked_by_terms',
    status: 'blocked',
    priority: 1,
    coverage: 'Named expert picks, model projections, units, records, and analysis',
    notes: 'Do not automate subscriber pages. Obtain written CBS/Paramount syndication permission first.',
  },
  {
    key: 'action-network',
    name: 'Action Network',
    homepageUrl: 'https://www.actionnetwork.com/picks',
    termsUrl: 'https://www.actionnetwork.com/terms',
    acquisition: 'licensed_feed',
    accessPolicy: 'blocked_by_terms',
    status: 'blocked',
    priority: 1,
    coverage: 'Expert picks, unit history, live records, and market analysis',
    notes: 'Terms expressly prohibit page scraping and robots. Only enable a licensed integration.',
  },
  {
    key: 'ftn-bets',
    name: 'FTN Bets',
    homepageUrl: 'https://ftnfantasy.com/bets/',
    termsUrl: 'https://ftnfantasy.com/terms-of-service',
    acquisition: 'licensed_feed',
    accessPolicy: 'permission_required',
    status: 'planned',
    priority: 2,
    coverage: 'Transparent expert bet tracker with odds, units, timestamps, and results',
    notes: 'High-value history; negotiate feed access rather than scraping the subscriber tracker.',
  },
  {
    key: 'dimers',
    name: 'Dimers',
    homepageUrl: 'https://www.dimers.com/best-bets',
    termsUrl: 'https://www.dimers.com/terms-of-use',
    acquisition: 'licensed_feed',
    accessPolicy: 'permission_required',
    status: 'planned',
    priority: 2,
    coverage: 'Model probabilities, edges, best bets, and in-play predictions',
    notes: 'Treat model outputs separately from human experts and preserve model/version attribution.',
  },
  {
    key: 'espn-betting',
    name: 'ESPN Betting',
    homepageUrl: 'https://www.espn.com/sports-betting/',
    termsUrl: 'https://disneytermsofuse.com/',
    acquisition: 'rss',
    accessPolicy: 'permission_required',
    status: 'planned',
    priority: 2,
    coverage: 'Expert best-bet articles, PickCenter projections, and betting news',
    notes: 'Use an official feed or license. Do not treat an ESPN+ login as syndication permission.',
  },
  {
    key: 'cbs-sports-betting',
    name: 'CBS Sports Betting',
    homepageUrl: 'https://www.cbssports.com/betting/',
    termsUrl: 'https://legal.paramount.com/us/en/cbsi/terms-of-use',
    acquisition: 'rss',
    accessPolicy: 'blocked_by_terms',
    status: 'blocked',
    priority: 2,
    coverage: 'Public expert articles and staff picks',
    notes: 'Paramount terms restrict unauthorized scraping; request a feed or syndication license.',
  },
  {
    key: 'pickswise',
    name: 'Pickswise',
    homepageUrl: 'https://www.pickswise.com/',
    termsUrl: 'https://www.pickswise.com/terms-and-conditions/',
    acquisition: 'licensed_feed',
    accessPolicy: 'permission_required',
    status: 'planned',
    priority: 2,
    coverage: 'Game picks, props, parlays, and betting previews',
    notes: 'Confirm commercial reuse and attribution rights before enabling.',
  },
  {
    key: 'pff-betting',
    name: 'PFF Betting',
    homepageUrl: 'https://www.pff.com/betting',
    termsUrl: 'https://www.pff.com/terms',
    acquisition: 'licensed_feed',
    accessPolicy: 'permission_required',
    status: 'planned',
    priority: 2,
    coverage: 'NFL and college football analysis, grades, projections, and picks',
    notes: 'Prefer PFF data licensing; grades and premium analysis are proprietary data.',
  },
  {
    key: 'sharp-football-analysis',
    name: 'Sharp Football Analysis',
    homepageUrl: 'https://www.sharpfootballanalysis.com/betting/',
    termsUrl: 'https://www.sharpfootballanalysis.com/terms-and-conditions/',
    acquisition: 'licensed_feed',
    accessPolicy: 'permission_required',
    status: 'planned',
    priority: 3,
    coverage: 'NFL and college football betting analysis and projections',
    notes: 'Good depth source; narrower sport coverage makes it a second-wave integration.',
  },
  {
    key: 'odds-shark',
    name: 'OddsShark',
    homepageUrl: 'https://www.oddsshark.com/picks',
    termsUrl: 'https://www.oddsshark.com/terms-service',
    acquisition: 'licensed_feed',
    accessPolicy: 'review_required',
    status: 'blocked',
    priority: 3,
    coverage: 'Computer picks, trends, consensus, and matchup analysis',
    notes: 'Robots currently block automated indexing; do not crawl until permission is explicit.',
  },
  {
    key: 'manual-expert-import',
    name: 'Manual expert import',
    homepageUrl: '',
    termsUrl: '',
    acquisition: 'manual',
    accessPolicy: 'allowed',
    status: 'ready',
    priority: 3,
    coverage: 'User-owned CSV, JSON, and webhook submissions',
    notes: 'Require source URL, author, publication time, and rights assertion on every import.',
  },
] as const satisfies readonly ExpertSourceDefinition[]

export function readyExpertSources(): ExpertSourceDefinition[] {
  return expertSources.filter(source => source.status === 'ready' && source.accessPolicy === 'allowed')
}

export default expertSources
