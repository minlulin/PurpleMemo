import { useState } from "react";
import JournalPage from "./pages/JournalPage";
import NotesPage from "./pages/NotesPage";

type PageKey = "notes" | "journal";

const TABS: { key: PageKey; label: string }[] = [
  { key: "notes", label: "Notes" },
  { key: "journal", label: "Journal" },
];

/**
 * App shell (§2.4/§2.5 scope for P3a): header + section tabs. Navigation is
 * state-based — §3 locks the stack and has no router dependency. The Dashboard
 * becomes the landing page in P3f; Notes is the placeholder landing here.
 */
export default function App() {
  const [page, setPage] = useState<PageKey>("notes");

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-brand">
          <img className="app-mark" src="/brand/purple-memo-mark.png" alt="" />
          <span className="app-name">Purple Memo</span>
        </div>
        <nav className="app-nav" aria-label="Sections">
          {TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={page === tab.key ? "nav-tab is-active" : "nav-tab"}
              aria-current={page === tab.key ? "page" : undefined}
              onClick={() => setPage(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </header>
      <main className="app-main">
        {page === "notes" ? <NotesPage /> : <JournalPage />}
      </main>
    </div>
  );
}
