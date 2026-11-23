import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { callTool } from "./api";
import { brandedTitle } from "./brand";
import { CatalogueStoreProvider } from "./components/CatalogueStore";
import { CatalogueScreen } from "./components/catalogue/CatalogueScreen";
import { DesktopShell } from "./components/DesktopShell";
import { KeyboardLayer } from "./components/KeyboardLayer";
import { LoadState, MemberBar, TabBar } from "./components/Shell";
import { SheetHost } from "./components/Sheet";
import { TopMenu } from "./components/TopMenu";
import { useLoad, useLocation } from "./hooks";
import { loadWho } from "./load";
import { pageTitle, remember, type RouteMemory, type Section } from "./route";
import { HouseholdScreen } from "./screens/HouseholdScreen";
import { HealthScreen, ProgressScreen } from "./screens/ProgressScreen";
import { ProgressSummaryScreen } from "./screens/ProgressSummaryScreen";
import { TodayScreen } from "./screens/TodayScreen";
import { TrainScreen } from "./screens/TrainScreen";
import { LiftsScreen, NutritionScreen, PrivateProgressScreen } from "./screens/ViewScreens";
import { buildShell, buildSidebar, catalogueMenuHref } from "./shell";
import { appSlots, useWide } from "./wide";

export function App() {
  const { place, go } = useLocation();
  const wide = useWide();
  const [memory, setMemory] = useState<RouteMemory>({});
  useEffect(() => setMemory((m) => remember(m, place.route)), [place.route]);
  useEffect(() => {
    document.title = brandedTitle(pageTitle(place.route));
  }, [place.route]);
  // Each tab keeps its scroll position: saved as the place changes (a link or back/forward),
  // restored once the new tab has rendered. A tab's last answer is cached, so it renders ready.
  const scrolls = useRef(new Map<Section, number>());
  const current = useRef(place.route.section);
  current.current = place.route.section;
  const navigate = useCallback(
    (href: string) => {
      scrolls.current.set(current.current, scrollY);
      go(href);
    },
    [go],
  );
  useEffect(() => {
    const onPop = () => scrolls.current.set(current.current, scrollY);
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  const section = place.route.section;
  const first = useRef(true);
  useLayoutEffect(() => {
    if (first.current) first.current = false;
    else scrollTo(0, scrolls.current.get(section) ?? 0);
  }, [section]);

  const who = useLoad(() => loadWho((t, i) => callTool(t, i)), "who");
  if (who.state.kind !== "ready") return <LoadState state={who.state} what="The app" retry={who.reload} />;
  const me = who.state.data;
  const shell = buildShell(me, place, memory);
  const r = place.route;

  let screen;
  if (r.section === "today") screen = <TodayScreen who={me} viewing={shell.viewing} date={r.date} go={navigate} />;
  else if (r.section === "train" && r.view === "lifts") screen = <LiftsScreen who={me} viewing={shell.viewing} exerciseId={r.lift} unknown={r.unknown === true} go={navigate} />;
  else if (r.section === "train") screen = <TrainScreen who={me} viewing={shell.viewing} go={navigate} />;
  else if (r.section === "progress" && r.view === "nutrition") {
    screen = <NutritionScreen who={me} viewing={shell.viewing} range={r.range} week={r.week} go={navigate} />;
  }
  else if (r.section === "progress" && shell.progress.private) {
    screen = <PrivateProgressScreen who={me} viewing={shell.viewing} view={r.view === "health" ? "health" : r.view === "body" ? "body" : "overview"} range={r.range} week={r.week} message={shell.progress.message} go={navigate} />;
  } else if (r.section === "progress" && r.view === "health") screen = <HealthScreen who={me} viewing={shell.viewing} range={r.range} week={r.week} go={navigate} />;
  else if (r.section === "progress" && r.view === "body") screen = <ProgressScreen who={me} viewing={shell.viewing} range={r.range} week={r.week} go={navigate} />;
  else if (r.section === "progress") screen = <ProgressSummaryScreen who={me} viewing={shell.viewing} range={r.range} week={r.week} go={navigate} />;
  else if (r.section === "household") screen = <HouseholdScreen who={me} date={r.date} go={navigate} />;
  else screen = <CatalogueScreen who={me} view={r.view} wide={wide} go={navigate} />;

  const date = r.section === "today" || r.section === "household" ? r.date : null;
  // G then a letter goes where the tab bar (or the sidebar) would: each section's remembered route, the member kept.
  const hrefs = { ...Object.fromEntries(shell.tabs.map((t) => [t.tab, t.href])), catalogue: catalogueMenuHref(memory) } as Record<Section, string>;
  const menu = <TopMenu date={date} go={navigate} memory={memory} wide={wide} />;
  const slotted = {
    sidebar: <DesktopShell sidebar={buildSidebar(me, place, memory)} pills={shell.pills} go={navigate} menu={menu} />,
    topbar: (
      <div className="topbar">
        <MemberBar pills={shell.pills} go={navigate} />
        {menu}
      </div>
    ),
    screen,
    tabbar: <TabBar tabs={shell.tabs} go={navigate} />,
  };
  // Fixed slots (appSlots): the screen and the sheet never remount when the window crosses 1024 px.
  return (
    <CatalogueStoreProvider>
      <SheetHost who={me} date={date} wide={wide}>
        <div className={wide ? "app wide" : "app"}>
          {appSlots(wide).map((slot, i) => (
            <Fragment key={i}>{slot ? slotted[slot] : null}</Fragment>
          ))}
        </div>
        <KeyboardLayer hrefs={hrefs} go={navigate} />
      </SheetHost>
    </CatalogueStoreProvider>
  );
}
