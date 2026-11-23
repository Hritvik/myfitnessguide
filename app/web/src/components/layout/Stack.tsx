import { createElement, type ReactNode } from "react";
import type { Gap } from "../../layout";
import { attrsOf, plain, type Attrs } from "./attrs";
import type { BlockTag } from "./Grid";

export type StackProps = { wide: boolean; gap: Gap; as?: BlockTag; className?: string; children?: ReactNode } & Attrs;

/**
 * A column of parts `gap` apart (wide-layout spec §3; built for Catalogue A's
 * section cards, the first new element that needed one). On the phone it adds
 * nothing: exactly `<as className>`, or a fragment.
 */
export function Stack(props: StackProps) {
  const { wide, gap, as, className, children } = props;
  const attrs = attrsOf(props);
  if (!wide) return plain(as, className, attrs, children);
  return createElement(as ?? "div", { className: [className, "l-stack", `g-${gap}`].filter(Boolean).join(" "), ...attrs }, children);
}
