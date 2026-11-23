/**
 * The layout audit (wide-layout spec §7), run inside the page by the layout
 * project (`page.evaluate(audit)`): every text run and control checked against
 * the boxes that hold it. Self-contained: it closes over nothing.
 */

export interface Flag {
  kind: "page-scroll" | "spill" | "clipped" | "overflow" | "offscreen" | "covered" | "fold";
  where: string;
  text: string;
  by: number;
}

/** Runs in the browser: every text run and control checked against the boxes that hold it. */
export function audit(): Flag[] {
  const flags: Flag[] = [];
  const seen = new Set<string>();
  const sig = (el: Element | null): string => {
    const parts: string[] = [];
    for (let e = el, i = 0; e && e !== document.body && i < 4; e = e.parentElement, i++) {
      const cls = [...e.classList].slice(0, 2).join(".");
      parts.unshift(e.tagName.toLowerCase() + (cls ? `.${cls}` : ""));
    }
    return parts.join(">");
  };
  const mark = (el: Element) => el.setAttribute("data-sweep-flag", "");
  const add = (kind: Flag["kind"], el: Element, text: string, by: number) => {
    const where = sig(el);
    const key = `${kind}|${where}|${text.slice(0, 30)}`;
    if (seen.has(key)) return;
    seen.add(key);
    mark(el);
    flags.push({ kind, where, text: text.replace(/\s+/g, " ").trim().slice(0, 80), by: Math.round(by) });
  };
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1) add("page-scroll", de, `${de.scrollWidth} > ${de.clientWidth}`, de.scrollWidth - de.clientWidth);

  /** Not shown, or shown only to a screen reader (a box clipped away with clip-path, like .visually-hidden). */
  const hidden = (el: Element): boolean => {
    if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || el.closest(".visually-hidden, svg *")) return true;
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) if (getComputedStyle(e).clipPath !== "none") return true;
    return false;
  };
  const style = (el: Element) => getComputedStyle(el);
  const isBox = (el: Element): boolean => {
    const s = style(el);
    if (el.matches(".col, section.sheet, .menu, [role=dialog], .sidebar, main.screen, .tabbar")) return true;
    const bg = s.backgroundColor;
    const hasBg = bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
    const hasBorder = parseFloat(s.borderLeftWidth) > 0 || parseFloat(s.borderRightWidth) > 0;
    return hasBg || hasBorder;
  };
  const clipper = (el: Element): Element | null => {
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      const o = style(e).overflowX;
      if (o !== "visible") return e;
    }
    return null;
  };
  const readable = (el: Element): boolean =>
    !!el.closest("summary, a[href], button, [title], label") || el.hasAttribute("title");
  const check = (el: Element, rect: DOMRect, text: string) => {
    if (rect.width < 1 || rect.height < 1) return;
    const clip = clipper(el);
    if (clip) {
      const c = clip.getBoundingClientRect();
      const out = Math.max(rect.right - c.right, c.left - rect.left);
      if (out > 1) {
        const s = style(clip);
        if (s.overflowX === "auto" || s.overflowX === "scroll") return; // scrolls: readable
        if (s.textOverflow === "ellipsis" || style(clip).webkitLineClamp !== "none") {
          if (!readable(clip)) add("clipped", clip, text, out);
          return;
        }
        add("clipped", clip, text, out);
        return;
      }
    }
    // The text box itself, then every box up to the column, must hold it.
    for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
      if (!isBox(e)) continue;
      const b = e.getBoundingClientRect();
      const out = Math.max(rect.right - b.right, b.left - rect.left);
      if (out > 1.5) {
        add("spill", el, text, out);
        return;
      }
      if (e.matches(".col, section.sheet, .sidebar, main.screen, [role=dialog], .menu")) return;
    }
  };

  for (const el of document.querySelectorAll("[role=dialog], [role=menu]")) {
    if (hidden(el)) continue;
    const r = el.getBoundingClientRect();
    const out = Math.max(-r.left, r.right - window.innerWidth);
    if (out > 1) add("offscreen", el, el.getAttribute("aria-label") ?? el.getAttribute("role") ?? "", out);
  }
  // Scrolled to the end, nothing you'd press may sit under the floating "+".
  const fab = document.querySelector("button.fab");
  if (fab && !hidden(fab) && !document.querySelector("section.sheet")) {
    const y = window.scrollY;
    window.scrollTo(0, document.documentElement.scrollHeight);
    const f = fab.getBoundingClientRect();
    for (const el of document.querySelectorAll("button, a[href], input, select, textarea, summary")) {
      if (el === fab || hidden(el) || el.closest("nav.tabbar")) continue;
      const r = el.getBoundingClientRect();
      const w = Math.min(r.right, f.right) - Math.max(r.left, f.left);
      const h = Math.min(r.bottom, f.bottom) - Math.max(r.top, f.top);
      if (w > 4 && h > 4) add("covered", el, el.getAttribute("aria-label") ?? el.textContent ?? el.tagName, Math.min(w, h));
    }
    window.scrollTo(0, y);
  }
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const el = t.parentElement;
    if (!el || !t.data.trim() || hidden(el) || el.closest("script, style, [data-sweep-skip]")) continue;
    const range = document.createRange();
    range.selectNodeContents(t);
    for (const r of range.getClientRects()) check(el, r, t.data);
  }
  for (const el of document.querySelectorAll("img, svg, input, select, textarea, button")) {
    if (hidden(el) || el.closest("svg svg")) continue;
    check(el, el.getBoundingClientRect(), el.getAttribute("aria-label") ?? el.textContent ?? el.tagName);
  }
  // A text container whose content is wider than it, without a scrollbar.
  for (const el of document.querySelectorAll("body *")) {
    if (hidden(el) || el.closest("svg")) continue;
    const s = style(el);
    if (s.overflowX !== "visible" || s.display === "inline" || s.display === "contents") continue;
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0 && [...el.childNodes].some((c) => c.nodeType === 3 && c.textContent?.trim())) {
      add("overflow", el, el.textContent ?? "", el.scrollWidth - el.clientWidth);
    }
  }
  return flags;
}
