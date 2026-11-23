/**
 * The keyboard (desktop spec §6), pure: which key does what, given whether
 * focus is in a field and whether a G is pending. Esc acts everywhere;
 * every other key is ignored while typing and with Ctrl, Cmd or Alt, so
 * the browser's and the system's shortcuts are never taken.
 */
import type { Section } from "./route";

export type KeyAction =
  | { kind: "open-sheet"; tab: "food" | "text" }
  | { kind: "focus-search" }
  | { kind: "row"; dir: 1 | -1 }
  | { kind: "edit" }
  | { kind: "escape" }
  | { kind: "go"; section: Section }
  | { kind: "help" };

export interface KeyInput {
  key: string;
  shift: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  /** Focus is in a text field: an input you type in, a textarea, a select or editable text. */
  typing: boolean;
  /** An input method is composing (IME): every key, Esc included, belongs to it. */
  composing?: boolean;
}

/** A key event that belongs to an IME composition (Esc that ends one must never close or cancel anything). */
export function isComposing(e: { isComposing?: boolean; keyCode?: number }): boolean {
  return !!e.isComposing || e.keyCode === 229;
}

/** How long a pressed G waits for its letter. */
export const CHORD_MS = 1500;

/** Whether a G pressed at `pressedAt` still waits for its letter at `now`. */
export function chordAlive(pressedAt: number | null, now: number): boolean {
  return pressedAt !== null && now - pressedAt >= 0 && now - pressedAt <= CHORD_MS;
}

const GO: Record<string, Section> = { t: "today", r: "train", p: "progress", h: "household", c: "catalogue" };
const NONE = { action: null, pending: null };

export function keyAction(k: KeyInput, pending: "g" | null): { action: KeyAction | null; pending: "g" | null } {
  if (k.composing) return NONE;
  if (k.key === "Escape") return { action: { kind: "escape" }, pending: null };
  if (k.typing || k.ctrl || k.meta || k.alt) return NONE;
  const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
  if (pending === "g") {
    const section = GO[key];
    return { action: section ? { kind: "go", section } : null, pending: null };
  }
  switch (key) {
    case "n":
      return { action: { kind: "open-sheet", tab: k.shift ? "text" : "food" }, pending: null };
    case "/":
      return { action: { kind: "focus-search" }, pending: null };
    case "?":
      return { action: { kind: "help" }, pending: null };
    case "j":
      return { action: { kind: "row", dir: 1 }, pending: null };
    case "k":
      return { action: { kind: "row", dir: -1 }, pending: null };
    case "e":
      return { action: { kind: "edit" }, pending: null };
    case "g":
      return { action: null, pending: "g" };
    default:
      return NONE;
  }
}

/** The "?" list: the spec's table, in its words. */
export const KEY_HELP: readonly { keys: string; does: string }[] = [
  { keys: "N", does: "Open the + sheet on Food (Shift+N: Tell Claude)" },
  { keys: "/", does: "Search on this screen (the catalogue, or the sheet's Food search)" },
  { keys: "J / K", does: "Next or previous row in a list (sessions, the catalogue, Waiting on you)" },
  { keys: "Enter", does: "Open the selected link or button" },
  { keys: "E", does: "Edit the open catalogue record" },
  { keys: "Esc", does: "Close the sheet, cancel an edit, close a menu, leave the search (not while a save is going through)" },
  { keys: "G then T, R, P, H or C", does: "Go to Today, Train, Progress, Household or Catalogue" },
  { keys: "?", does: "Show this list" },
];

/** What covers the screen: nothing, the phone's modal "+" sheet, or another dialog or menu (feedback, More, the list of keys). */
export type Cover = "none" | "sheet" | "other";

/**
 * Whether a key waits because something covers the screen. N and / act on
 * the "+" sheet, so they still reach the phone's modal sheet; J/K, E and G
 * act on the screen behind and wait under any cover. Esc is never held
 * here: each dialog handles its own.
 */
export function waitsBehind(kind: KeyAction["kind"], cover: Cover): boolean {
  if (cover === "none" || kind === "escape") return false;
  if (kind === "open-sheet" || kind === "focus-search") return cover === "other";
  return true;
}

/** J and K: the next row, from none to the first (or the last), stopping at the ends; -1 when the list is empty. */
export function nextRow(current: number, count: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return dir === 1 ? 0 : count - 1;
  return Math.min(count - 1, Math.max(0, current + dir));
}

/** A menu's focus trap: Tab and Shift+Tab wrap inside it; -1 when it has no items. */
export function trapIndex(current: number, count: number, back: boolean): number {
  if (count === 0) return -1;
  if (current < 0) return back ? count - 1 : 0;
  return (current + (back ? -1 : 1) + count) % count;
}

/**
 * What Esc does, outermost first: the list of keys, then the sheet, then an
 * open edit. A sheet with a save going through or a send held for "Try
 * again" stays open, and an edit whose save is going through stays open:
 * Esc then does nothing (it never reaches past them to something behind).
 * With nothing open, Esc in the screen's search leaves the field, so J and
 * K move through what it found.
 */
export function escapeStep(s: { help: boolean; sheet: "closed" | "open" | "busy"; edit: "none" | "open" | "busy"; search?: boolean }): "close-help" | "close-sheet" | "cancel-edit" | "leave-search" | null {
  if (s.help) return "close-help";
  if (s.sheet === "busy") return null;
  if (s.sheet === "open") return "close-sheet";
  if (s.edit !== "none") return s.edit === "open" ? "cancel-edit" : null;
  return s.search ? "leave-search" : null;
}

/** Input types that are pressed, not typed in: J, K and the rest still work from them (a ticked row in Waiting on you). */
const PRESSED = new Set(["checkbox", "radio", "button", "submit", "reset", "range", "color", "file", "image"]);

/** Whether focus is somewhere you type: the keys then leave it alone (except Esc). */
export function isTyping(el: { tagName: string; isContentEditable?: boolean; type?: string } | null): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  return el.tagName === "INPUT" && !PRESSED.has((el.type ?? "text").toLowerCase());
}
