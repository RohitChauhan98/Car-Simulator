/** Avoid immediate repeats when picking from a sample pool. */
export function pickVariationIndex(count: number, last: number): number {
  if (count <= 1) return 0;
  let i = (Math.random() * count) | 0;
  if (i === last) i = (i + 1) % count;
  return i;
}

/** Small natural variation — keep within a few percent. */
export function pitchJitter(amount = 0.03): number {
  return 1 + (Math.random() * 2 - 1) * amount;
}

export function volumeJitter(amount = 0.08): number {
  return 1 + (Math.random() * 2 - 1) * amount;
}

export function startOffset(maxSec: number): number {
  if (maxSec <= 0) return 0;
  return Math.random() * maxSec;
}
