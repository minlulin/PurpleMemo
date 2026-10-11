// P3f More page (§2.8): overflow navigation for the secondary pages — the
// header keeps the primary sections, everything else lives here.

import type { PageKey } from "../lib/navigation.ts";

export const SECONDARY_PAGES: { key: PageKey; label: string; blurb: string }[] =
  [
    { key: "habits", label: "Habits", blurb: "Daily logs and streaks" },
    { key: "tasks", label: "Tasks & reminders", blurb: "Due dates and alerts" },
    { key: "shopping", label: "Shopping", blurb: "Lists with checkable items" },
    { key: "contacts", label: "Address book", blurb: "Contacts and birthdays" },
    { key: "memories", label: "Memories", blurb: "Date-based entries" },
    { key: "gallery", label: "Gallery", blurb: "Photos linked to your data" },
    { key: "vault", label: "Vault", blurb: "Password-protected secrets" },
    { key: "settings", label: "Settings", blurb: "Theme, PIN, key export" },
  ];

export default function MorePage({
  onNavigate,
}: {
  onNavigate: (key: PageKey) => void;
}) {
  return (
    <div className="budget-page">
      <h2 className="editor-title">More</h2>
      <ul className="budget-list">
        {SECONDARY_PAGES.map((p) => (
          <li key={p.key} className="budget-row">
            <span>
              <b>{p.label}</b>
              <span className="muted"> — {p.blurb}</span>
            </span>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => onNavigate(p.key)}
            >
              Open
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
