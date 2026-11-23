import { useEffect, useRef, useState } from "react";
import { callTool } from "../../api";
import { appendPage, withPages, type ListRow } from "../../catalogue";
import { useLoad, type Loaded } from "../../hooks";
import type { CatalogueListPage } from "../../types";
import { useCatalogueStore } from "../CatalogueStore";

/**
 * A catalogue_list kind, 200 a page: the first page through useLoad (cached
 * by kind), "Show more" for the next, a row never listed twice. The pages
 * shown live in the catalogue store, so the phone's list, record and back
 * keep them. A catalogue Save that landed re-reads from the first page, and
 * a "Show more" still in flight from before it is dropped.
 */
export function usePaged<T>(kind: "food_source" | "recipe" | "exercise" | "gym", toRows: (items: readonly T[]) => ListRow[]) {
  const store = useCatalogueStore();
  const first = useLoad(() => callTool<CatalogueListPage<T>>("catalogue_list", { kind }), `cat-list|${kind}`);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const generation = useRef(0);
  const seen = useRef(store.saved);
  useEffect(() => {
    // Only a new catalogue Save re-reads (not a remount).
    if (store.saved === seen.current) return;
    seen.current = store.saved;
    generation.current += 1;
    setStatus("idle");
    first.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store.saved]);
  const extra = store.list.pages[kind] ?? null;
  const page = first.state.kind === "ready" ? first.state.data : null;
  const base = page ? toRows(page.items) : [];
  const rows = extra ? appendPage(base, extra.rows) : base;
  const next = extra ? extra.next : (page?.next_offset ?? null);
  const loadMore = async () => {
    if (next === null) return;
    const mine = generation.current;
    setStatus("loading");
    const out = await callTool<CatalogueListPage<T>>("catalogue_list", { kind, offset: next });
    if (mine !== generation.current) return;
    if (out.kind !== "ok") return setStatus("error");
    store.setList((m) => withPages(m, kind, { rows: appendPage(m.pages[kind]?.rows ?? [], toRows(out.data.items)), next: out.data.next_offset }));
    setStatus("idle");
  };
  return { rows, next, loadMore, status, state: first.state as Loaded<CatalogueListPage<T>>, reload: first.reload };
}
