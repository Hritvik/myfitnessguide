import { describe, expect, it } from "vitest";
import { chordAlive, CHORD_MS, escapeStep, isComposing, isTyping, KEY_HELP, keyAction, nextRow, trapIndex, waitsBehind, type KeyInput } from "../src/keys";

const press = (key: string, over: Partial<KeyInput> = {}, pending: "g" | null = null) => keyAction({ key, shift: false, ctrl: false, meta: false, alt: false, typing: false, ...over }, pending);

describe("the keyboard map", () => {
  it("does what the spec's table says", () => {
    expect(press("n").action).toEqual({ kind: "open-sheet", tab: "food" });
    expect(press("N", { shift: true }).action).toEqual({ kind: "open-sheet", tab: "text" });
    expect(press("/").action).toEqual({ kind: "focus-search" });
    expect(press("j").action).toEqual({ kind: "row", dir: 1 });
    expect(press("k").action).toEqual({ kind: "row", dir: -1 });
    expect(press("e").action).toEqual({ kind: "edit" });
    expect(press("Escape").action).toEqual({ kind: "escape" });
    expect(press("?", { shift: true }).action).toEqual({ kind: "help" });
  });

  it("goes to a section with G then T, R, P, H or C", () => {
    const g = press("g");
    expect(g).toEqual({ action: null, pending: "g" });
    expect(["t", "r", "p", "h", "c"].map((k) => press(k, {}, "g").action)).toEqual([
      { kind: "go", section: "today" }, { kind: "go", section: "train" }, { kind: "go", section: "progress" }, { kind: "go", section: "household" }, { kind: "go", section: "catalogue" },
    ]);
  });

  // Review Focus 4: modifiers and fields.
  it("ignores every key but Esc while typing in a field", () => {
    for (const key of ["n", "/", "j", "k", "e", "g", "?"]) expect(press(key, { typing: true }), key).toEqual({ action: null, pending: null });
    expect(press("Escape", { typing: true }).action).toEqual({ kind: "escape" });
  });

  it("never fires with Ctrl, Cmd or Alt, so the browser's shortcuts stay the browser's", () => {
    expect(press("n", { ctrl: true }).action).toBeNull();
    expect(press("k", { meta: true }).action).toBeNull();
    expect(press("g", { alt: true })).toEqual({ action: null, pending: null });
  });

  it("ends a G chord on any other key, doing nothing", () => {
    expect(press("x", {}, "g")).toEqual({ action: null, pending: null });
    expect(press("n", { typing: true }, "g")).toEqual({ action: null, pending: null });
  });

  it("lists every key the spec names", () => {
    expect(KEY_HELP.map((k) => k.keys)).toEqual(["N", "/", "J / K", "Enter", "E", "Esc", "G then T, R, P, H or C", "?"]);
  });

  // Ledger ruling: the sheet's last tab is Tell Claude, where Enter is a new line and Send is the button.
  // Final review P2-2: Waiting on you's rows are checkboxes and spans, so Enter promises only what the browser does.
  it("says Shift+N opens Tell Claude, and Enter only opens the selected link or button", () => {
    expect(KEY_HELP.find((k) => k.keys === "N")?.does).toBe("Open the + sheet on Food (Shift+N: Tell Claude)");
    expect(KEY_HELP.find((k) => k.keys === "Enter")?.does).toBe("Open the selected link or button");
  });
});

describe("an input method composing (IME)", () => {
  it("owns every key, Esc included, so ending a composition never closes or cancels anything", () => {
    for (const key of ["Escape", "n", "j", "g", "?"]) expect(press(key, { composing: true }), key).toEqual({ action: null, pending: null });
    expect(press("t", { composing: true }, "g")).toEqual({ action: null, pending: null });
  });

  it("is told by isComposing or by keyCode 229", () => {
    expect([isComposing({ isComposing: true }), isComposing({ keyCode: 229 }), isComposing({ isComposing: false, keyCode: 27 }), isComposing({})]).toEqual([true, true, false, false]);
  });
});

describe("a G waiting for its letter", () => {
  it("waits 1.5 s, then the chord is dropped", () => {
    expect(CHORD_MS).toBe(1500);
    expect([chordAlive(1000, 1000), chordAlive(1000, 2500), chordAlive(1000, 2501), chordAlive(null, 1000), chordAlive(2000, 1000)]).toEqual([true, true, false, false, false]);
  });
});

describe("what counts as typing", () => {
  it("is a text field, a textarea, a select or editable text, not a checkbox or a button", () => {
    expect([{ tagName: "INPUT", type: "text" }, { tagName: "INPUT", type: "search" }, { tagName: "INPUT", type: "date" }, { tagName: "INPUT" }, { tagName: "TEXTAREA" }, { tagName: "SELECT" }, { tagName: "DIV", isContentEditable: true }].map(isTyping)).toEqual([true, true, true, true, true, true, true]);
    expect([{ tagName: "INPUT", type: "checkbox" }, { tagName: "INPUT", type: "radio" }, { tagName: "BUTTON" }, { tagName: "A" }, null].map(isTyping)).toEqual([false, false, false, false, false]);
  });
});

describe("Esc", () => {
  it("closes the list of keys first, then the sheet, then cancels an edit", () => {
    expect(escapeStep({ help: true, sheet: "open", edit: "open" })).toBe("close-help");
    expect(escapeStep({ help: false, sheet: "open", edit: "open" })).toBe("close-sheet");
    expect(escapeStep({ help: false, sheet: "closed", edit: "open" })).toBe("cancel-edit");
    expect(escapeStep({ help: false, sheet: "closed", edit: "none" })).toBeNull();
  });

  // The visual pass (Task 26): Esc in the screen's search leaves the field, so J and K move through what it found.
  it("leaves the screen's search when nothing else is open, and never before what is", () => {
    expect(escapeStep({ help: false, sheet: "closed", edit: "none", search: true })).toBe("leave-search");
    expect(escapeStep({ help: false, sheet: "closed", edit: "open", search: true })).toBe("cancel-edit");
    expect(escapeStep({ help: false, sheet: "open", edit: "none", search: true })).toBe("close-sheet");
    expect(escapeStep({ help: false, sheet: "busy", edit: "none", search: true })).toBeNull();
    expect(escapeStep({ help: false, sheet: "closed", edit: "busy", search: true })).toBeNull();
  });

  // Ledger ruling 2: a save going through, or a send held for Try again, is never thrown away by Esc.
  it("does nothing while the sheet's save is pending or its send is held, or while an edit is saving", () => {
    expect(escapeStep({ help: false, sheet: "busy", edit: "none" })).toBeNull();
    expect(escapeStep({ help: false, sheet: "busy", edit: "open" })).toBeNull();
    expect(escapeStep({ help: false, sheet: "closed", edit: "busy" })).toBeNull();
  });
});

describe("moving through a list", () => {
  it("starts at the first row (J) or the last (K), and stops at the ends", () => {
    expect([nextRow(-1, 5, 1), nextRow(-1, 5, -1), nextRow(2, 5, 1), nextRow(4, 5, 1), nextRow(0, 5, -1), nextRow(-1, 0, 1)]).toEqual([0, 4, 3, 4, 0, -1]);
  });
});

describe("a menu's focus trap", () => {
  it("wraps Tab and Shift+Tab inside the menu", () => {
    expect([trapIndex(-1, 3, false), trapIndex(2, 3, false), trapIndex(0, 3, true), trapIndex(-1, 3, true), trapIndex(1, 0, false)]).toEqual([0, 0, 2, 2, -1]);
  });
});

// Final review P2-1: the feedback sheet, the More menu and the list of keys cover the screen too.
describe("keys behind something covering the screen", () => {
  const kinds = ["open-sheet", "focus-search", "row", "edit", "go"] as const;
  it("all act when nothing covers the screen", () => {
    for (const k of kinds) expect(waitsBehind(k, "none"), k).toBe(false);
  });
  it("wait behind another dialog or menu: N, /, J/K, E and G do nothing", () => {
    for (const k of kinds) expect(waitsBehind(k, "other"), k).toBe(true);
  });
  it("behind the phone's modal + sheet, N and / still reach the sheet, while J/K, E and G wait", () => {
    expect(kinds.map((k) => waitsBehind(k, "sheet"))).toEqual([false, false, true, true, true]);
  });
  it("never hold Esc (each dialog handles its own) or the list of keys itself", () => {
    for (const c of ["none", "sheet", "other"] as const) expect(waitsBehind("escape", c), c).toBe(false);
  });
});
