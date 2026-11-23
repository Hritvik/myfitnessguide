/**
 * The breakpoint (desktop spec §2): one media query picks the layout. At
 * 1024 px and wider, the wide layout (the sidebar, two columns, the "+"
 * sheet as a side panel); below it, the phone's, untouched.
 */
import { useEffect, useState } from "react";

export const WIDE_QUERY = "(min-width: 1024px)";

/** The part of a MediaQueryList this reads, so a test can hand in its own. */
export interface WideMedia {
  matches: boolean;
  addEventListener(type: "change", listener: (e: { matches: boolean }) => void): void;
  removeEventListener(type: "change", listener: (e: { matches: boolean }) => void): void;
}

/** Calls `on` with each crossing of the breakpoint; returns the unsubscribe. */
export function watchWide(media: WideMedia, on: (wide: boolean) => void): () => void {
  const listener = (e: { matches: boolean }) => on(e.matches);
  media.addEventListener("change", listener);
  return () => media.removeEventListener("change", listener);
}

const media = (): WideMedia | null => (typeof matchMedia === "function" ? matchMedia(WIDE_QUERY) : null);

/** True at 1024 px and wider. Read once before the first paint, so the first frame is already the right layout. */
export function useWide(): boolean {
  const [wide, setWide] = useState(() => media()?.matches ?? false);
  useEffect(() => {
    const m = media();
    if (!m) return;
    setWide(m.matches);
    return watchWide(m, setWide);
  }, []);
  return wide;
}

export type Slot = "sidebar" | "topbar" | "screen" | "tabbar";

/**
 * The app frame's fixed slots, in order. The screen keeps its slot in both
 * layouts (and SheetHost and the catalogue store sit above the frame), so
 * crossing the breakpoint remounts neither the screen nor the sheet, and
 * no write store or held plan is lost (desktop spec §2, review #12).
 */
export function appSlots(wide: boolean): (Slot | null)[] {
  return wide ? ["sidebar", null, "screen", null] : [null, "topbar", "screen", "tabbar"];
}
