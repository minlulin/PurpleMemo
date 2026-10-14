// Skeleton placeholders (plan 12a.1/12a.2): shape-matched loading blocks that
// replace the "Loading…" paragraphs pages used to render. Decorative by
// default — a stack (or a card) carries `role="status"` so the wait is still
// announced, and the bars themselves are hidden from assistive tech.

export type SkeletonVariant = "text" | "icon" | "card";
export type SkeletonWidth = "full" | "short";

interface SkeletonProps {
  variant?: SkeletonVariant;
  /** Text bars only: `short` renders a narrower trailing bar. */
  width?: SkeletonWidth;
  /** Stack N bars/blocks instead of rendering a single one. */
  count?: number;
  className?: string;
}

function barClass(variant: SkeletonVariant, width: SkeletonWidth): string {
  const cls = ["skeleton", `skeleton-${variant}`];
  if (variant === "text" && width === "short") cls.push("is-short");
  return cls.join(" ");
}

export function Skeleton({
  variant = "text",
  width = "full",
  count = 1,
  className,
}: SkeletonProps) {
  const total = Math.max(1, count);
  // The index only shapes the data (class + identity); the key itself comes
  // from `id`, so the array-index rule stays satisfied without a suppression.
  const bars = Array.from({ length: total }, (_, i) => ({
    id: `skeleton-${i}`,
    className: barClass(variant, i === total - 1 ? "short" : width),
  }));

  // A lone inline bar is decoration; a stack or a card is a loading region.
  if (count <= 1 && variant === "text") {
    return <span className={barClass(variant, width)} />;
  }

  return (
    <span className={`skeleton-stack ${className ?? ""}`.trim()} role="status">
      <span className="visually-hidden">Loading…</span>
      <span className="skeleton-stack-bars">
        {bars.map((b) => (
          <span key={b.id} className={b.className} />
        ))}
      </span>
    </span>
  );
}
