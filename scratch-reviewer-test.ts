// Throwaway file to exercise the auto code-review workflow. Not for merge.
// Contains one deliberate bug so we can confirm the reviewer posts an inline
// finding (not just a "no issues" summary).

export function formatPercent(part: number, total: number): string {
  // Bug: no guard for total === 0 → division yields Infinity/NaN, so this
  // returns "Infinity%" or "NaN%" instead of handling the empty case.
  return ((part / total) * 100).toFixed(1) + "%";
}
