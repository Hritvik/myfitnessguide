/**
 * Two shots compared in the page's own canvas (no image library): the share of
 * pixels that differ at all, and how many by more than 64 in a channel, or the
 * two sizes when they differ (wide-layout spec §7's measured method).
 */
import type { Page } from "@playwright/test";

/** At most this share of a shot's pixels may differ. */
export const PIXEL_LIMIT = 0.005;

export async function pixelDiff(page: Page, a: Buffer, b: Buffer): Promise<{ share: number; big: number } | { size: string }> {
  return page.evaluate(async ([x, y]: [string, string]) => {
    const load = (src: string) =>
      new Promise<HTMLImageElement>((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = rej;
        i.src = `data:image/png;base64,${src}`;
      });
    const [ia, ib] = await Promise.all([load(x), load(y)]);
    if (ia.width !== ib.width || ia.height !== ib.height) return { size: `${ia.width}x${ia.height} vs ${ib.width}x${ib.height}` };
    const c = document.createElement("canvas");
    c.width = ia.width;
    c.height = ia.height;
    const g = c.getContext("2d")!;
    g.drawImage(ia, 0, 0);
    const da = g.getImageData(0, 0, c.width, c.height).data;
    g.clearRect(0, 0, c.width, c.height);
    g.drawImage(ib, 0, 0);
    const db = g.getImageData(0, 0, c.width, c.height).data;
    let any = 0;
    let big = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i]! - db[i]!), Math.abs(da[i + 1]! - db[i + 1]!), Math.abs(da[i + 2]! - db[i + 2]!));
      if (d > 0) any++;
      if (d > 64) big++;
    }
    return { share: any / (da.length / 4), big };
  }, [a.toString("base64"), b.toString("base64")] as [string, string]);
}
