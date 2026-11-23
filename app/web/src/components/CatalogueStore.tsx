import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { afterSave, EMPTY_LIST, type ListMemory } from "../catalogue";
import { useWrites, type Writes } from "../hooks";
import { KEEP_ENTRY } from "./Sheet";

/**
 * An edit in progress: the values the edit started from (taken when Edit
 * was pressed, so a quiet re-read of the record never turns someone
 * else's change into "mine"; plan review #4), the fields as typed, the
 * reason, and an override reason once the API asked for one.
 */
export interface EditDraft {
  start: Record<string, string>;
  fields: Record<string, string>;
  reason: string;
  override: string | null;
}

interface CatalogueStore {
  /** Every catalogue write, keyed by what it writes ("food:12:edit"): its status and its held plan. */
  writes: Writes;
  /** Bumped after each catalogue Save that landed: open records re-read. */
  saved: number;
  /** The foods list: its query, chip and pages shown, kept across the phone's list, record and back. */
  list: ListMemory;
  setList(update: (m: ListMemory) => ListMemory): void;
  draft(key: string): EditDraft | null;
  setDraft(key: string, draft: EditDraft | null): void;
}

const StoreContext = createContext<CatalogueStore | null>(null);

/**
 * The catalogue's writes, their held plans and every edit in progress,
 * above the layout switch (desktop spec §2, review #12): crossing 1024 px,
 * or the phone moving from the list to a record, never loses a typed edit
 * or a held plan's keys. A sign-out keeps the entry (KEEP_ENTRY).
 */
export function CatalogueStoreProvider({ children }: { children: ReactNode }) {
  const [saved, setSaved] = useState(0);
  const [list, setListState] = useState<ListMemory>(EMPTY_LIST);
  const [drafts, setDrafts] = useState<ReadonlyMap<string, EditDraft>>(new Map());
  const writes = useWrites(
    useCallback(() => {
      setSaved((n) => n + 1);
      setListState(afterSave);
    }, []),
    KEEP_ENTRY,
  );
  const setList = useCallback((update: (m: ListMemory) => ListMemory) => setListState(update), []);
  const setDraft = useCallback((key: string, draft: EditDraft | null) => {
    setDrafts((m) => {
      const next = new Map(m);
      if (draft === null) next.delete(key);
      else next.set(key, draft);
      return next;
    });
  }, []);
  const store: CatalogueStore = { writes, saved, list, setList, draft: (key) => drafts.get(key) ?? null, setDraft };
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useCatalogueStore(): CatalogueStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useCatalogueStore outside CatalogueStoreProvider");
  return store;
}

/** A small form's draft in the store: open while it has one; closing clears its status too. */
export function useFormDraft(key: string, empty: Record<string, string>) {
  const store = useCatalogueStore();
  const d = store.draft(key);
  const base = d ?? { start: empty, fields: empty, reason: "", override: null };
  return {
    open: d !== null,
    fields: base.fields,
    reason: base.reason,
    start: () => store.setDraft(key, { start: empty, fields: empty, reason: "", override: null }),
    set: (field: string, value: string) => store.setDraft(key, { ...base, fields: { ...base.fields, [field]: value } }),
    setReason: (value: string) => store.setDraft(key, { ...base, reason: value }),
    close: () => {
      store.setDraft(key, null);
      store.writes.clear(key);
    },
  };
}
