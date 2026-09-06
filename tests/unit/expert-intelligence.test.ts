import { describe, expect, it } from 'bun:test'
import ExpertConsensusSnapshot from '../../app/Models/ExpertConsensusSnapshot'
import ExpertOpinion from '../../app/Models/ExpertOpinion'
import ExpertPerformanceSnapshot from '../../app/Models/ExpertPerformanceSnapshot'
import ExpertPick from '../../app/Models/ExpertPick'
import ExpertProfile from '../../app/Models/ExpertProfile'
import ExpertSource from '../../app/Models/ExpertSource'
import { expertSources, readyExpertSources } from '../../config/expert-intelligence'

describe('expert intelligence schema', () => {
  it('keeps raw opinion, normalized pick, consensus, and performance as separate records', () => {
    expect(ExpertSource.table).toBe('expert_sources')
    expect(ExpertProfile.table).toBe('expert_profiles')
    expect(ExpertOpinion.table).toBe('expert_opinions')
    expect(ExpertPick.table).toBe('expert_picks')
    expect(ExpertPerformanceSnapshot.table).toBe('expert_performance_snapshots')
    expect(ExpertConsensusSnapshot.table).toBe('expert_consensus_snapshots')
  })

  it('deduplicates source identities, opinions, picks, and consensus snapshots', () => {
    expect(ExpertSource.indexes?.some(index => index.unique && index.name === 'expert_sources_key')).toBe(true)
    expect(ExpertProfile.indexes?.some(index => index.unique && index.name === 'expert_profiles_source_external')).toBe(true)
    expect(ExpertOpinion.indexes?.some(index => index.unique && index.name === 'expert_opinions_source_external')).toBe(true)
    expect(ExpertPick.indexes?.some(index => index.unique && index.name === 'expert_picks_source_fingerprint')).toBe(true)
    expect(ExpertConsensusSnapshot.indexes?.some(index => index.unique && index.name === 'expert_consensus_target_time')).toBe(true)
  })
})

describe('expert source policy', () => {
  it('never exposes a ready connector whose policy is not explicitly allowed', () => {
    expect(readyExpertSources().every(source => source.accessPolicy === 'allowed')).toBe(true)
  })

  it('blocks publishers whose current terms prohibit unauthorized scraping', () => {
    for (const key of ['sportsline', 'action-network', 'cbs-sports-betting']) {
      expect(expertSources.find(source => source.key === key)).toMatchObject({
        accessPolicy: 'blocked_by_terms',
        status: 'blocked',
      })
    }
  })

  it('starts only rights-controlled ingestion channels as ready', () => {
    expect(readyExpertSources().map(source => source.key).sort()).toEqual([
      'authorized-newsletters',
      'expert-podcast-rss',
      'manual-expert-import',
    ])
  })
})
