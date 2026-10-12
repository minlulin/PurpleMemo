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
    strokeWidth: 1.5,
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
