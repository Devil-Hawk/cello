// How much a person changed what the model wrote: word-level Levenshtein
// distance divided by the larger word count. 0 is identical, 1 is nothing in
// common. Words, not characters, so fixing a comma is small and rewriting a
// sentence is not. Two empty texts are identical.

function words(text: string): string[] {
  return text.trim().split(/\s+/).filter(Boolean)
}

export function normalizedEditDistance(a: string, b: string): number {
  const x = words(a)
  const y = words(b)
  const longest = Math.max(x.length, y.length)
  if (longest === 0) return 0
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i += 1) {
    const row = [i]
    for (let j = 1; j <= y.length; j += 1) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1))
    }
    prev = row
  }
  return prev[y.length] / longest
}
