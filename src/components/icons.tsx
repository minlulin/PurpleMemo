// Inline SVG icons (§6 icon pass): stroke = currentColor, sized in em via CSS
// — no icon-font dependency and no hardcoded colors (token-lint safe).

interface IconProps {
  className?: string;
}

function base(props: IconProps) {
  return {
    className: props.className,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
}

export function IconDownload(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M12 3v11" />
      <path d="m7 10 5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  );
}

export function IconUpload(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M12 14V3" />
      <path d="m7 8 5-5 5 5" />
      <path d="M4 21h16" />
    </svg>
  );
}

export function IconBox(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M21 8 12 3 3 8v8l9 5 9-5V8Z" />
      <path d="m3 8 9 5 9-5" />
      <path d="M12 13v8" />
    </svg>
  );
}

/* --- Navigation & Feature Icons (PurpleShade shell) ----------------------- */

export function IconDashboard(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <rect x="3" y="3" width="8" height="8" rx="2" />
      <rect x="13" y="3" width="8" height="5" rx="2" />
      <rect x="13" y="10" width="8" height="11" rx="2" />
      <rect x="3" y="13" width="8" height="8" rx="2" />
    </svg>
  );
}

export function IconNotes(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  );
}

export function IconJournal(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M4 5a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a2 2 0 0 0-2 2Z" />
      <path d="M8 7h7" />
      <path d="M8 11h7" />
    </svg>
  );
}

export function IconBudget(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2" />
      <rect x="3" y="7" width="18" height="12" rx="2" />
      <path d="M16 13h2" />
    </svg>
  );
}

export function IconBusiness(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M3 12h18" />
    </svg>
  );
}

export function IconLoans(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M4 10h13a4 4 0 0 1 0 8H8" />
      <path d="m8 6-4 4 4 4" />
    </svg>
  );
}

export function IconMore(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 8.98 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.04H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 8.98a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1.04-1.56V3a2 2 0 1 1 4 0v.09c0 .68.4 1.29 1.04 1.56a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9c.27.63.88 1.04 1.56 1.04H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.04Z" />
    </svg>
  );
}

export function IconLock(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </svg>
  );
}

export function IconHabits(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M12 2c1.5 3.5 4.5 5.5 4.5 9.5a4.5 4.5 0 1 1-9 0c0-2.5 1.5-4.5 2.5-6 1 2 2 2.5 2-3.5Z" />
      <path d="M10 15.5a2 2 0 1 0 4 0c0-1.2-1-2.2-2-3.2-1 1-2 2-2 3.2Z" />
    </svg>
  );
}

export function IconTasks(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="m8 12 2.5 2.5L16 9" />
    </svg>
  );
}

export function IconShopping(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M6 7h12l-1 13H7L6 7Z" />
      <path d="M9 7V5a3 3 0 0 1 6 0v2" />
    </svg>
  );
}

export function IconContacts(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5.5 19.5a6.5 6.5 0 0 1 13 0" />
    </svg>
  );
}

export function IconMemories(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4" />
      <path d="M8 3v4" />
      <path d="M3 10h18" />
      <path d="m12 13 1.2 2.4 2.6.4-1.9 1.8.5 2.6-2.4-1.3-2.4 1.3.5-2.6-1.9-1.8 2.6-.4L12 13Z" />
    </svg>
  );
}

export function IconGallery(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.5" />
      <path d="m21 15-5-5L5 20" />
    </svg>
  );
}

export function IconVault(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M12 3 4 7v5c0 5.2 3.4 8.9 8 10 4.6-1.1 8-4.8 8-10V7l-8-4Z" />
      <circle cx="12" cy="11.5" r="1.5" />
      <path d="M12 13v3" />
    </svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  );
}

export function IconPlus(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </svg>
  );
}

export function IconPin(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M15 4.5 19.5 9l-2 2-3.5-1-4 4v3l-1.5 1.5-3-3-3.5 3.5" />
      <path d="m15 4.5-2 2-1 3.5-4 4H5l-1.5 1.5 3 3" />
    </svg>
  );
}

export function IconFolder(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
    </svg>
  );
}

export function IconTrendUp(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="m22 7-8.5 8.5-5-5L2 17" />
      <path d="M16 7h6v6" />
    </svg>
  );
}

export function IconTrendDown(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="m22 17-8.5-8.5-5 5L2 7" />
      <path d="M16 17h6v-6" />
    </svg>
  );
}

export function IconWallet(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <rect x="3" y="6" width="18" height="13" rx="2.5" />
      <path d="M3 10h18" />
      <circle cx="16.5" cy="14" r="1" />
    </svg>
  );
}

export function IconCalendar(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4" />
      <path d="M8 3v4" />
      <path d="M3 10h18" />
    </svg>
  );
}

export function IconArrowLeft(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M19 12H5" />
      <path d="m11 18-6-6 6-6" />
    </svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </svg>
  );
}

/* --- Compact navigation + progress --------------------------------------- */

export function IconChevronLeft(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="m14.5 6-6 6 6 6" />
    </svg>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="m9.5 6 6 6-6 6" />
    </svg>
  );
}

/* A spinner is one of the few icons that animates on its own; `.icon-spin`
 * in app.css drives the rotation. */
export function IconSpinner(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg
      {...base(props)}
      className={props.className ? `icon-spin ${props.className}` : "icon-spin"}
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function IconMarkdown(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <rect x="2.5" y="5" width="19" height="14" rx="2.5" />
      <path d="M6 15v-6l2.5 3L11 9v6" />
      <path d="M14 9v4a1.5 1.5 0 0 0 3 0V9" />
      <path d="M17 9v6" />
    </svg>
  );
}

export function IconEye(props: IconProps) {
  return (
    // biome-ignore lint/a11y/noSvgWithoutTitle: decorative, aria-hidden
    <svg {...base(props)}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
