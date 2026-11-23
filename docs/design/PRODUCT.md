# Product

A household nutrition and training tracker for three people (Hritvik, Asha, Kabir) who share one kitchen and train at three different gyms. The terms are defined in [`CONTEXT.md`](../../CONTEXT.md).

## Who and where

- Each **member** opens the app on a phone several times a day, at the table after a meal, and sometimes at the gym.
- Logging happens mostly **in chat with the agent**. The app is for seeing, confirming and correcting. Don't design a form-first logging app.
- The household shares cooks. One pot is split unevenly between whoever ate, and anyone can log a portion for someone else, which arrives as a **draft**.

## What the app must make obvious

1. **How the day stands and what's left:** energy, protein, carbs and fat against targets, phrased as "left".
2. **How much of it is measured:** weighed, counted or from a label, versus estimated, with the ± and the single biggest uncertainty named.
3. **Shared pots:** who took what share, who wasn't there, and how much of the pot is still unaccounted.
4. **Drafts waiting for you,** confirmed or changed in one tap.

## Product truths the design must not break

- Blank is never zero. "Nothing yet", "skipped" and "not recorded" are distinct states, and each looks different.
- A member who wasn't present gets **no portion**, which is not the same as a portion of 0.
- Numbers come only from the API. The UI never calculates nutrition.
- Health data (bloods, body readings, flags, member notes) is visible only to its owner.

## Tone

An instrument: precise and calm, using plain words such as "left", "estimated" and "not yet accounted for". It never praises or scolds.

## Anti-goals

Streaks, confetti or badges. Red "over target" warnings. The neon-on-black fitness look. Progress rings that hide the actual numbers. False precision, such as a decimal on an estimate.

## Platform

A PWA in React and TypeScript, phone-first at 390 px, light and dark following the phone. It's served by the Worker behind Cloudflare Access.
