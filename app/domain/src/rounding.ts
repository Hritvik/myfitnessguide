/**
 * Round the way Python's `round(x, dp)` does, so displayed values match
 * gymcalc and the Sheets parity report: correctly rounded on the exact
 * binary value, with exact ties going to the even digit.
 *
 * `toFixed` already rounds on the exact binary value; it only differs from
 * Python on exact ties, where it rounds up. An exact tie at `dp` places is
 * a dyadic value x = odd / 2^(dp+1), so x * 2^(dp+1) is an odd integer.
 */
export function roundHalfEven(x: number, dp: number): number {
  const scaledTie = x * 2 ** (dp + 1);
  if (Number.isInteger(scaledTie) && Math.abs(scaledTie) % 2 === 1) {
    const factor = 10 ** dp;
    const lower = Math.floor(x * factor);
    const even = lower % 2 === 0 ? lower : lower + 1;
    return even / factor;
  }
  return Number(x.toFixed(dp));
}

/** One decimal place, the precision the Log tab displays. */
export function round1(x: number): number {
  return roundHalfEven(x, 1);
}
