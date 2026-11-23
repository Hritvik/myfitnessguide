import { createElement, type ReactNode } from "react";
import { attrsOf, plain, type Attrs } from "./attrs";

/** Where written text can go: an inline run, a paragraph, a heading, a cell, a list item or a summary. */
export type TextTag = "span" | "p" | "b" | "h2" | "h3" | "dd" | "td" | "li" | "summary";

/**
 * How a slot of written text behaves when the text is long (wide-layout spec
 * §3): wrap (the default; the body already breaks a long word), clamp (2 or 3
 * lines, only as a <summary> inside <details>, so it always opens), truncate
 * (one line and an ellipsis; the full text stays reachable: "title" sets it,
 * "label" means an ancestor's title or name carries it, "link" means it sits in
 * a link to the record) or nowrap (short, app-written labels only, like "12 g").
 */
export type TextMode =
  | { mode?: "wrap" }
  | { mode: "clamp"; lines: 2 | 3; as: "summary" }
  | { mode: "truncate"; reach: "title" | "label" | "link" }
  | { mode: "nowrap" };

export type TextProps = TextMode & { as?: TextTag; className?: string; children: ReactNode } & Attrs;

const classes = (...names: (string | false | undefined)[]) => names.filter(Boolean).join(" ");

/** New written text goes through here (wide-layout spec §3); existing slots stay raw JSX. */
export function Text(props: TextProps) {
  const attrs = attrsOf(props);
  const { children } = props;
  switch (props.mode) {
    case "clamp":
      return createElement("summary", { className: classes(props.className, "t-clamp", props.lines === 3 && "t-clamp-3"), ...attrs }, children);
    case "truncate": {
      const title = props.reach === "title" && (typeof children === "string" || typeof children === "number") ? String(children) : undefined;
      return createElement(props.as ?? "span", { className: classes(props.className, "t-trunc"), title, ...attrs }, children);
    }
    case "nowrap":
      return createElement(props.as ?? "span", { className: classes(props.className, "t-nowrap"), ...attrs }, children);
    default:
      return plain(props.as, props.className, attrs, children);
  }
}
