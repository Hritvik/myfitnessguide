import { describe, expect, it } from "vitest";
import { appSlots, watchWide, WIDE_QUERY, type WideMedia } from "../src/wide";

function fakeMedia(matches: boolean) {
  const listeners = new Set<(e: { matches: boolean }) => void>();
  const media: WideMedia = {
    matches,
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
  };
  return { media, cross: (to: boolean) => listeners.forEach((l) => l({ matches: to })), listeners };
}

describe("the breakpoint", () => {
  it("is 1024 px and wider (1023 is the phone's)", () => {
    expect(WIDE_QUERY).toBe("(min-width: 1024px)");
  });

  it("reports each crossing, both ways, until unsubscribed", () => {
    const f = fakeMedia(false);
    const seen: boolean[] = [];
    const stop = watchWide(f.media, (w) => seen.push(w));
    f.cross(true);
    f.cross(false);
    f.cross(true);
    stop();
    f.cross(false);
    expect(seen).toEqual([true, false, true]);
    expect(f.listeners.size).toBe(0);
  });
});

describe("the frame's slots", () => {
  // Desktop spec §2 and review #12: crossing the breakpoint remounts neither the screen nor the sheet.
  it("keeps the screen in the same slot in both layouts, so crossing never remounts it", () => {
    expect(appSlots(false)).toEqual([null, "topbar", "screen", "tabbar"]);
    expect(appSlots(true)).toEqual(["sidebar", null, "screen", null]);
    expect(appSlots(true).indexOf("screen")).toBe(appSlots(false).indexOf("screen"));
    expect(appSlots(true)).toHaveLength(appSlots(false).length);
  });
});
