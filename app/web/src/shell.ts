/**
 * The shell's model: the tab bar (each tab keeping its sub-page and the
 * member being viewed), the member bar (the signed-in member first, as
 * whoami lists them), and whether Progress is private. Progress rests on
 * owner-only readings, blood draws and flags, so for anyone but you it is
 * private on Trajectory and Health and makes no calls there (spec §3).
 * Nutrition uses household-visible meal data, so it remains available while
 * viewing another member.
 */
import type { Who } from "./load";
import { cataloguePath, hrefOf, sectionRoute, TABS, type CatalogueView, type Place, type RouteMemory, type Tab } from "./route";

export interface TabLink {
  tab: Tab;
  label: string;
  href: string;
  active: boolean;
}

export interface Pill {
  name: string;
  selected: boolean;
  isMe: boolean;
  href: string;
}

export interface ShellView {
  viewing: string;
  ownView: boolean;
  tabs: TabLink[];
  pills: Pill[];
  progress: { private: false } | { private: true; message: string };
}

const LABELS: Record<Tab, string> = { today: "Today", train: "Train", progress: "Progress", household: "Household" };

export function buildShell(who: Who, place: Place, memory: RouteMemory): ShellView {
  const viewing = place.member && who.members.includes(place.member) ? place.member : who.member;
  const memberParam = viewing === who.member ? null : viewing;
  const privateProgress =
    place.route.section === "progress" && place.route.view !== "nutrition" && viewing !== who.member
      ? { private: true as const, message: `${place.route.view === "health" ? "Health" : "Progress"} is private to ${viewing}.` }
      : { private: false as const };
  return {
    viewing,
    ownView: viewing === who.member,
    tabs: TABS.map((tab) => ({
      tab,
      label: LABELS[tab],
      href: hrefOf({ route: tab === place.route.section ? place.route : sectionRoute(memory, tab), member: memberParam }),
      active: tab === place.route.section,
    })),
    pills: who.members.map((name) => ({
      name,
      selected: name === viewing,
      isMe: name === who.member,
      href: hrefOf({ route: place.route, member: name === who.member ? null : name }),
    })),
    progress: privateProgress,
  };
}

export interface SideLink {
  key: string;
  label: string;
  href: string;
  active: boolean;
}

export interface Sidebar {
  main: SideLink[];
  catalogue: SideLink[];
}

export const CATALOGUE_LINKS: { pane: CatalogueView["pane"]; label: string }[] = [
  { pane: "foods", label: "Foods & recipes" },
  { pane: "workouts", label: "Workouts" },
  { pane: "exercises", label: "Exercises" },
  { pane: "gyms", label: "Gyms & equipment" },
  { pane: "words", label: "Words I've learned" },
];

export const paneHome = (pane: CatalogueView["pane"]): CatalogueView => (pane === "foods" ? { pane, record: null } : pane === "words" ? { pane } : { pane, id: null });

/**
 * The wide layout's sidebar (desktop spec §2): the four sections (each
 * keeping its sub-page and the member, as the tab bar does), then the
 * catalogue's five panes. A pane's link returns to what was last open in
 * it. The catalogue is the household's, so its links carry no member.
 */
export function buildSidebar(who: Who, place: Place, memory: RouteMemory): Sidebar {
  const shell = buildShell(who, place, memory);
  const r = place.route;
  const last = memory.catalogue?.section === "catalogue" ? memory.catalogue.view : null;
  return {
    main: shell.tabs.map((t) => ({ key: t.tab, label: t.label, href: t.href, active: t.active })),
    catalogue: CATALOGUE_LINKS.map((c) => {
      const here = r.section === "catalogue" && r.view.pane === c.pane;
      const view = here ? (r as { view: CatalogueView }).view : last && last.pane === c.pane ? last : paneHome(c.pane);
      return { key: c.pane, label: c.label, href: hrefOf({ route: { section: "catalogue", view }, member: null }), active: here };
    }),
  };
}

/** Where the phone's menu entry "Catalogue" goes: what was last open in the catalogue, else Foods & recipes. */
export function catalogueMenuHref(memory: RouteMemory): string {
  const last = memory.catalogue?.section === "catalogue" ? memory.catalogue.view : null;
  return hrefOf({ route: { section: "catalogue", view: last ?? paneHome("foods") }, member: null });
}

/** The top menu's links (desktop spec §2): the catalogue (where it was last open, as the sidebar's) and the one words screen. Feedback opens its own sheet. */
export function topMenuLinks(memory: RouteMemory): readonly { label: string; href: string }[] {
  return [
    { label: "Catalogue", href: catalogueMenuHref(memory) },
    { label: "What I've learned", href: cataloguePath({ pane: "words" }) },
  ];
}

/** The menu with nothing remembered. */
export const TOP_MENU_LINKS: readonly { label: string; href: string }[] = topMenuLinks({});
