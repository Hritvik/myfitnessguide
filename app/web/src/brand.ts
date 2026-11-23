export const PRODUCT_NAME = "MyFitnessGuide";

export function brandedTitle(page?: string): string {
  return page ? `${page} · ${PRODUCT_NAME}` : PRODUCT_NAME;
}
