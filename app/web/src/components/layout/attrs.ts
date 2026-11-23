import { createElement, Fragment, type AriaRole, type ReactNode } from "react";

/** The attributes a primitive passes through to its element (wide-layout spec §3): id, role, aria-* and data-*. */
export interface Attrs {
  id?: string;
  role?: AriaRole;
  [aria: `aria-${string}`]: string | number | boolean | undefined;
  [data: `data-${string}`]: string | number | boolean | undefined;
}

/** The pass-through attributes of a primitive's props, in the order they were given. */
export function attrsOf(props: object): Attrs {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key === "id" || key === "role" || key.startsWith("aria-") || key.startsWith("data-")) out[key] = value;
  }
  return out as Attrs;
}

/**
 * What every primitive renders on the phone (wide-layout spec §1, §3): the
 * plain element it was given, `<as className …attrs>`, with none of its own
 * classes, or a fragment when it has no element, so the phone's markup is
 * what it was before the primitive wrapped it.
 */
export function plain(as: string | undefined, className: string | undefined, attrs: Attrs, children: ReactNode) {
  return as ? createElement(as, { className, ...attrs }, children) : createElement(Fragment, null, children);
}
