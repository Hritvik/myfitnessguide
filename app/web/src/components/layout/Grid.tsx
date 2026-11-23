import { createElement, type ReactNode } from "react";
import type { CardMin, Gap } from "../../layout";
import { attrsOf, plain, type Attrs } from "./attrs";

/** The block elements a primitive may be. */
export type BlockTag = "div" | "section" | "article" | "ol" | "ul" | "dl";

export type GridProps = {
  wide: boolean;
  /** The narrowest a card may be (CardMin). */
  min: CardMin;
  /** At most this many across; unlimited when absent. */
  max?: 2 | 3 | 4;
  gap: Gap;
  /** auto-fill rather than auto-fit: empty tracks keep their width, so a lone card doesn't stretch across. */
  fill?: boolean;
  as?: BlockTag;
  className?: string;
  children?: ReactNode;
} & Attrs;

/**
 * A grid of cards (wide-layout spec §3): as many columns of at least `min`
 * as fit, never more than `max` (layout.css, `.l-grid`). On the phone it adds
 * nothing: exactly `<as className>`, or a fragment, so the phone's markup is
 * what it was.
 */
export function Grid(props: GridProps) {
  const { wide, min, max, gap, fill, as, className, children } = props;
  const attrs = attrsOf(props);
  if (!wide) return plain(as, className, attrs, children);
  const names = [className, "l-grid", `min-${min}`, max ? `max-${max}` : null, `g-${gap}`, fill ? "fill" : null].filter(Boolean).join(" ");
  return createElement(as ?? "div", { className: names, ...attrs }, children);
}
