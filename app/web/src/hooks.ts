import type React from "react";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { callTool, type Outcome } from "./api";
import { brandedTitle } from "./brand";
import { parsePlace, type Place } from "./route";
import type { SheetTarget } from "./sheet";
import { holdsForRetry, writeBook, type AfterSave, type AnswerPath, type Plan, type WriteBook, type WriteResult, type WriteStatus } from "./writes";

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener("online", on);
    addEventListener("offline", off);
    return () => {
      removeEventListener("online", on);
      removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export type { WriteResult } from "./writes";

/** One key's Save, for a form with one Save button (each tab of the "+" sheet). */
export interface WriteSlot {
  status: WriteStatus | null;
  busy: boolean;
  /** `after` is the form's post-save step (close, reset); "Try again" runs it too (decision 74). */
  run(plan: Plan, after?: AfterSave): Promise<WriteResult>;
  retry(): Promise<WriteResult | null>;
  /** Answers the slot's question with the asked plan's own keys (writeBook's `answer`). */
  answer(tool: string, path: AnswerPath, value: unknown, current: Record<string, unknown> | null): Promise<WriteResult | null>;
  /** Whether the form's current entry for `tool` is still the one its question was asked about. */
  matches(tool: string, current: Record<string, unknown> | null): boolean;
  canRetry: boolean;
  clear(): void;
}

export interface Writes {
  status(key: string): WriteStatus | null;
  run(key: string, plan: Plan, after?: AfterSave): Promise<WriteResult>;
  retry(key: string): Promise<WriteResult | null>;
  /** Answers the key's question with the asked plan's own keys (writeBook's `answer`). */
  answer(key: string, tool: string, path: AnswerPath, value: unknown, current: Record<string, unknown> | null): Promise<WriteResult | null>;
  matches(key: string, tool: string, current: Record<string, unknown> | null): boolean;
  canRetry(key: string): boolean;
  clear(key: string): void;
  slot(key: string): WriteSlot;
  busy: boolean;
}

/**
 * Writes going through, counted by whoever provides this (the "+" sheet), so a
 * save still in flight after its tab has gone keeps the sheet busy. Outside
 * a provider nothing counts.
 */
export const InFlightContext = createContext<(delta: 1 | -1) => void>(() => {});

/**
 * Writes held for "Try again" (a failed plan the form keeps), counted by
 * whoever provides this (the "+" sheet), so Esc never closes a sheet over a
 * held Save it could no longer resend (click test P2-27). Outside a
 * provider nothing counts.
 */
export const HeldContext = createContext<(delta: number) => void>(() => {});

/** Counts `work` as in flight from start to finish, whether it lands, fails or throws. */
export async function trackInFlight<T>(report: (delta: 1 | -1) => void, work: () => Promise<T>): Promise<T> {
  report(1);
  try {
    return await work();
  } finally {
    report(-1);
  }
}

/**
 * Write statuses keyed by the thing written ("pot:11", "item:5", a sheet
 * tab's "save"). A saved write calls onSaved (to re-read); a sign-out calls
 * onSignedOut, which each caller chooses: Today reloads, the sheet keeps
 * the entry (KEEP_ENTRY). The last plan per key is kept, with the form's
 * `after`, so "Try again" resends the same keys and, once it lands, does
 * what the form's own Save would have (writeBook); a saved key's plan is
 * dropped, so the next Save is a new plan.
 */
export function useWrites(onSaved: () => void, onSignedOut: () => void): Writes {
  const [statuses, setStatuses] = useState<Record<string, WriteStatus>>({});
  const report = useContext(InFlightContext);
  const handlers = useRef({ onSaved, onSignedOut, report });
  handlers.current = { onSaved, onSignedOut, report };
  const book = useRef<WriteBook | null>(null);
  book.current ??= writeBook((tool, input) => callTool(tool, input), {
    status: (key, status) => setStatuses((s) => ({ ...s, [key]: status })),
    saved: () => handlers.current.onSaved(),
    signedOut: () => handlers.current.onSignedOut(),
    // The "+" sheet counts each attempt (first tap or Try again) as in flight until its answer is in.
    track: (work) => trackInFlight(handlers.current.report, work),
  });
  const { run, retry, answer, matches, holds } = book.current;
  const pending = Object.values(statuses).some((s) => s.state === "pending");
  const canRetry = (key: string) => holdsForRetry(statuses[key]) && holds(key);
  // Each key held for Try again is reported while it is held, and given back when the form goes.
  const reportHeld = useContext(HeldContext);
  const heldCount = Object.keys(statuses).filter(canRetry).length;
  useEffect(() => {
    if (heldCount === 0) return;
    reportHeld(heldCount);
    return () => reportHeld(-heldCount);
  }, [heldCount, reportHeld]);
  const clear = (key: string) =>
    setStatuses((s) => {
      const { [key]: _gone, ...rest } = s;
      return rest;
    });

  return {
    status: (key) => statuses[key] ?? null,
    run,
    retry,
    answer,
    matches,
    canRetry,
    clear,
    slot: (key) => ({
      status: statuses[key] ?? null,
      busy: statuses[key]?.state === "pending",
      run: (plan, after) => run(key, plan, after),
      retry: () => retry(key),
      answer: (tool, path, value, current) => answer(key, tool, path, value, current),
      matches: (tool, current) => matches(key, tool, current),
      canRetry: canRetry(key),
      clear: () => clear(key),
    }),
    busy: pending,
  };
}

export type Loaded<T> =
  | { kind: "loading" }
  | { kind: "ready"; data: T; loadedAt: Date }
  | { kind: "signed_out" }
  | { kind: "offline" }
  | { kind: "error"; message: string };

/**
 * Loads a screen's data, keyed by what it depends on. The last answer per key
 * is kept, so coming back to a screen shows it at once and re-reads quietly. Re-reads quietly
 * (no skeleton) when the phone comes back online or the app comes back
 * to the front, and after a write. A late answer to an old key is dropped.
 */
const lastReady = new Map<string, { data: unknown; loadedAt: Date }>();

/** What a key last loaded, so a tab that is left and re-entered shows it at once and re-reads quietly. */
const cached = <T,>(key: string): Loaded<T> | null => {
  const hit = lastReady.get(key);
  return hit ? { kind: "ready", data: hit.data as T, loadedAt: hit.loadedAt } : null;
};

/** What a failed (offline or error) read leaves on screen: a view already loaded stays, with its retry line, rather than an error screen. */
export function afterFailure<T>(s: Loaded<T>, out: Exclude<Outcome<T>, { kind: "ok" } | { kind: "signed_out" }>): Loaded<T> {
  if (s.kind === "ready") return s;
  if (out.kind === "offline") return { kind: "offline" };
  return { kind: "error", message: "message" in out ? out.message : "The API asked a question the screen can't answer." };
}

/** The state to show for `key`: what `owner` last loaded for is shown as is; for any other key, that key's cached answer or loading. */
export function forKey<T>(owner: string, key: string, state: Loaded<T>, cachedOf: (key: string) => Loaded<T> | null): Loaded<T> {
  return owner === key ? state : (cachedOf(key) ?? { kind: "loading" });
}

export function useLoad<T>(load: () => Promise<Outcome<T>>, key: string): { state: Loaded<T>; reload: () => void } {
  const [state, setState] = useState<Loaded<T>>(() => cached<T>(key) ?? { kind: "loading" });
  const latest = useRef(0);
  const owner = useRef(key);
  const loader = useRef(load);
  loader.current = load;
  const online = useOnline();

  const run = useCallback(
    async (quiet: boolean) => {
      const ticket = ++latest.current;
      owner.current = key;
      const hit = cached<T>(key);
      if (!quiet) setState(hit ?? { kind: "loading" });
      const out = await loader.current();
      if (ticket !== latest.current) return;
      if (out.kind === "ok") {
        const loadedAt = new Date();
        lastReady.set(key, { data: out.data, loadedAt });
        setState({ kind: "ready", data: out.data, loadedAt });
      }
      else if (out.kind === "signed_out") setState({ kind: "signed_out" });
      else setState((s) => afterFailure(s, out));
    },
    // The key names everything the load depends on.
    [key],
  );

  useEffect(() => {
    void run(false);
  }, [run]);
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) void run(true);
    wasOnline.current = online;
  }, [online, run]);
  useEffect(() => {
    const onShow = () => {
      if (document.visibilityState === "visible") void run(true);
    };
    document.addEventListener("visibilitychange", onShow);
    return () => document.removeEventListener("visibilitychange", onShow);
  }, [run]);

  // For the render a new key arrives in, the state still belongs to the old key: say loading (or the new key's cached answer).
  const shown = forKey(owner.current, key, state, cached<T>);
  // reload always re-reads the current key, even when a write that began under an older key calls it.
  const runRef = useRef(run);
  runRef.current = run;
  return { state: shown, reload: useCallback(() => void runRef.current(true), []) };
}

/** The current place, from the URL; `go` pushes a new one. The back button works. */
export function useLocation(): { place: Place; go: (href: string) => void } {
  const [place, setPlace] = useState<Place>(() => parsePlace(location.pathname, location.search));
  useEffect(() => {
    const onPop = () => setPlace(parsePlace(location.pathname, location.search));
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const go = useCallback((href: string) => {
    history.pushState(null, "", href);
    const u = new URL(href, location.origin);
    setPlace(parsePlace(u.pathname, u.search));
  }, []);
  return { place, go };
}

/** A horizontal swipe of at least 60 px: left calls onLeft, right calls onRight. */
export function useSwipe(onLeft: () => void, onRight: () => void) {
  const start = useRef<{ x: number; y: number } | null>(null);
  return {
    onTouchStart: (e: React.TouchEvent) => {
      const t = e.touches[0];
      start.current = t ? { x: t.clientX, y: t.clientY } : null;
    },
    onTouchEnd: (e: React.TouchEvent) => {
      const t = e.changedTouches[0];
      const s = start.current;
      start.current = null;
      if (!t || !s) return;
      const dx = t.clientX - s.x;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(t.clientY - s.y) * 2) return;
      if (dx < 0) onLeft();
      else onRight();
    },
  };
}

/** Opens the "+" sheet from anywhere: the FAB, a meal tier, a Train row. */
/** `busy`: a save in the sheet is going through, or a send is held for "Try again"; Esc then leaves the sheet open. */
export const SheetContext = createContext<{ open(target: SheetTarget, from?: HTMLElement | null): void; close(): void; isOpen: boolean; busy(): boolean }>({ open: () => {}, close: () => {}, isOpen: false, busy: () => false });
export const useSheet = () => useContext(SheetContext);

/** Bumped after every successful Save in the sheet; screens re-read when it changes. */
export const SavedContext = createContext(0);
export const useSaved = () => useContext(SavedContext);

/** The value, once it has stopped changing for `ms` (previews are debounced, spec §10). */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/**
 * While `unsaved` is true, reloading or leaving the page asks first (the
 * browser's own "Leave site?"), so typed text in an open edit or the Tell
 * Claude box, or a Save held for Try again, is never dropped silently
 * (click test P2-27).
 */
export function useUnsavedGuard(unsaved: boolean): void {
  useEffect(() => {
    if (!unsaved) return;
    const ask = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    addEventListener("beforeunload", ask);
    return () => removeEventListener("beforeunload", ask);
  }, [unsaved]);
}

/** The page title becomes a record's own name once it has loaded (desktop spec §2); the route's title stands until then. */
export function useTitle(name: string | null): void {
  useEffect(() => {
    if (name) document.title = brandedTitle(name);
  }, [name]);
}
