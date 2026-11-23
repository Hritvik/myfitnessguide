import { useEffect, useMemo } from "react";
import { callTool } from "../api";
import { DayNav, LoadState } from "../components/Shell";
import { DayClose } from "../components/DayClose";
import { HouseholdGlance } from "../components/HouseholdGlance";
import { Footer, LeftLine, Macros } from "../components/Parts";
import { PotCard } from "../components/PotCard";
import { PrepStrip } from "../components/PrepStrip";
import { Split } from "../components/Split";
import { NeedsStrip } from "../components/Strip";
import { Tiers } from "../components/Tiers";
import { addDays } from "../dates";
import { buildDayClose } from "../dayClose";
import { useLoad, useOnline, useSaved, useSheet, useSwipe, useWrites } from "../hooks";
import { TODAY, TODAY_PARTS } from "../layout";
import { loadToday, todayKey, type Who } from "../load";
import { hrefOf } from "../route";
import type { MealSlot } from "../sheet";
import { buildToday } from "../today";
import { useWide } from "../wide";

const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

export function TodayScreen({ who, viewing, date, go }: { who: Who; viewing: string; date: string | null; go: (href: string) => void }) {
  const online = useOnline();
  const wide = useWide();
  const { state, reload } = useLoad(() => loadToday((t, i) => callTool(t, i), { who, viewing, date }), todayKey(who, viewing, date));
  const writes = useWrites(reload, () => location.reload());
  const sheet = useSheet();
  // A Save in the "+" sheet re-reads quietly; the load key stays as it is so the cached day still shows at once.
  const saved = useSaved();
  useEffect(() => {
    if (saved) reload();
    // Only a new Save re-reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);
  const view = useMemo(() => (state.kind === "ready" ? buildToday(state.data) : null), [state]);
  const dayClose = useMemo(() => (state.kind === "ready" ? buildDayClose(state.data) : null), [state]);
  const shown = date ?? who.today;
  const member = viewing === who.member ? null : viewing;
  const toDate = (d: string) => go(hrefOf({ route: { section: "today", date: d >= who.today ? null : d }, member }));
  const swipe = useSwipe(
    () => shown < who.today && toDate(addDays(shown, 1)),
    () => toDate(addDays(shown, -1)),
  );
  if (state.kind !== "ready" || !view) return <LoadState state={state.kind === "ready" ? { kind: "loading" } : state} what="Today" retry={reload} />;
  const nodes = {
    offline: !online ? (
      <p className="banner" role="status">
        <b>Offline.</b> Showing the day as loaded at {time.format(state.loadedAt)}. Confirming and changing are off until you're back online.
      </p>
    ) : null,
    top: (
      <div className="top">
        <h1>{view.title}</h1>
        <DayNav date={shown} today={who.today} onDate={toDate} />
      </div>
    ),
    strip: view.strip || state.data.prep.length > 0 ? (
      <>
        {state.data.prep.length > 0 ? <PrepStrip tasks={state.data.prep} /> : null}
        {view.strip ? <NeedsStrip strip={view.strip} writes={writes} online={online} go={go} /> : null}
      </>
    ) : null,
    left: <LeftLine left={view.left} notes={view.notes} />,
    macros: <Macros macros={view.macros} />,
    pots:
      view.pots.length > 0 ? (
        <div className="pots">
          {view.pots.map((p) => (
            <PotCard key={p.cookId} pot={p} writes={writes} online={online} />
          ))}
        </div>
      ) : null,
    tiers: <Tiers wide={wide} tiers={view.tiers} writes={writes} online={online} timeZone={who.time_zone} today={who.today} onAdd={(slot, from) => sheet.open({ tab: "food", slot: slot as MealSlot, member: viewing, date: shown }, from)} />,
    close: dayClose ? <DayClose close={dayClose} member={who.member} date={shown} writes={writes} online={online} /> : null,
    // Null, not an element that draws nothing, so an empty footer leaves the tail region out (Today B's fallback).
    footer: view.footer.length > 0 ? <Footer rows={view.footer} go={go} /> : null,
    glance: <HouseholdGlance who={who} date={date} />,
  };
  return (
    <main className="screen" {...swipe}>
      <Split wide={wide} specs={TODAY_PARTS} nodes={nodes} layout={TODAY} />
    </main>
  );
}
