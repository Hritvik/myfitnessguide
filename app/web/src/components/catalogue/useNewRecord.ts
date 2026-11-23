import { createdHref } from "../../catalogue";
import { useCatalogueStore } from "../CatalogueStore";
import type { WriteResult, Writes } from "../../hooks";
import type { Go } from "./Panes";

/**
 * What the new-food and new-recipe forms share: `land` is the plan's
 * after-save, so once it lands (first try or Try again, decision 74) the
 * draft and status are dropped and the new record opens by the ref the API
 * allocated.
 */
export function useNewRecord(key: string, kind: "food" | "recipe", go: Go, onClose: () => void): { writes: Writes; land: (out: WriteResult) => void } {
  const store = useCatalogueStore();
  const land = (out: WriteResult) => {
    if (out.status.state !== "saved") return;
    const href = createdHref(kind, out.results[0]);
    store.setDraft(key, null);
    store.writes.clear(key);
    if (href) go(href);
    else onClose();
  };
  return { writes: store.writes, land };
}
