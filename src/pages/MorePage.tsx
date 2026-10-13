// P3f More page (§2.8): overflow navigation for the secondary pages — the
// header keeps the primary sections, everything else lives here.

import {
  IconContacts,
  IconGallery,
  IconHabits,
  IconMemories,
  IconMore,
  IconSettings,
  IconShopping,
  IconTasks,
  IconVault,
} from "../components/icons.tsx";
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

const PAGE_ICONS: Partial<Record<PageKey, typeof IconHabits>> = {
  habits: IconHabits,
  tasks: IconTasks,
  shopping: IconShopping,
  contacts: IconContacts,
  memories: IconMemories,
  gallery: IconGallery,
  vault: IconVault,
  settings: IconSettings,
};

export default function MorePage({
  onNavigate,
}: {
  onNavigate: (key: PageKey) => void;
}) {
  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconMore className="icon" />
            </span>
            <div>
              <h2 className="editor-title">More</h2>
              <p className="page-subtitle">
                Personal trackers, address book, memories, media gallery &amp;
                encrypted vault
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="more-grid">
        {SECONDARY_PAGES.map((p) => {
          const Icon = PAGE_ICONS[p.key] ?? IconMore;
          return (
            <button
              key={p.key}
              type="button"
              className="more-card"
              onClick={() => onNavigate(p.key)}
            >
              <span className="more-card-icon">
                <Icon className="icon" />
              </span>
              <span className="more-card-body">
                <span className="more-card-title">{p.label}</span>
                <span className="more-card-blurb">{p.blurb}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
