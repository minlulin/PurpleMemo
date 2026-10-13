# Purple Memo — UI Polish Plan

> Comprehensive UI audit and phased polish plan to elevate the app from functional to premium.

---

## Audit Summary

| Category | Status | Notes |
|---|---|---|
| Design tokens | Solid foundation | Missing input surface, display tier, spring easing |
| Typography | Undersized | Body at 15px, titles at 26px — too small for desktop |
| Buttons | Functional | Crude brightness hover, no loading spinners, no icon-only variant |
| Inputs | Basic | No icons, no custom select arrow, no inline validation |
| Cards | Flat | Shine gradient invisible, no entrance animations |
| Dashboard | Dense | KPI cards lack weight, bento grid imbalanced |
| Notes studio | Clean | Flat note cards, raw emoji pin, no resize |
| Budget | Comprehensive | Thin progress bars, text arrows, plain wallet cards |
| Lock screens | Plain | No visual drama, no PIN dots, dense setup form |
| Contacts | Nested cards | Card-in-card pattern, plain avatars |
| Settings | Monotonous | All sections identical, button theme toggle |
| Gallery | Tight | Small gaps, no hover zoom, inspector below grid |
| Habits | Overloaded | Too much per card, small month grid cells |
| Cross-cutting | Missing | No skeletons, no toasts, no keyboard hints, no DnD |
| Icons | Good | Stroke 1.6 slightly thin, no filled variants |

---

## Phase 1: Typography & Spacing Foundation

**Goal:** Establish a more generous, premium typographic scale and fix spacing inconsistencies.

### Tasks

- [x] **1.1** Increase body font size from `0.9375rem` (15px) to `1rem` (16px) in `tokens.css`
- [x] **1.2** Add `--text-display: 2.25rem` (36px) token for hero-level headings (lock screen welcome, dashboard "Today")
- [x] **1.3** Increase `--text-2xl` from `1.625rem` to `1.75rem` (28px) for page titles
- [x] **1.4** Increase `--text-xl` from `1.375rem` to `1.5rem` (24px) for KPI values
- [x] **1.5** Add `--text-4xl: 2.5rem` token for display use
- [x] **1.6** Increase `--leading-normal` from `1.55` to `1.6` for better readability
- [x] **1.7** Add `--space-7: 1.75rem` to spacing scale for larger gaps
- [x] **1.8** Update `body` font-size reference in `tokens.css` to use the new base
- [x] **1.9** Increase note excerpt font from `--text-xs` to `--text-sm` for readability
- [x] **1.10** Increase habit dot size from `--space-5` (20px) to `--space-6` (24px) and font from `--text-2xs` to `--text-xs`

### Files touched
- `src/styles/tokens.css`
- `src/styles/app.css` (habit dots, note excerpts)

### Verification
- [ ] All pages render without overflow at new sizes (manual pass pending)
- [ ] Light mode still looks correct (manual pass pending)
- [x] No horizontal scrollbars introduced (`.habit-week-mini` still wraps via `.budget-row`)
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (186), `build` all pass

---

## Phase 2: Design Token Expansion

**Goal:** Add missing tokens for inputs, motion, and semantic patterns.

### Tasks

- [x] **2.1** Add `--color-surface-input: #1e1730` (dark) / `#f8f5ff` (light) — slightly lighter than surface-subtle for input fields
- [x] **2.2** Add `--shadow-inset: inset 0 1px 2px rgba(0,0,0,0.15)` for pressed states
- [x] **2.3** Add `--dur-slow: 300ms` for larger transitions
- [x] **2.4** Add `--ease-spring: cubic-bezier(0.34, 1.56, 0.64, 1)` for playful micro-interactions
- [x] **2.5** Add `--radius-input: 0.4375rem` (7px) — slightly tighter than `--radius-md` for form fields
- [x] **2.6** Add `--gradient-brand-glow: radial-gradient(circle, rgba(121,77,255,0.2), transparent 70%)` for icon backgrounds
- [x] **2.7** Add `--color-accent-gradient-start: #835bff` and `--color-accent-gradient-end: #5c2be2` as solid tokens (for non-gradient contexts)
- [x] **2.8** Update all `.input`, `.select`, `.textarea` to use `--color-surface-input` and `--radius-input`
- [x] **2.9** Add `@media (prefers-contrast: high)` block with increased border widths and stronger text colors
- [x] **2.10** Add `@media print` basic styles (hide sidebar, expand content)

### Files touched
- `src/styles/tokens.css`
- `src/styles/app.css` (input styles)

### Notes
- Every new token gets a `[data-theme="light"]` mirror; `--gradient-accent` now
  composes from the two stop tokens so the light override can't drift.
- `@media print` remaps tokens to paper values in tokens.css (token-lint forbids
  hex outside it), while app.css only hides chrome and un-clips the panes.

### Verification
- [x] Token lint script passes (`scripts/token-lint.mjs`)
- [x] Token contract tests pass (`src/styles/tokens.test.ts`)
- [ ] Inputs visually distinct from card backgrounds (manual pass pending)
- [x] `npm run lint`, `typecheck`, `test` (186), `build` all pass

---

## Phase 3: Button & Control Polish

**Goal:** Elevate buttons from functional to delightful.

### Tasks

- [x] **3.1** Replace `filter: brightness(1.08)` on `.btn-primary:hover` with a brighter gradient overlay or `background-color` shift
- [x] **3.2** Add `.btn-icon` variant — square, `min-height: var(--space-8)`, `padding: var(--space-2)`, icon-only with tooltip
- [x] **3.3** Add `.btn-loading` state — shows a CSS spinner (rotating border circle) inside the button
- [x] **3.4** Add border to `.btn-ghost:hover` using `--color-border-subtle`
- [x] **3.5** Add `transform: scale(0.98)` on `:active` for all buttons (tactile press)
- [x] **3.6** Add `transition: transform var(--dur-fast) var(--ease-spring)` for springy press effect
- [x] **3.7** Increase icon stroke width from `1.6` to `1.8` in `icons.tsx`
- [x] **3.8** Add `IconChevronLeft` and `IconChevronRight` SVG icons
- [x] **3.9** Replace all `◀` `▶` `‹` `›` text characters with proper SVG icons across all pages
- [x] **3.10** Add `IconSpinner` for loading states

### Files touched
- `src/styles/app.css`
- `src/components/icons.tsx`
- `src/pages/BudgetPage.tsx` (day/month/year nav arrows)
- `src/pages/JournalPage.tsx` (month nav arrows)
- `src/pages/HabitsPage.tsx` (month nav arrows)
- `src/pages/MemoriesPage.tsx`, `DashboardPage.tsx`, `SettingsPage.tsx`
  (3.9 covers every text arrow; Settings also uses `.btn-loading`)

### Notes
- `.btn-icon` is square via logical `inline-size`/`block-size`; `.month-nav .btn`
  padding is now scoped `:not(.btn-icon)` so it can't re-widen the chevrons.
- Pressed buttons use `--shadow-inset` alongside `scale(0.98)` — the Phase 2 token
  finally has a consumer.
- `.btn-loading` keeps the label in the DOM (`color: transparent`) so the button
  never changes size and screen readers still announce it; the spinner is
  absolutely centred and tinted per variant.

### Verification
- [x] All text arrows replaced with SVG icons (`[◀▶‹›«»→←]` matches nothing)
- [ ] Button press has satisfying tactile feedback (manual pass pending)
- [x] Loading spinners render correctly (settings export/import/share/install)
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (186), `build` all pass

---

## Phase 4: Form Input Enhancement

**Goal:** Make inputs feel premium with icons, custom selects, and validation.

### Tasks

- [x] **4.1** Add `IconSearch` as a leading icon in search inputs (Notes, Contacts)
- [x] **4.2** Add `IconCalendar` as a trailing icon in date inputs
- [x] **4.3** Style `<select>` with a custom chevron background SVG (data URI)
- [x] **4.4** Add `.input-icon-wrap` utility class — relative container with absolute-positioned icon
- [x] **4.5** Add `.input-invalid` class — red border + subtle shake animation
- [x] **4.6** Add `aria-invalid` binding on amount inputs when validation fails
- [x] **4.7** Add `.input-affix` for currency prefix (MMK) on amount fields
- [x] **4.8** Increase input padding slightly: `var(--space-2) var(--space-3)` → `var(--space-2) var(--space-4)`
- [x] **4.9** Add `transition: background-color var(--dur-fast)` on input hover
- [x] **4.10** Add subtle background shift on hover: `--color-surface-input` → slightly lighter

### Files touched
- `src/styles/app.css`
- `src/styles/tokens.css` (chevron data URI, danger focus ring)
- `src/pages/NotesPage.tsx`, `ContactsPage.tsx` (search inputs)
- `src/pages/BudgetPage.tsx`, `LoansPage.tsx`, `BusinessPage.tsx` (amount inputs)
- `src/pages/BudgetPage.tsx`, `TasksPage.tsx`, `MemoriesPage.tsx`, `LoansPage.tsx`,
  `BusinessPage.tsx`, `ContactsPage.tsx`, `GalleryPage.tsx` (date inputs)

### Notes
- The select chevron is a `--select-chevron` token, not an inline data URI in
  app.css: it encodes a colour, and token-lint keeps colours in tokens.css.
  Light mode gets its own stroke colour.
- `.input-icon-wrap` hides the Chromium/WebKit calendar glyph but keeps the
  native indicator stretched over the same spot, so click-to-open still works.
- `aria-invalid` (not a class) drives the invalid styling, so it matches the
  bare inputs that carry no `.input` class; the shake replays only when the
  attribute flips true and is disabled under `prefers-reduced-motion`.
- "Amount (MMK)" labels became "Amount" + `.input-affix-prefix`, since the unit
  is now visible inside the field.

### Verification
- [x] Search inputs have leading magnifier icon
- [x] Select dropdowns show custom chevron
- [x] Invalid amount shows red border + shake (existing inline message kept)
- [x] All inputs have consistent hover treatment
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (186), `build` all pass
- [ ] Manual pass on calendar click-through and chevron alignment

---

## Phase 5: Card & Surface Elevation

**Goal:** Make cards feel layered, premium, and alive.

### Tasks

- [x] **5.1** Increase `--gradient-card-shine` opacity from `0.03` to `0.06` (dark) / `0.8` → `0.4` (light)
- [x] **5.2** Add `@keyframes card-enter` — `opacity: 0; translateY(8px)` → `opacity: 1; translateY(0)`
- [x] **5.3** Add `.card-enter` class with `animation: card-enter var(--dur-slow) var(--ease-out) both`
- [x] **5.4** Apply staggered `animation-delay` to dashboard grid cards (nth-child)
- [x] **5.5** Add `.card-hover-lift` — `transform: translateY(-2px); box-shadow: var(--shadow-md)` on hover
- [x] **5.6** Apply `card-hover-lift` to `.kpi-card`, `.wallet-card`, `.more-card`
- [x] **5.7** Add `border-color: var(--color-accent-ring)` on `.kpi-card:hover` (currently `--color-border-strong`)
- [x] **5.8** Add `.card-section-divider` — subtle gradient line instead of flat border
- [x] **5.9** Fix nested card-in-card on Contacts: remove inner `.entry-form` border/background, use `.contact-form` with transparent background
- [x] **5.10** Add `position: relative` + `overflow: hidden` to cards for pseudo-element effects

### Files touched
- `src/styles/tokens.css`
- `src/styles/app.css`
- `src/pages/ContactsPage.tsx`
- `src/pages/DashboardPage.tsx` (applies `.card-enter`)

### Notes
- `card-enter`'s `to` frame deliberately omits `transform`: with
  `animation-fill-mode: both`, restating `translateY(0)` would win over the
  hover lift forever and freeze every card.
- 5.6 is wired through `.card-hover-lift:hover, .kpi-card:hover,
  .wallet-card:hover, .more-card:hover` so the three cards share one rule
  instead of three copies; the utility class stays available for new surfaces.
- 5.8 ships as a shared gradient-hairline rule over `.dash-card-head`,
  `.dash-card-foot`, `.side-form`, `.editor-actions` and `.contact-section`
  instead of an unused `.card-section-divider` class; Phase 10 re-adds the
  class where a divider element actually exists in markup.
- Light-mode shine was 0.6, not the 0.8 the plan assumed; set to the plan's 0.4.

### Verification
- [x] Cards have visible entrance animation on page load (dashboard KPI strip + sections, staggered)
- [x] Dashboard cards lift on hover
- [x] Contacts detail no longer has nested card borders
- [ ] Card shine is subtly visible (manual pass pending)
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (186), `build` all pass

---

## Phase 6: Dashboard Premium Pass

**Goal:** Transform the dashboard from a data dump into an executive command center.

### Tasks

- [x] **6.1** Increase KPI icon size from `--space-8` (32px) to `--space-10` (40px)
- [x] **6.2** Add `--gradient-brand-glow` background to `.kpi-icon` for a soft glow effect
- [x] **6.3** Increase KPI value font from `--text-xl` to `--text-2xl`
- [x] **6.4** Add `.kpi-trend` — small up/down arrow + percentage next to KPI value
- [x] **6.5** Add `IconTrendUp`/`IconTrendDown` mini indicators in KPI cards
- [x] **6.6** Balance dashboard grid: use explicit grid areas instead of `auto-fit` for consistent card heights
- [x] **6.7** Add `.dashboard-section-title` — section headers above card groups (e.g., "Overview", "Finance", "Personal")
- [x] **6.8** Increase habit dot size to `--space-6` (24px) with `--text-xs` font
- [x] **6.9** Add `gap: var(--space-4)` to `.habit-week-mini` (currently `--space-1`)
- [x] **6.10** Add `.kpi-card-variation` — subtle left border accent for visual interest

### Files touched
- `src/styles/app.css`
- `src/pages/DashboardPage.tsx`

### Notes
- 6.4/6.5 show a **real** day-over-day delta (extra `listDayEntries(yesterday)`
  query feeding a `KpiTrend` component) on the two money cards only. With no
  baseline the badge renders nothing rather than a fake "0%"; the receivable
  and action-item cards get no trend because there is no comparable series.
- 6.6 uses explicit column counts (3 / 2 / 1 at 78rem / 54rem) plus a shared
  `grid-auto-rows: minmax(13rem, auto)` rather than literal `grid-template-areas`
  — named areas would force every card into a fixed cell and clip longer cards.
- 6.7 splits the bento into two titled grids: "Today" (tasks, money, habits)
  and "Coming up" (memories, warranties, receivable). A title has to sit outside
  the grid to span it, so the single grid became two.
- 6.8 shipped back in Phase 1 (habit dots).

### Verification
- [x] KPI cards feel weighty and important (40px glowing icons, 28px values)
- [x] Dashboard grid is visually balanced
- [x] Habit dots are easily readable
- [x] Dashboard loads with staggered card animation
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (186), `build` all pass
- [ ] Manual balance pass outstanding

---

## Phase 7: Lock Screen & Onboarding Drama

**Goal:** Make the lock screen a moment of delight, not just a barrier.

### Tasks

- [x] **7.1** Strengthen `--gradient-app-glow` opacity from `0.16` to `0.22` (dark)
- [x] **7.2** Add `@keyframes pulse-glow` — subtle opacity/scale pulsing for the brand mark
- [x] **7.3** Apply `pulse-glow` animation to `.lock-brand-mark`
- [x] **7.4** Add `.pin-dots` — 4-6 dot indicators that fill as PIN is entered
- [x] **7.5** Add `@keyframes pin-fill` — dot fills with accent color + scale spring
- [x] **7.6** Split setup screen into two visual sections: "Step 1: PIN" and "Step 2: Security Question" with a visual divider
- [x] **7.7** Add `.setup-step-indicator` — numbered circles (1, 2) to show progress
- [x] **7.8** Add `box-shadow: 0 0 40px rgba(121,77,255,0.15)` to `.lock-wrap .entry-form` for a glow effect
- [x] **7.9** Add `@keyframes lock-shake` — horizontal shake on wrong PIN
- [x] **7.10** Apply `lock-shake` to the form on PIN verification failure

### Files touched
- `src/styles/tokens.css`
- `src/styles/app.css`
- `src/components/LockScreens.tsx`

### Notes
- 7.8 ships as a `--shadow-lock-glow` token; the raw `rgba()` literal would fail
  token-lint. 7.1 also strengthens the shared app glow, so the shell picks up a
  slightly brighter ambience too — check it isn't too strong behind the sidebar.
- `PinDots` renders `MIN_PIN_LENGTH` slots with a `+N` overflow badge rather than
  silently truncating a longer PIN, and is `aria-hidden` (the input keeps the
  real value). The plan's "4-6 dots" is pinned to the app's own 6-char minimum.
- The setup screen stays ONE `<form>` — the two steps are visual sections inside
  it, so submit/validation semantics (§2.9 fail-closed setup) are untouched.
- `lock-shake` also fires on a wrong security answer, and resets at the start of
  every submit plus on the next keystroke so it always replays.
- All three animations are disabled under `prefers-reduced-motion`.

### Verification
- [x] Lock screen has visible ambient glow (0.22 + `--shadow-lock-glow`)
- [x] Brand mark has subtle pulsing animation
- [x] PIN entry shows dot indicators (setup, unlock and reset flows)
- [x] Wrong PIN triggers shake animation
- [x] Setup screen has clear step separation
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (186), `build` all pass
- [ ] Manual glow/pulse strength pass pending

---

## Phase 8: Notes Studio Refinement

**Goal:** Make the notes editor feel like a premium writing tool.

### Tasks

- [ ] **8.1** Change note card background from `--color-surface-subtle` to `--color-surface-input` for better contrast
- [ ] **8.2** Replace raw 📌 emoji with `IconPin` SVG icon
- [ ] **8.3** Add `.note-card-pin-indicator` — small accent-colored left border for pinned notes
- [ ] **8.4** Add `.editor-resize-handle` — draggable divider between markdown and preview panes
- [ ] **8.5** Add `IconMarkdown` and `IconEye` icons for pane labels
- [ ] **8.6** Add word count display in `.editor-actions` (e.g., "245 words")
- [ ] **8.7** Add `.note-card-excerpt` line clamp fallback for non-webkit browsers
- [ ] **8.8** Add `transition: transform var(--dur-fast) var(--ease-spring)` on note card hover
- [ ] **8.9** Add `.note-list-empty` — larger empty state with icon when no notes exist
- [ ] **8.10** Add `@keyframes fade-in` for note editor when switching notes

### Files touched
- `src/styles/app.css`
- `src/components/icons.tsx`
- `src/pages/NotesPage.tsx`

### Verification
- [ ] Note cards visually distinct from panel background
- [ ] Pin uses SVG icon, not emoji
- [ ] Editor panes are resizable
- [ ] Word count visible in toolbar
- [ ] Note switching has smooth transition

---

## Phase 9: Budget Page Polish

**Goal:** Make financial data feel trustworthy and premium.

### Tasks

- [ ] **9.1** Increase progress bar height from `--space-2` (8px) to `0.625rem` (10px)
- [ ] **9.2** Add `--gradient-success: linear-gradient(90deg, #16a34a, #22c55e)` and similar for warn/danger
- [ ] **9.3] Apply gradients to `.progress-fill` variants instead of solid colors
- [ ] **9.4** Add `IconArrowLeft`/`IconArrowRight` to day/month/year navigation
- [ ] **9.5** Add `.wallet-card-gradient` — subtle gradient background based on wallet type
- [ ] **9.6] Add `.wallet-card-icon` — watermark-style large icon in card corner
- [ ] **9.7] Add `.amount-large` — bigger font for prominent amounts
- [ ] **9.8] Add `font-feature-settings: "tnum"` to `.figure` (already has `tabular-nums`, add `font-feature-settings` for broader support)
- [ ] **9.9** Add `.budget-summary-highlight` — subtle pulse on net cashflow when positive
- [ ] **9.10** Add `.year-table-row-hover` — stronger hover state with accent left border

### Files touched
- `src/styles/app.css`
- `src/components/icons.tsx`
- `src/pages/BudgetPage.tsx`

### Verification
- [ ] Progress bars use gradients, not flat colors
- [ ] All navigation uses SVG icons
- [ ] Wallet cards have visual interest
- [ ] Financial figures are prominent and readable

---

## Phase 10: Contacts & Settings Layout Fix

**Goal:** Fix structural layout issues and add visual variety.

### Tasks

- [ ] **10.1** Remove nested `.entry-form` inside `.contacts-detail` — replace with `.contact-form` (transparent background, no border)
- [ ] **10.2] Add `.contact-avatar-gradient` — gradient background based on name hash (pick from 4-5 preset gradients)
- [ ] **10.3] Add `.contact-detail-section` — sub-sections within the detail panel with subtle separators
- [ ] **10.4] Add `.settings-nav` — sticky sub-navigation for settings sections
- [ ] **10.5] Add `.settings-section-compact` — tighter padding for simple sections (About, Vault)
- [ ] **10.6] Add `.settings-section-expanded` — larger padding for complex sections (PIN, Backup)
- [ ] **10.7] Replace Dark/Light button toggle with a single `.theme-segmented` control
- [ ] **10.8] Add `IconSun` and `IconMoon` icons for theme toggle
- [ ] **10.9] Add `.settings-search` — filter input at top of settings page
- [ ] **10.10] Add `scroll-behavior: smooth` to `html` for anchor navigation

### Files touched
- `src/styles/app.css`
- `src/components/icons.tsx`
- `src/pages/ContactsPage.tsx`
- `src/pages/SettingsPage.tsx`

### Verification
- [ ] No nested card borders on Contacts detail
- [ ] Avatars have gradient backgrounds
- [ ] Settings has sticky nav + search
- [ ] Theme toggle is a single segmented control
- [ ] Settings sections have varied visual weight

---

## Phase 11: Gallery & Habits Polish

**Goal:** Make visual/photo features feel rich and habits feel satisfying.

### Tasks

- [ ] **11.1] Increase photo grid gap from `--space-3` (12px) to `--space-4` (16px)
- [ ] **11.2] Add `.photo-thumb-hover` — scale image 1.05x + show overlay with note text
- [ ] **11.3] Add `.photo-thumb-overlay` — gradient overlay at bottom with photo caption
- [ ] **11.4] Move photo inspector to a modal dialog instead of below-grid section
- [ ] **11.5] Add `.modal-backdrop` — semi-transparent overlay with blur
- [ ] **11.6] Add `.modal-content` — centered card with scale-in animation
- [ ] **11.7] Add `IconClose` icon for modal dismiss
- [ ] **11.8] Separate habit week strip from month grid into distinct sub-sections
- [ ] **11.9] Add `.habit-month-toggle` — collapse/expand month grid per habit
- [ ] **11.10] Increase habit day cell font to `--text-sm` and add `font-weight: var(--weight-semibold)` for today

### Files touched
- `src/styles/app.css`
- `src/components/icons.tsx`
- `src/pages/GalleryPage.tsx`
- `src/pages/HabitsPage.tsx`

### Verification
- [ ] Photo grid has generous gaps
- [ ] Photo thumbnails have hover zoom + caption overlay
- [ ] Photo inspector opens as modal
- [ ] Habit cards are less visually overloaded
- [ ] Month grid can be collapsed per habit

---

## Phase 12: Cross-Cutting Premium Features

**Goal:** Add the features that separate good apps from great apps.

### Tasks

- [ ] **12.1] Create `Skeleton` component — pulsing placeholder blocks matching layout shapes
- [ ] **12.2] Add `.skeleton-card`, `.skeleton-text`, `.skeleton-icon` variants
- [ ] **12.3] Replace all "Loading…" text with skeleton screens
- [ ] **12.4] Create `Toast` component — slide-in from bottom-right, auto-dismiss after 4s
- [ ] **12.5] Add `.toast-success`, `.toast-error`, `.toast-info` variants
- [ ] **12.6] Add `IconCheck`, `IconAlert`, `IconInfo` for toast icons
- [ ] **12.7] Create `useToast` hook — `toast.success("Note saved")`, `toast.error("Failed")`
- [ ] **12.8] Add `@keyframes toast-in` — slide up + fade in
- [ ] **12.9] Add `@keyframes toast-out` — fade out + slide down
- [ ] **12.10] Add keyboard shortcut overlay — press `?` to show shortcuts modal
- [ ] **12.11] Add `IconKeyboard` for shortcut hint
- [ ] **12.12] Add `data-shortcut` attributes to actionable elements
- [ ] **12.13] Add `@media (prefers-contrast: high)` — increase border widths to 2px, strengthen text
- [ ] **12.14] Add `@media print` — hide sidebar/nav, expand content, remove shadows
- [ ] **12.15] Add `scroll-behavior: smooth` to `html`
- [ ] **12.16] Add `::focus-visible` fallback for `:focus-visible` (for older browsers)
- [ ] **12.17] Add `.skip-to-content` link for keyboard accessibility
- [ ] **12.18] Add `aria-live="polite"` region for toast announcements
- [ ] **12.19] Add `.visually-hidden` improvement — use `clip` instead of `clip-path` for broader support
- [ ] **12.20] Add `title` tooltips to all icon-only buttons

### Files touched
- `src/styles/app.css`
- `src/styles/tokens.css`
- `src/components/icons.tsx`
- `src/components/Skeleton.tsx` (new)
- `src/components/Toast.tsx` (new)
- `src/App.tsx` (toast provider, shortcut overlay)
- All page components (skeleton loading)

### Verification
- [ ] All loading states use skeletons, not text
- [ ] Toasts appear and auto-dismiss correctly
- [ ] Keyboard shortcut overlay works
- [ ] High contrast mode renders correctly
- [ ] Print output is clean
- [ ] Skip-to-content link works

---

## Phase 13: Animation & Motion System

**Goal:** Create a cohesive motion language across the app.

### Tasks

- [ ] **13.1] Add `@keyframes fade-in` — `opacity: 0` → `opacity: 1`
- [ ] **13.2] Add `@keyframes slide-up` — `translateY(12px)` → `translateY(0)`
- [ ] **13.3] Add `@keyframes scale-in` — `scale(0.95)` → `scale(1)`
- [ ] **13.4] Add `@keyframes shimmer` — background-position sweep for skeletons
- [ ] **13.5] Add `.animate-fade-in`, `.animate-slide-up`, `.animate-scale-in` utility classes
- [ ] **13.6] Add `animation-fill-mode: both` to all animation utilities
- [ ] **13.7] Add `animation-delay` stagger utilities: `.delay-1` through `.delay-8`
- [ ] **13.8] Apply `animate-fade-in` to page content on route change
- [ ] **13.9] Apply `animate-slide-up` to cards on scroll into view (IntersectionObserver)
- [ ] **13.10] Add `animate-scale-in` to modals and dropdowns
- [ ] **13.11] Add `animate-shimmer` to skeleton components
- [ ] **13.12] Add `transition: all var(--dur-fast) var(--ease-out)` to interactive elements missing it
- [ ] **13.13] Add `will-change: transform` to animated elements (use sparingly)
- [ ] **13.14] Add `@media (prefers-reduced-motion: reduce)` override for all animations (already exists, verify coverage)

### Files touched
- `src/styles/app.css`
- `src/styles/tokens.css`
- `src/App.tsx`
- All page components

### Verification
- [ ] Page transitions are smooth
- [ ] Cards animate in with stagger
- [ ] Modals scale in from center
- [ ] Skeletons shimmer
- [ ] Reduced motion disables all animations
- [ ] No jank or layout thrashing

---

## Phase 14: Icon System Completion

**Goal:** Round out the icon set with missing icons and filled variants.

### Tasks

- [ ] **14.1] Add `IconChevronLeft` — left-pointing chevron
- [ ] **14.2] Add `IconChevronRight` — right-pointing chevron
- [ ] **14.3] Add `IconSun` — sun for light mode
- [ ] **14.4] Add `IconMoon` — moon for dark mode
- [ ] **14.5] Add `IconClose` — X for modal dismiss
- [ ] **14.6] Add `IconCheck` — checkmark (already exists, verify)
- [ ] **14.7] Add `IconAlert` — alert triangle
- [ ] **14.8] Add `IconInfo` — info circle
- [ ] **14.9] Add `IconKeyboard` — keyboard for shortcuts
- [ ] **14.10] Add `IconSpinner` — loading spinner
- [ ] **14.11] Add `IconMarkdown` — markdown icon for editor label
- [ ] **14.12] Add `IconEye` — eye for preview label
- [ ] **14.13] Add `IconPin` — pin for pinned notes
- [ ] **14.14] Add filled variants: `.icon-filled` class that uses `fill: currentColor` for specific icons
- [ ] **14.15] Increase default stroke width from `1.6` to `1.8`
- [ ] **14.16] Add `IconEdit` — pencil for edit actions
- [ ] **14.17] Add `IconTrash` — trash can for delete actions
- [ ] **14.18] Add `IconExternal` — external link arrow
- [ ] **14.19] Add `IconFilter` — filter funnel
- [ ] **14.20] Add `IconSort` — sort arrows

### Files touched
- `src/components/icons.tsx`

### Verification
- [ ] All icons render at consistent stroke width
- [ ] New icons used in appropriate places
- [ ] Filled variants work where needed
- [ ] Icon lint passes

---

## Phase 15: Final Polish & Quality Pass

**Goal:** Sweep for remaining inconsistencies and add final premium touches.

### Tasks

- [ ] **15.1] Audit all pages for consistent `page-header` usage
- [ ] **15.2] Ensure all `page-subtitle` elements use `--color-text-muted`
- [ ] **15.3] Verify all badges use consistent sizing
- [ ] **15.4] Check all `border-radius` values use token variables
- [ ] **15.5] Verify all `box-shadow` values use token variables
- [ ] **15.6] Check all `transition` properties use token variables
- [ ] **15.7] Ensure all `gap` values use spacing tokens
- [ ] **15.8] Add `selection` styling for light mode (currently only dark)
- [ ] **15.9] Add `::placeholder` styling for light mode inputs
- [ ] **15.10] Verify all `aria-label` attributes are descriptive
- [ ] **15.11] Add `role="status"` to loading indicators
- [ ] **15.12] Add `aria-busy="true"` to loading containers
- [ ] **15.13] Verify color contrast ratios meet WCAG AA (4.5:1 for text)
- [ ] **15.14] Add `focus-visible` styles to all interactive elements
- [ ] **15.15] Add `skip-to-content` link as first element in `App.tsx`
- [ ] **15.16] Add `lang="en"` to `<html>` element
- [ ] **15.17] Add `meta description` to `index.html`
- [ ] **15.18] Add `theme-color` meta tag for browser chrome
- [ ] **15.19] Verify all images have `alt` attributes
- [ ] **15.20] Final visual regression check — compare before/after screenshots

### Files touched
- All files

### Verification
- [ ] No hardcoded colors outside `tokens.css`
- [ ] No hardcoded spacing outside `tokens.css`
- [ ] All interactive elements have focus styles
- [ ] All images have alt text
- [ ] Color contrast passes WCAG AA
- [ ] HTML is valid and semantic
- [ ] Light mode is fully polished
- [ ] Dark mode is fully polished

---

## Progress Log

### Session 1 — Audit & Planning
- [x] Comprehensive UI audit completed
- [x] 15-phase polish plan created
- [x] Priority matrix established

### Phase 1 — Typography & Spacing Foundation
- [x] Tokens: `--text-base: 1rem` (with `--text-md` aliased to it so existing
      consumers, including the inlined phone share page, keep working)
- [x] Scale: `--text-xl` 24px, `--text-2xl` 28px, `--text-3xl` 32px, `--text-4xl` 40px, `--text-display` 36px
- [x] `--leading-normal: 1.6`, `--space-7: 1.75rem`
- [x] app.css: `.note-excerpt` → `--text-sm`, `.habit-dot` → 24px / `--text-xs`
- [x] Gates green: token-lint, biome, tsc, 186 tests, vite build
- [ ] Manual visual pass (overflow + light mode) still outstanding

### Phase 2 — Design Token Expansion
- [x] Input tokens: `--color-surface-input` (dark + light), `--radius-input`
- [x] Motion: `--dur-slow`, `--ease-spring`; elevation: `--shadow-inset` (both themes)
- [x] Brand: `--gradient-brand-glow`, `--color-accent-gradient-start/end`
      (light values folded into `--gradient-accent` so they cannot drift)
- [x] app.css: unified form-control rule + `input.editor-title` on the new
      input surface/radius
- [x] `@media (prefers-contrast: high)` — 2px borders, stronger text/borders
      (light theme redeclared because `[data-theme]` outranks `:root`)
- [x] `@media print` — tokens remapped to paper in tokens.css, chrome hidden and
      panes un-clipped in app.css
- [x] Gates green: token-lint, biome, tsc, 186 tests, vite build
- [ ] Manual visual pass (input/card contrast in both themes) outstanding

### Phase 3 — Button & Control Polish
- [x] `.btn-primary:hover` brightens via a gradient shift (no `filter`)
- [x] `.btn-icon` square variant, `.btn-loading` spinner state, ghost hover border
- [x] `:active` → `scale(0.98)` + `--shadow-inset`; transform eases with spring
- [x] icons.tsx: stroke 1.8, added chevrons, arrow-right and spinner
- [x] Every `◀ ▶ ‹ › →` in TSX is now an SVG icon (Budget/Journal/Habits/
      Memories/Dashboard/Settings), each with `aria-label` + `title`
- [x] `.btn-loading` wired into Settings export/import/share/install
- [x] Gates green: token-lint, biome, tsc, 186 tests, vite build
- [ ] Manual press/spinner feel check outstanding

### Phase 4 — Form Input Enhancement
- [x] `.input-icon-wrap` + `.input-icon(.is-end)`: magnifier on Notes/Contacts
      search, calendar on all nine date inputs
- [x] Selects: `appearance: none` + `--select-chevron` token (dark + light)
- [x] `.input-affix` MMK prefix on every money field; "Amount (MMK)" → "Amount"
- [x] `aria-invalid` + `--shadow-focus-danger` + `input-shake` on invalid amounts
- [x] Input padding `space-2 space-4`; hover shifts to `--color-surface-raised`
      (hover selector list completed — it was missing 3 controls)
- [x] Gates green: token-lint, biome, tsc, 186 tests, vite build
- [ ] Manual pass on calendar click-through and chevron alignment outstanding

### Phase 5 — Card & Surface Elevation
- [x] Shine 0.03 → 0.06 (dark) / 0.6 → 0.4 (light)
- [x] `card-enter` keyframes + `.card-enter`, staggered across `.kpi-grid` and
      `.dashboard-grid`; `transform` omitted from the `to` frame so `both` fill
      cannot pin the hover lift
- [x] One shared hover-lift rule for `.card-hover-lift`, `.kpi-card`,
      `.wallet-card`, `.more-card`; KPI border now `--color-accent-ring`
- [x] Section separators are gradient hairlines (card head/foot, side-form,
      editor-actions, contact-section)
- [x] `position: relative` + `overflow: hidden` on every card surface
- [x] Contacts detail: `.entry-form.contact-form` no longer draws a second card
- [x] Gates green: token-lint, biome, tsc, 186 tests, vite build
- [ ] Manual shine/lift check outstanding

### Phase 6 — Dashboard Premium Pass
- [x] KPI icons 32px → 40px with `--gradient-brand-glow`; values → `--text-2xl`
- [x] `.kpi-card-variation` hairline accent on the leading edge (status-tinted)
- [x] `.kpi-trend` + `.kpi-trend-row` with real yesterday comparison
- [x] Bento grid: explicit 3/2/1 columns, shared minimum row height
- [x] `.dashboard-section-title` — "Today" and "Coming up" groups
- [x] `.habit-week-mini` gap `--space-4` (6.8 already done in Phase 1)
- [x] Gates green: token-lint, biome, tsc, 186 tests, vite build
- [ ] Manual balance pass outstanding

### Phase 7 — Lock Screen & Onboarding Drama
- [x] App glow 0.16 → 0.22; new `--shadow-lock-glow` halo on the lock card
- [x] `pulse-glow` on the brand mark, `lock-shake` on a failed verification
- [x] `PinDots` progress indicator (6 slots + `+N` overflow, `aria-hidden`)
      across setup, unlock and PIN-reset flows
- [x] Setup split into `.setup-step` 1/2 with `.setup-step-indicator` circles
      and a dashed divider — still a single `<form>`
- [x] All three animations disabled under `prefers-reduced-motion`
- [x] Gates green: token-lint, biome, tsc, 186 tests, vite build
- [ ] Manual glow/pulse strength pass pending

### Phase 8 — Notes Studio Refinement
- [ ] Not started

### Phase 9 — Budget Page Polish
- [ ] Not started

### Phase 10 — Contacts & Settings Layout Fix
- [ ] Not started

### Phase 11 — Gallery & Habits Polish
- [ ] Not started

### Phase 12 — Cross-Cutting Premium Features
- [ ] Not started

### Phase 13 — Animation & Motion System
- [ ] Not started

### Phase 14 — Icon System Completion
- [ ] Not started

### Phase 15 — Final Polish & Quality Pass
- [ ] Not started

---

## Estimated Effort

| Phase | Effort | Priority |
|---|---|---|
| Phase 1 | 2 hours | Critical |
| Phase 2 | 1.5 hours | Critical |
| Phase 3 | 2 hours | High |
| Phase 4 | 2.5 hours | High |
| Phase 5 | 2 hours | High |
| Phase 6 | 3 hours | High |
| Phase 7 | 2.5 hours | Medium |
| Phase 8 | 2 hours | Medium |
| Phase 9 | 2 hours | Medium |
| Phase 10 | 2.5 hours | Medium |
| Phase 11 | 2 hours | Medium |
| Phase 12 | 4 hours | High |
| Phase 13 | 2 hours | Medium |
| Phase 14 | 1.5 hours | Low |
| Phase 15 | 3 hours | High |
| **Total** | **~34.5 hours** | |

---

## Success Criteria

The UI polish is complete when:

1. **Visual:** The app looks like a premium desktop application (compare: Linear, Notion, Raycast)
2. **Motion:** Every interaction has appropriate feedback (hover, active, focus, loading)
3. **Consistency:** No hardcoded colors or spacing outside `tokens.css`
4. **Accessibility:** WCAG AA contrast, full keyboard navigation, screen reader support
5. **Performance:** Animations run at 60fps, no layout thrashing
6. **Maintainability:** All new components follow existing patterns, tokens are used consistently
