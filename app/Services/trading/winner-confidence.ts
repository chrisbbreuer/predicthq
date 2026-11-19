export const MIN_PICK_CONFIDENCE = 0.70

export function meetsPickConfidence(probability: number): boolean {
  return probability >= MIN_PICK_CONFIDENCE - Number.EPSILON && probability <= 1
}

/** Average the two Kalshi winner contracts in the same orientation. */
export function kalshiHomeProbability(homeMid: number | null, awayMid: number | null): number | null {
  if (awayMid === null)
    return homeMid
  return homeMid === null ? 1 - awayMid : (homeMid + 1 - awayMid) / 2
}
