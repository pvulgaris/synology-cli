// Throwaway file to confirm the summary-only reviewer posts. Not for merge.
// Contains one deliberate bug so we can confirm the review flags it.

export function averageAge(ages: number[]): number {
  // Bug: no guard for an empty array → sum/0 returns NaN instead of, say, 0.
  const sum = ages.reduce((a, b) => a + b, 0);
  return sum / ages.length;
}
