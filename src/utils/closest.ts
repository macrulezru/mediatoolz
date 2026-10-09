function distance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diagonal = previous[0] as number
    previous[0] = i
    for (let j = 1; j <= b.length; j++) {
      const above = previous[j] as number
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      previous[j] = Math.min(above + 1, (previous[j - 1] as number) + 1, diagonal + cost)
      diagonal = above
    }
  }
  return previous[b.length] as number
}

export function closest(word: string, candidates: readonly string[]): string | undefined {
  const lower = word.toLowerCase()
  let best: string | undefined
  let bestDistance = Infinity
  for (const candidate of candidates) {
    const d = distance(lower, candidate.toLowerCase())
    if (d < bestDistance) {
      best = candidate
      bestDistance = d
    }
  }
  if (best === undefined) return undefined
  const limit = Math.max(2, Math.floor(best.length / 3))
  return bestDistance <= limit ? best : undefined
}

export function didYouMean(word: string, candidates: readonly string[]): string {
  const match = closest(word, candidates)
  return match === undefined ? '' : ` Did you mean "${match}"?`
}
