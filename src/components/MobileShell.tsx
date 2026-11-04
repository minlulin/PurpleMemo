// The phone's workspace: bottom tabs, the More sheet, the creation FAB and the
// Android back stack.
//
// Rules (tabs, sections, FAB map, background grace) live in `lib/mobileShell.ts`
// where tests reach them; this file is the wiring — history entries for the back
// gesture, the visual-viewport inset for the keyboard, and the markup.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  FAB_ACTIONS,
  type FabActionId,
  historyStateFor,
  MOBILE_LANDING,
  MOBILE_TABS,
  MORE_SHEET_ITEMS,
  type MobileRoute,
  type MobileTabKey,
  routeForCompose,
  routeForPage,
  routeForTab,
  routeFromHistoryState,
  sectionLabel,
  shouldLockAfterBackground,
} from "../lib/mobileShell.ts";
import type { PageKey } from "../lib/navigation.ts";
import { EmptyState } from "./EmptyState.tsx";
import {
  IconBudget,
  IconBusiness,
  IconClose,
  IconDashboard,
  IconHabits,
  IconLoans,
  IconLock,
  IconMore,
  IconNotes,
  IconSettings,
  IconShopping,
  IconTasks,
  IconVault,
} from "./icons.tsx";
import {
  DashboardScreen,
  NoteCompose,
  NotesScreen,
  ShoppingItemCompose,
  ShoppingScreen,
  TaskCompose,
  TasksScreen,
} from "./MobileScreens.tsx";
import { useT } from "./useTranslation.ts";

const TAB_ICONS: Record<MobileTabKey, typeof IconDashboard> = {
  dashboard: IconDashboard,
  tasks: IconTasks,
  budget: IconBudget,
  shopping: IconShopping,
  more: IconMore,
};

const SECTION_ICONS: Partial<Record<PageKey, typeof IconDashboard>> = {
  notes: IconNotes,
  business: IconBusiness,
  loans: IconLoans,
  habits: IconHabits,
  vault: IconVault,
  settings: IconSettings,
};

interface MobileShellProps {
  /** Locks the session now — the end of the 1-minute grace calls this. */
  onLock: () => void;
  /** Drops decrypted caches the moment the app goes to the background. */
  onBackground: () => void;
}

export function MobileShell({ onLock, onBackground }: MobileShellProps) {
  const t = useT();
  const [route, setRoute] = useState<MobileRoute>(MOBILE_LANDING);
  const [fabOpen, setFabOpen] = useState(false);
  const sheetCloseRef = useRef<HTMLButtonElement | null>(null);

  // History is the back stack. The generated Android activity already turns the
  // system back gesture into `goBack()` whenever the webview can go back
  // (`WryActivity.setWebView`), so every in-app navigation is a history entry
  // and a back press pops exactly one. On the landing entry the webview cannot
  // go back, which is when Android finishes the activity — the "exits only from
  // the landing tab with nothing open" rule, enforced by the platform rather
  // than by a handler that could get it wrong.
  useEffect(() => {
    if (history.state?.purpleMemoMobile !== true) {
      history.replaceState(historyStateFor(MOBILE_LANDING), "");
    }
    setRoute(routeFromHistoryState(history.state));
    const onPop = (event: PopStateEvent) => {
      setFabOpen(false);
      setRoute(routeFromHistoryState(event.state));
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((next: MobileRoute) => {
    setFabOpen(false);
    history.pushState(historyStateFor(next), "");
    setRoute(next);
  }, []);

  const goBack = useCallback(() => {
    history.back();
  }, []);

  // 1-minute background grace (decision 6): away for less than a minute and the
  // session is still open; at or past a minute the PIN screen returns. Caches are
  // dropped on the way out either way.
  useEffect(() => {
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = performance.now();
        onBackground();
        return;
      }
      if (hiddenAt === null) return;
      const away = performance.now() - hiddenAt;
      hiddenAt = null;
      if (shouldLockAfterBackground(away)) onLock();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [onBackground, onLock]);

  // Keyboard-aware layout. The native side pads the content host by the IME
  // inset (MainActivity), which is what shrinks the webview when the keyboard
  // opens — Android 15+ ignores `adjustResize` for edge-to-edge apps. This effect
  // covers the other shape: a webview whose visual viewport shrinks *within* a
  // full-height layout viewport (the usual browser behaviour). Either way the
  // shell sizes itself as viewport minus `--mobile-kb-inset`, so the focused
  // field and the tab bar stay above the keys instead of behind them.
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    if (viewport === null) return;
    const sync = () => {
      const inset = Math.max(
        0,
        window.innerHeight - viewport.height - viewport.offsetTop,
      );
      root.style.setProperty("--mobile-kb-inset", `${inset}px`);
    };
    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      root.style.removeProperty("--mobile-kb-inset");
    };
  }, []);

  const sheetOpen = route.tab === "more" && route.page === null;
  useEffect(() => {
    if (sheetOpen) sheetCloseRef.current?.focus();
  }, [sheetOpen]);

  const composeAction =
    route.compose === null
      ? null
      : (FAB_ACTIONS.find((action) => action.id === route.compose) ?? null);
  const tabLabel =
    MOBILE_TABS.find((tab) => tab.key === route.tab)?.label ?? "mobile.moreTab";
  const heading =
    composeAction !== null
      ? t(composeAction.label)
      : route.page !== null
        ? t(sectionLabel(route.page))
        : t(tabLabel);

  return (
    <div className="mobile-shell">
      <header className="mobile-header">
        {route.page !== null ? (
          <button
            type="button"
            className="mobile-icon-btn"
            aria-label={t("common.back")}
            onClick={goBack}
          >
            <span aria-hidden="true">‹</span>
          </button>
        ) : (
          <span className="mobile-header-spacer" aria-hidden="true" />
        )}
        <h1 className="mobile-title">{heading}</h1>
        <button
          type="button"
          className="mobile-icon-btn"
          aria-label={t("shell.lock")}
          title={t("shell.lockTitle")}
          onClick={onLock}
        >
          <IconLock className="icon" />
        </button>
      </header>

      <main className="mobile-main" id="main-content" tabIndex={-1}>
        {composeAction !== null ? (
          <ComposeBody
            id={composeAction.id}
            label={t(composeAction.label)}
            onDone={goBack}
          />
        ) : route.page !== null ? (
          <SectionBody
            page={route.page}
            onCompose={(id) => go(routeForCompose(id))}
          />
        ) : route.tab === "more" ? (
          <section className="mobile-page">
            <EmptyState>{t("mobile.more.subtitle")}</EmptyState>
          </section>
        ) : (
          <SectionBody
            page={route.tab}
            onCompose={(id) => go(routeForCompose(id))}
          />
        )}
      </main>

      {sheetOpen ? (
        <>
          <button
            type="button"
            className="mobile-sheet-scrim"
            aria-label={t("mobile.more.close")}
            onClick={goBack}
          />
          <div
            className="mobile-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-more-title"
          >
            <div className="mobile-sheet-head">
              <h2 className="mobile-sheet-title" id="mobile-more-title">
                {t("mobile.more.title")}
              </h2>
              <button
                ref={sheetCloseRef}
                type="button"
                className="mobile-icon-btn"
                aria-label={t("mobile.more.close")}
                onClick={goBack}
              >
                <IconClose className="icon" />
              </button>
            </div>
            <div className="mobile-sheet-list">
              {MORE_SHEET_ITEMS.map((item) => {
                const Icon = SECTION_ICONS[item.page] ?? IconMore;
                return (
                  <button
                    key={item.page}
                    type="button"
                    className="mobile-sheet-item"
                    onClick={() => go(routeForPage(item.page))}
                  >
                    <Icon className="icon" />
                    <span>{t(item.label)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      ) : null}

      {fabOpen ? (
        <div
          className="mobile-fab-list"
          role="menu"
          aria-label={t("mobile.fab.open")}
        >
          {FAB_ACTIONS.map((action) => (
            <button
              key={action.id}
              type="button"
              role="menuitem"
              className="mobile-fab-action"
              onClick={() => go(routeForCompose(action.id))}
            >
              {t(action.label)}
            </button>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        className={fabOpen ? "mobile-fab is-open" : "mobile-fab"}
        aria-expanded={fabOpen}
        aria-label={fabOpen ? t("mobile.fab.close") : t("mobile.fab.open")}
        onClick={() => setFabOpen((open) => !open)}
      >
        <span className="mobile-fab-glyph" aria-hidden="true">
          {fabOpen ? "×" : "+"}
        </span>
      </button>

      <nav className="mobile-tabs" aria-label={t("shell.sections")}>
        {MOBILE_TABS.map((tab) => {
          const Icon = TAB_ICONS[tab.key];
          const active = route.tab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              className={active ? "mobile-tab is-active" : "mobile-tab"}
              aria-current={active ? "page" : undefined}
              onClick={() => {
                if (active && route.page === null && route.compose === null) {
                  return;
                }
                go(routeForTab(tab.key));
              }}
            >
              <Icon className="icon" />
              <span className="mobile-tab-label">{t(tab.label)}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

/**
 * A section's body. The three Phase A flows render their real screens; the
 * rest keep the honest placeholder, because their data screens are later work
 * and a half-built one would be worse than none.
 */
function SectionBody({
  page,
  onCompose,
}: {
  page: PageKey;
  onCompose: (id: "note" | "task" | "shopping") => void;
}) {
  const t = useT();
  const label = t(sectionLabel(page));
  if (page === "notes")
    return <NotesScreen onCompose={() => onCompose("note")} />;
  if (page === "tasks")
    return <TasksScreen onCompose={() => onCompose("task")} />;
  if (page === "shopping") {
    return <ShoppingScreen onCompose={() => onCompose("shopping")} />;
  }
  if (page === "dashboard") return <DashboardScreen />;
  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{label}</p>
      <EmptyState>
        {t("mobile.placeholder.empty", { section: label })}
      </EmptyState>
    </section>
  );
}

/**
 * The create screen a FAB action (or a section button) opens. The two Budget
 * actions stay placeholders until the Budget flows ship; a note, task or
 * shopping item saves for real and returns to where it was opened from.
 */
function ComposeBody({
  id,
  label,
  onDone,
}: {
  id: FabActionId;
  label: string;
  onDone: () => void;
}) {
  const t = useT();
  if (id === "note") return <NoteCompose onDone={onDone} />;
  if (id === "task") return <TaskCompose onDone={onDone} />;
  if (id === "shopping") return <ShoppingItemCompose onDone={onDone} />;
  return (
    <section className="mobile-page">
      <EmptyState>{t("mobile.compose.body", { what: label })}</EmptyState>
    </section>
  );
}
