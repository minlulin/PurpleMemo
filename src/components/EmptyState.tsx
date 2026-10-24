// Shared empty state (P4 polish): one consistent look — a soft box icon plus
// centered muted text — replacing the ad-hoc `<p className="muted">` empty
// placeholders that pages used to scatter.

import type { ReactNode } from "react";
import { IconBox } from "./icons.tsx";

interface EmptyStateProps {
  children: ReactNode;
}

export function EmptyState({ children }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <IconBox className="icon empty-state-icon" />
      <p>{children}</p>
    </div>
  );
}
