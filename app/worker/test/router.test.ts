// The router's grammar: pure and deterministic. It reads amounts, units,
// states, words and set shorthand, and never guesses: what it can't read
// is unreadable, never a number it made up.
import { describe, expect, it } from "vitest";
import { MAX_PIECES, parsePiece, singulars, splitOnAnd, splitText, type Span } from "../src/router";

const span = (text: string): Span => ({ text, start: 0, end: text.length });
const parse = (text: string) => parsePiece(span(text));

describe("splitText", () => {
  it("splits on commas, semicolons, new lines, plus and ampersand, keeping each piece's offsets", () => {
    const text = "2 eggs, 1/3 of the fried rice;\nbench 40kg x 8 rir 2 + chai & toast";
    const { spans, overflow } = splitText(text);
    expect(spans.map((s) => s.text)).toEqual(["2 eggs", "1/3 of the fried rice", "bench 40kg x 8 rir 2", "chai", "toast"]);
    for (const s of spans) expect(text.slice(s.start, s.end)).toBe(s.text);
    expect(overflow).toBeNull();
  });

  it("drops what has nothing to read: blanks, punctuation, emoji and filler words", () => {
    expect(splitText("")).toEqual({ spans: [], overflow: null });
    expect(splitText("   ,, ;  ").spans).toEqual([]);
    expect(splitText("👍 , !!! , and and, the").spans).toEqual([]);
  });

  it("past 1,000 characters, the rest from the piece the limit falls in is one span for Claude", () => {
    const long = `curd ${"very ".repeat(78)}`.trim();
    const text = [long, long, long].join(", ");
    const { spans, overflow } = splitText(text);
    expect(spans).toHaveLength(2);
    expect(overflow).toEqual({ text: long, start: 2 * (long.length + 2), end: text.length });
  });

  it("past twenty pieces, the rest is one span for Claude", () => {
    const text = Array.from({ length: 40 }, (_, i) => `${i + 1} egg`).join(", ");
    const { spans, overflow } = splitText(text);
    expect(spans).toHaveLength(MAX_PIECES);
    expect(overflow?.text.startsWith("21 egg, 22 egg")).toBe(true);
    expect(overflow?.end).toBe(text.length);
  });
});

describe("splitOnAnd", () => {
  it("splits a piece on 'and' with each part's offsets in the original text", () => {
    const text = "lunch: 2 eggs and toast";
    const whole = { text: "2 eggs and toast", start: 7, end: text.length };
    expect(splitOnAnd(whole)).toEqual([
      { text: "2 eggs", start: 7, end: 13 },
      { text: "toast", start: 18, end: 23 },
    ]);
    expect(splitOnAnd(span("bread"))).toEqual([span("bread")]);
  });

  it("never splits a whole number from the fraction after it: '1 and a half roti' is one amount", () => {
    expect(splitOnAnd(span("1 and a half roti"))).toEqual([span("1 and a half roti")]);
    expect(splitOnAnd(span("two and half roti"))).toEqual([span("two and half roti")]);
    expect(splitOnAnd(span("1 and a half roti and 2 eggs"))).toEqual([
      { text: "1 and a half roti", start: 0, end: 17 },
      { text: "2 eggs", start: 22, end: 28 },
    ]);
    expect(splitOnAnd(span("about 1 and a half roti"))).toEqual([span("about 1 and a half roti")]);
    // Only a part that is just an amount holds on to the fraction: a number ending a longer part is its own piece's.
    expect(splitOnAnd(span("eggs 2 and half the ghugni"))).toEqual([
      { text: "eggs 2", start: 0, end: 6 },
      { text: "half the ghugni", start: 11, end: 26 },
    ]);
    expect(splitOnAnd(span("lat pulldown 40kg x 12 rir 2 and half the ghugni")).map((s) => s.text)).toEqual(["lat pulldown 40kg x 12 rir 2", "half the ghugni"]);
    expect(splitOnAnd(span("toast and half the dal"))).toEqual([
      { text: "toast", start: 0, end: 5 },
      { text: "half the dal", start: 10, end: 22 },
    ]);
  });
});

describe("parsePiece: food", () => {
  it("reads counts, fractions, number words and units", () => {
    expect(parse("2 eggs")).toMatchObject({ kind: "food", amount: { kind: "count", value: 2 }, unit: null, words: ["eggs"] });
    expect(parse("1/3 of the fried rice")).toMatchObject({ kind: "food", amount: { kind: "fraction", value: 1 / 3 }, the: true, words: ["fried", "rice"] });
    expect(parse("half a katori dal")).toMatchObject({ amount: { kind: "fraction", value: 0.5 }, words: ["katori", "dal"] });
    expect(parse("about 120g curd")).toMatchObject({ amount: { kind: "count", value: 120 }, unit: "g", approx: true, words: ["curd"] });
    expect(parse("1 1/2 roti")).toMatchObject({ amount: { kind: "count", value: 1.5 }, words: ["roti"] });
    expect(parse("1 and a half roti")).toMatchObject({ amount: { kind: "count", value: 1.5 }, words: ["roti"] });
    expect(parse("2 and a quarter kg rice")).toMatchObject({ amount: { kind: "count", value: 2.25 }, unit: "kg", words: ["rice"] });
    expect(parse("two and half roti")).toMatchObject({ amount: { kind: "count", value: 2.5 }, words: ["roti"] });
    // Only a leading amount takes the fraction, as splitOnAnd keeps only a bare amount with it.
    expect(parse("eggs 2 and half the ghugni")).toMatchObject({ amount: { kind: "count", value: 2 } });
    expect(parse("a quarter of the dal")).toMatchObject({ amount: { kind: "fraction", value: 0.25 }, the: true, words: ["dal"] });
    expect(parse("3 pcs idli")).toMatchObject({ amount: { kind: "count", value: 3 }, unit: "piece", words: ["idli"] });
  });

  it("reads a state before or after the name, and an amount after the name", () => {
    expect(parse("150 g cooked rice")).toMatchObject({ amount: { value: 150 }, unit: "g", state: "cooked", words: ["rice"] });
    expect(parse("rice dry 60 g")).toMatchObject({ amount: { value: 60 }, unit: "g", state: "dry", words: ["rice"] });
    expect(parse("2 eggs in shell")).toMatchObject({ state: "in_shell", words: ["eggs"] });
  });

  it("reads my usual and the", () => {
    expect(parse("my usual oats")).toMatchObject({ kind: "food", usual: true, amount: null, words: ["oats"] });
    expect(parse("the dal")).toMatchObject({ kind: "food", the: true, amount: null, words: ["dal"] });
  });

  it("never reads a degenerate amount: zero, a zero denominator, a malformed number, an absurd weight, a second number", () => {
    for (const text of ["0 g rice", "1/0 dal", "2.5.1 eggs", "100000 g curd", "7 kg paneer", "2 2 eggs", "-3 eggs"]) {
      expect(parse(text), text).toMatchObject({ kind: "unreadable", why: "amount" });
    }
    expect(parse("half of half")).toMatchObject({ kind: "food", amount: { kind: "fraction", value: 0.5 }, words: ["half"] });
  });
});

describe("parsePiece: set shorthand", () => {
  it("reads loads with their unit, reps, RIR and sets", () => {
    expect(parse("bench 40kg x 8 rir 2")).toEqual({ kind: "set", span: span("bench 40kg x 8 rir 2"), words: ["bench"], load: { value: 40, unit: "kg" }, reps: 8, rir: { low: 2, high: 2 }, sets: 1 });
    expect(parse("lat pulldown 3x10 @2")).toMatchObject({ kind: "set", words: ["lat", "pulldown"], load: null, sets: 3, reps: 10, rir: { low: 2, high: 2 } });
    expect(parse("LPD set 1 30 kg 12 reps 3-4 rir")).toMatchObject({ words: ["lpd"], load: { value: 30, unit: "kg" }, reps: 12, rir: { low: 3, high: 4 }, sets: 1 });
    expect(parse("pushups bw 15 reps")).toMatchObject({ words: ["pushups"], load: "bodyweight", reps: 15 });
    expect(parse("rows 3 sets of 12")).toMatchObject({ words: ["rows"], sets: 3, reps: 12, load: null });
  });

  it("leaves a load with no unit for the member to say, never guessing kg or lb", () => {
    expect(parse("40 x 8 bench")).toMatchObject({ words: ["bench"], load: { value: 40, unit: null }, reps: 8, sets: 1 });
  });

  it("is unreadable past the ranges", () => {
    expect(parse("bench 40 kg x 8 rir 12")).toMatchObject({ kind: "unreadable", why: "rir" });
    expect(parse("bench 40 kg x 999")).toMatchObject({ kind: "unreadable", why: "reps" });
    expect(parse("bench 4000 kg x 5")).toMatchObject({ kind: "unreadable", why: "load" });
    expect(parse("bench 40 kg x 8 rir 3-1")).toMatchObject({ kind: "unreadable", why: "rir" });
  });
});

describe("the grammar's numbers", () => {
  it("are always finite, for anything typed", () => {
    const odd = ["", "1/", "/2", "..", "x", "rir", "@", "3-", "1e9 g rice", "NaN eggs", "Infinity kg bench x 5", "½ roti", "२ रोटी", "x x x 5", "@@@", "1/3/4 dal"];
    const walk = (text: string, v: unknown): void => {
      if (typeof v === "number") expect(Number.isFinite(v), `${text}: ${v}`).toBe(true);
      else if (v && typeof v === "object") Object.values(v).forEach((w) => walk(text, w));
    };
    for (const text of odd) {
      walk(text, parse(text));
      walk(text, splitText(text));
    }
  });
});

describe("singulars", () => {
  it("gives the name, then its plural-stripped forms", () => {
    expect(singulars("eggs")).toEqual(["eggs", "egg"]);
    expect(singulars("curries")).toEqual(["curries", "curry", "curri", "currie"]);
    expect(singulars("dal")).toEqual(["dal"]);
  });
});

describe("nothing to route", () => {
  it("gives no pieces and never throws", () => {
    for (const text of ["", "!!!", "👍", "and and", "5", "   ", "\n\n"]) {
      expect(() => splitText(text), text).not.toThrow();
      expect(() => parse(text), text).not.toThrow();
    }
    for (const text of ["", "!!!", "👍", "and and", "5", "1/2"]) expect(splitText(text).spans, text).toEqual([]);
  });
});

describe("degenerate amounts never become numbers or guesses", () => {
  it("are unreadable or finite", () => {
    for (const text of ["0 g rice", "1/0 dal", "2.5.1 eggs", "100000 g curd"]) expect(parse(text), text).toMatchObject({ kind: "unreadable" });
    const p = parse("half of half");
    expect(p).toMatchObject({ kind: "food", amount: { value: 0.5 } });
  });
});

describe("fix round 1", () => {
  it("reads 'N rir M' as reps then RIR, and the other rir forms", () => {
    expect(parse("bench 40 kg 8 rir 2")).toMatchObject({ kind: "set", load: { value: 40, unit: "kg" }, reps: 8, rir: { low: 2, high: 2 } });
    expect(parse("bench 40 kg x 8 rir 2")).toMatchObject({ reps: 8, rir: { low: 2, high: 2 } });
    expect(parse("bench 40 kg 8 reps rir 2")).toMatchObject({ reps: 8, rir: { low: 2, high: 2 } });
    expect(parse("bench 40 kg 8 reps 2 rir")).toMatchObject({ reps: 8, rir: { low: 2, high: 2 } });
  });

  it("keeps Devanagari vowel signs", () => {
    expect(parse("२ रोटी")).toMatchObject({ kind: "food", amount: { value: 2 }, words: ["रोटी"] });
    expect(parse("दही")).toMatchObject({ words: ["दही"] });
  });

  it("reports a lone number beside real pieces as unreadable, and drops a text that is only that", () => {
    const { spans } = splitText("chai, 5");
    expect(spans.map((s) => s.text)).toEqual(["chai", "5"]);
    expect(parsePiece(spans[1] as Span)).toMatchObject({ kind: "unreadable", why: "amount", span: { text: "5" } });
    expect(splitText("5").spans).toEqual([]);
    expect(splitText("5, 1/2").spans).toEqual([]);
  });
});

describe("fix round 2: a number beside rir", () => {
  it("never lets rir take a number that a reps marker claims", () => {
    expect(parse("bench 40 kg 2 rir 8 reps")).toMatchObject({ kind: "set", reps: 8, rir: { low: 2, high: 2 } });
    expect(parse("bench 40 kg 8 reps 2 rir")).toMatchObject({ reps: 8, rir: { low: 2, high: 2 } });
    expect(parse("bench 40 kg 8 rir 2")).toMatchObject({ reps: 8, rir: { low: 2, high: 2 } });
  });
  it("is unreadable when both numbers could be the RIR", () => {
    expect(parse("bench 40 kg 8 reps 3 rir 2")).toMatchObject({ kind: "unreadable", why: "rir" });
  });
});

describe("percent shares (final-wave ruling)", () => {
  it("reads '10% of the dal' and '10 % dal' as a fraction of 0.1, and never guesses past 100", () => {
    expect(parse("10% of the dal")).toMatchObject({ kind: "food", amount: { kind: "fraction", value: 0.1 }, unit: null, words: ["dal"], the: true });
    expect(parse("10 % dal")).toMatchObject({ kind: "food", amount: { kind: "fraction", value: 0.1 }, words: ["dal"] });
    expect(parse("dal 25%")).toMatchObject({ kind: "food", amount: { kind: "fraction", value: 0.25 }, words: ["dal"] });
    expect(parse("150% of the dal")).toMatchObject({ kind: "unreadable", why: "amount" });
    expect(parse("% dal")).toMatchObject({ kind: "unreadable", why: "amount" });
  });

  it("never reads a percent followed by a nutrient word as a share, so it asks", () => {
    for (const text of ["curd 10 % protein", "curd 10% protein", "10% fat curd", "paneer 20 % fibre", "dal 5% carbs", "dal 5% kcal", "dal 5% calories", "dal 5 % fiber", "dal 5 % carb"]) {
      expect(parse(text), text).toMatchObject({ kind: "unreadable" });
    }
    expect(parse("10% of the dal")).toMatchObject({ kind: "food", amount: { kind: "fraction", value: 0.1 } });
  });
});

