/**
 * A number as a member types it (ticket 67, B1): digits with at most one
 * decimal point, surrounding spaces ignored. Every form reads its numbers
 * here, so none takes what JavaScript's Number would ("0x32", "5e1", "+50",
 * "0b110010", "0o62", "Infinity" or 400 digits). A comma is not a decimal
 * point: "2,5" is refused, never read as 2.5 or 25.
 */
const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;
const SIGNED = /^-?(\d+(\.\d*)?|\.\d+)$/;

/**
 * The number typed, or NaN for anything else (so a form's `Number.isFinite`
 * check refuses it). `signed`: a leading minus is allowed (an assistance
 * load). `percent`: one trailing "%" is allowed ("50%").
 */
export function typedNumber(text: string, opts: { signed?: boolean; percent?: boolean } = {}): number {
  let t = text.trim();
  if (opts.percent) t = t.replace(/\s*%$/, "");
  if (!(opts.signed ? SIGNED : DECIMAL).test(t)) return Number.NaN;
  const v = Number(t);
  return Number.isFinite(v) ? v : Number.NaN;
}
