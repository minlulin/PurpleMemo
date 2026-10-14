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
- [x] **1.5** ~~Add `--text-4xl: 2.5rem` token~~ — added in Phase 1, removed in
      the final cleanup as an unused rung (`--text-display` is the real top)
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
- [x] **4.5** Invalid state — red border + subtle shake. Shipped as a
      `.input-invalid` class, then narrowed to `aria-invalid` in the final
      cleanup so no unused selector survives (see 4.6)
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
- [x] **5.5** Hover lift — `transform: translateY(-2px); box-shadow: var(--shadow-md)` (shipped as a `.card-hover-lift` class, folded into the shared hover rule in the final cleanup)
- [x] **5.6** Apply the hover lift to `.kpi-card`, `.wallet-card`, `.more-card`
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
- 5.6 is one shared rule — `.kpi-card:hover, .wallet-card:hover,
  .more-card:hover` — so the three cards can't drift apart; each card declares
  its own transition list.
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

- [x] **8.1** Change note card background from `--color-surface-subtle` to `--color-surface-input` for better contrast
- [x] **8.2** Replace raw 📌 emoji with `IconPin` SVG icon
- [x] **8.3** Add `.note-card-pin-indicator` — small accent-colored left border for pinned notes
- [x] **8.4** Add `.editor-resize-handle` — draggable divider between markdown and preview panes
- [x] **8.5** Add `IconMarkdown` and `IconEye` icons for pane labels
- [x] **8.6** Add word count display in `.editor-actions` (e.g., "245 words")
- [x] **8.7** Add `.note-card-excerpt` line clamp fallback for non-webkit browsers
- [x] **8.8** Add `transition: transform var(--dur-fast) var(--ease-spring)` on note card hover
- [x] **8.9** Add `.note-list-empty` — larger empty state with icon when no notes exist
- [x] **8.10** Add `@keyframes fade-in` for note editor when switching notes

### Files touched
- `src/styles/app.css`
- `src/components/icons.tsx`
- `src/pages/NotesPage.tsx`

### Notes
- 8.4 is a real drag, not decoration: pointer capture on the handle, ratio
  clamped to 25–75%, `touch-action: none`, and ArrowLeft/ArrowRight for
  keyboard users. The split is a CSS variable
  (`--editor-split-ratio`) so the grid owns the layout; below 56rem the panes
  stack and the handle hides itself.
- The handle is an `<hr>`, not `<div role="separator">` — Biome's
  `useSemanticElements` rule requires the real element. Padding (not grid gap)
  spaces the panes around it.
- 8.1 + 8.3 together: the pin indicator adds a 3px leading border, so its
  padding is reduced by 2px to keep every card's text on the same line.
- 8.2 replaces the 📌 emoji with `IconPin` plus a `.visually-hidden` "Pinned",
  since the icon itself is `aria-hidden`.
- 8.10 keys the animation off `selected?.id` on the pane, so it replays on
  every note switch (the editor already remounts per note).

### Verification
- [x] Note cards visually distinct from panel background (input surface)
- [x] Pin uses SVG icon, not emoji
- [x] Editor panes are resizable (pointer + keyboard)
- [x] Word count visible in toolbar
- [x] Note switching has smooth transition
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (187), `build` all pass
- [ ] Manual drag/feel pass pending

---

## Phase 9: Budget Page Polish

**Goal:** Make financial data feel trustworthy and premium.

### Tasks

- [x] **9.1** Increase progress bar height from `--space-2` (8px) to `0.625rem` (10px)
- [x] **9.2** Add `--gradient-success: linear-gradient(90deg, #16a34a, #22c55e)` and similar for warn/danger
- [x] **9.3** Apply gradients to `.progress-fill` variants instead of solid colors
- [x] **9.4** Add `IconArrowLeft`/`IconArrowRight` to day/month/year navigation
- [x] **9.5** Add `.wallet-card-gradient` — subtle gradient background based on wallet type
- [x] **9.6** Add `.wallet-card-icon` — watermark-style large icon in card corner
- [x] **9.7** Add `.amount-large` — bigger font for prominent amounts
- [x] **9.8** Add `font-feature-settings: "tnum"` to `.figure` (already has `tabular-nums`, add `font-feature-settings` for broader support)
- [x] **9.9** Add `.budget-summary-highlight` — subtle pulse on net cashflow when positive
- [x] **9.10** Add `.year-table-row-hover` — stronger hover state with accent left border

### Files touched
- `src/styles/tokens.css`
- `src/styles/app.css`
- `src/pages/BudgetPage.tsx`
- `src/pages/DashboardPage.tsx` (`.amount-large` on the receivable figure)

### Notes
- 9.4 was already delivered in Phase 3 — every day/month/year nav button is now
  an SVG chevron (plus `IconArrowRight` on the dashboard shortcuts), so no text
  arrows remain. Chevrons stay: arrows imply a jump, chevrons imply a step.
- 9.5 cannot key off "wallet type" — the wallet row has no type field, and
  inventing one is a schema change, not a UI pass. `.wallet-card-gradient`
  therefore uses the shared `--gradient-card-shine` so a row of wallets stops
  looking like identical grey boxes; `.wallet-card-icon` (9.6) carries the
  per-card visual interest instead.
- `.wallet-card-balance` now only owns colour. It previously set
  `font-size`/`font-weight`, and because it sits *later* in the file than
  `.amount-large` it silently won the cascade — the new class would have been
  dead on exactly the element it was added for.
- 9.10's accent left border is compensated with 2px less start padding on the
  first cell, so hovering a row doesn't shift the table sideways.
- 9.9 pulses only when net cashflow is positive; a loss gets no decoration.

### Verification
- [x] Progress bars use gradients, not flat colors (10px tall)
- [x] All navigation uses SVG icons (Phase 3)
- [x] Wallet cards have visual interest (shine + corner watermark)
- [x] Financial figures are prominent and readable (`tnum` + font-feature-settings)
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (187), `build` all pass
- [ ] Manual pass on bar/wallet feel pending

---

## Phase 10: Contacts & Settings Layout Fix

**Goal:** Fix structural layout issues and add visual variety.

### Tasks

- [x] **10.1** Remove nested `.entry-form` inside `.contacts-detail` — replace with `.contact-form` (transparent background, no border)
- [x] **10.2] Add `.contact-avatar-gradient` — gradient background based on name hash (pick from 4-5 preset gradients)
- [x] **10.3** Add `.contact-detail-section` — sub-sections within the detail panel with subtle separators
- [x] **10.4** Add `.settings-nav` — sticky sub-navigation for settings sections
- [x] **10.5** Add `.settings-section-compact` — tighter padding for simple sections (About, Vault)
- [x] **10.6** Add `.settings-section-expanded` — larger padding for complex sections (PIN, Backup)
- [x] **10.7** Replace Dark/Light button toggle with a single `.theme-segmented` control
- [x] **10.8** Add `IconSun` and `IconMoon` icons for theme toggle
- [x] **10.9** Add `.settings-search` — filter input at top of settings page
- [x] **10.10** Add `scroll-behavior: smooth` to `html` for anchor navigation

### Files touched
- `src/styles/tokens.css`
- `src/styles/app.css`
- `src/components/icons.tsx`
- `src/pages/ContactsPage.tsx`
- `src/pages/SettingsPage.tsx`

### Notes
- **Bug caught while wiring 10.9:** the filter hides sections with the `hidden`
  attribute, but `.settings-section { display: flex }` beats the UA's
  `[hidden] { display: none }` — every "hidden" section would have stayed on
  screen. Added a global `[hidden] { display: none !important }`.
- 10.9 reuses the Phase 4 `.input-icon-wrap` instead of adding a
  `.settings-search` class, so the filter looks like every other search field.
  The nav and the sections filter off the same `SETTINGS_SECTIONS` table, so
  they can never disagree.
- 10.4 uses real `<a href="#settings-…">` anchors (keyboard + middle-click
  work for free) with `scroll-margin-top` so targets clear the sticky nav.
- 10.7 is a `<fieldset>` with a visually-hidden legend — Biome rejects
  `role="group"` on a div, and a fieldset is the honest grouping anyway.
- 10.2 hashes the name with a stable 31-multiplier, so a contact keeps its
  colour across sessions; 10.3 is an alias of the existing `.contact-section`
  rule (same separator, both names) rather than a second copy.

### Verification
- [x] No nested card borders on Contacts detail (Phase 5's `.contact-form`)
- [x] Avatars have gradient backgrounds
- [x] Settings has sticky nav + search
- [x] Theme toggle is a single segmented control
- [x] Settings sections have varied visual weight
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (187), `build` all pass
- [ ] Manual pass on nav stickiness and avatar palette pending

---

## Phase 11: Gallery & Habits Polish

**Goal:** Make visual/photo features feel rich and habits feel satisfying.

### Tasks

- [x] **11.1] Increase photo grid gap from `--space-3` (12px) to `--space-4` (16px)
- [x] **11.2] Add `.photo-thumb-hover` — scale image 1.05x + show overlay with note text
- [x] **11.3] Add `.photo-thumb-overlay` — gradient overlay at bottom with photo caption
- [x] **11.4** Move photo inspector to a modal dialog instead of below-grid section
- [x] **11.5] Add `.modal-backdrop` — semi-transparent overlay with blur
- [x] **11.6] Add `.modal-content` — centered card with scale-in animation
- [x] **11.7** Add `IconClose` icon for modal dismiss
- [x] **11.8** Separate habit week strip from month grid into distinct sub-sections
- [x] **11.9] Add `.habit-month-toggle` — collapse/expand month grid per habit
- [x] **11.10** Increase habit day cell font to `--text-sm` and add `font-weight: var(--weight-semibold)` for today

### Files touched
- `src/styles/tokens.css`
- `src/styles/app.css`
- `src/components/icons.tsx`
- `src/pages/GalleryPage.tsx`
- `src/pages/HabitsPage.tsx`

### Notes
- 11.4 is a real dialog, not a styled section: `role="dialog"` +
  `aria-modal` + `aria-labelledby`, Escape to close, **Tab cycles inside the
  dialog**, focus starts on the close button and returns to the thumbnail that
  opened it. "Click outside" is a real `<button class="modal-dismiss">` under
  the dialog rather than a click handler on the backdrop div — Biome rejects
  handlers on static elements, and a div handler would have been mouse-only.
- Scrim and caption fade are `--color-scrim` / `--gradient-photo-fade` tokens
  (alpha colours are only allowed in tokens.css), with light-mode values.
- 11.2/11.3: `.photo-thumb:hover img` zooms the photo, not the tile, so the
  caption overlay rides along; the overlay also appears on `:focus-visible` so
  keyboard users get it too.
- 11.8/11.9: the month grid is now behind a per-habit "Show month" disclosure
  (`aria-expanded`), so a card with many habits is a list of week strips until
  you ask for history. Month state is a `Set` of habit ids.
- 11.10 uses `--weight-semibold` for today as planned; `--weight-bold` there
  fought `.is-active`'s semibold for precedence.

### Verification
- [x] Photo grid has generous gaps
- [x] Photo thumbnails have hover zoom + caption overlay
- [x] Photo inspector opens as modal (Escape, focus trap, focus return)
- [x] Habit cards are less visually overloaded
- [x] Month grid can be collapsed per habit
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (187), `build` all pass
- [ ] Manual pass on modal feel and thumb hover pending

---

## Phase 12a: Feedback Layer — Skeletons & Toasts

**Goal:** Replace "Loading…" and silent failures with real feedback. Split out
of the old cross-cutting Phase 12 because it has the widest blast radius — it
touches every page component plus the `App.tsx` provider — and wants its own
reviewable commit.

### Tasks

- [x] **12a.1** Create `Skeleton` component — pulsing placeholder blocks matching layout shapes
- [x] **12a.2** Add `.skeleton-card`, `.skeleton-text`, `.skeleton-icon` variants
- [x] **12a.3** Replace all "Loading…" text with skeleton screens
- [x] **12a.4** Create `Toast` component — slide-in from bottom-right, auto-dismiss after 4s
- [x] **12a.5** Add `.toast-success`, `.toast-error`, `.toast-info` variants
- [x] **12a.6** Add `IconCheck`, `IconAlert`, `IconInfo` for toast icons
- [x] **12a.7** Create `useToast` hook — `toast.success("Note saved")`, `toast.error("Failed")`
- [x] **12a.8** Add `@keyframes toast-in` — slide up + fade in
- [x] **12a.9** Add `@keyframes toast-out` — fade out + slide down
- [x] **12a.10** Add `aria-live="polite"` region for toast announcements

### Files touched
- `src/styles/app.css`
- `src/components/icons.tsx`
- `src/components/Skeleton.tsx` (new)
- `src/components/Toast.tsx` (new)
- `src/App.tsx` (toast provider, boot skeleton)
- `src/pages/*.tsx` (skeleton loading; SettingsPage confirmations)

### Notes
- `App`'s shell became `AppShell` with a thin `App` that mounts
  `<ToastProvider>` — wrapping the early returns instead would have created a
  different provider per lock/boot branch.
- 12a.3 shapes follow the real layout, not one generic block: DashboardPage
  renders the same `kpi-grid` + `dashboard-grid` it will fill, NotesPage and
  JournalPage render their split panes, the Gallery renders a square
  `skeleton-grid`, HabitsPage renders habit cards. Reflow on load would be worse
  than the "Loading…" text it replaces.
- Toasts are wired to SettingsPage's four confirmations (PIN updated, backup
  saved, backup imported, key download). The reminder/share **notes** in
  `App.tsx` deliberately stay inline alerts: "notifications are blocked" needs
  to outlast a 4-second toast.
- A toast unmounts on a timer, not `animationend` — under reduced motion there
  is no animation to end and the row would stick forever. The stack also caps
  at four.
- 12a.6 added `IconAlert` + `IconInfo`; `IconCheck` already existed from Phase 3.

### Verification
- [x] All loading states use skeletons, not text (23 sites, zero "Loading…" left)
- [x] Toasts appear and auto-dismiss correctly
- [x] Toast announcements reach a screen reader once, not twice
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (187), `build` all pass
- [ ] Manual pass on skeleton sizing and toast timing pending

---

## Phase 12b: Accessibility & Keyboard Layer

**Goal:** The non-visual paths through the app. Split from the old cross-cutting
Phase 12 because it is orthogonal to feedback: it changes how the app is
*navigated*, not how it reports state, and it reuses the modal/dismiss
patterns that 11.4 already established.

### Tasks

- [x] **12b.1** Add keyboard shortcut overlay — press `?` to show shortcuts modal
- [x] **12b.2** Add `IconKeyboard` for shortcut hint
- [x] **12b.3** Add `data-shortcut` attributes to actionable elements
- [x] **12b.4** Add `::focus-visible` fallback for `:focus-visible` (older browsers)
- [x] **12b.5** Add `.skip-to-content` link for keyboard accessibility
- [x] **12b.6** Add `.visually-hidden` improvement — use `clip` instead of `clip-path`
- [x] **12b.7** Add `title` tooltips to all icon-only buttons
- [x] ~~**12b.8** `@media (prefers-contrast: high)`~~ — shipped in Phase 2 (2.9)
- [x] ~~**12b.9** `@media print`~~ — shipped in Phase 2 (2.10), extended in the
      Phase 8-11 audit (un-grids the dashboard, hides the modal)
- [x] ~~**12b.10** `scroll-behavior: smooth` on `html`~~ — shipped in Phase 10 (10.10)

### Files touched
- `src/styles/app.css`
- `src/styles/tokens.css` (focus outline tokens return, now consumed by 12b.4)
- `src/components/icons.tsx`
- `src/components/Dialog.tsx` (new — extracted from GalleryPage)
- `src/App.tsx` (skip link, shortcut overlay, key handler)
- `src/pages/GalleryPage.tsx` (now renders `<Dialog>`)

### Notes
- GalleryPage's inspector (11.4) already had a focus trap, Escape and focus
  return. Rather than copy that into a second modal, the logic moved to
  `Dialog.tsx` and both modals render it — the shortcut overlay inherits the
  scrim, Tab trap and focus restore for free. GalleryPage lost ~40 lines and
  two refs.
- 12b.4 ships as `@supports not selector(:focus-visible)`, so the outline only
  appears in engines that would otherwise have no focus ring at all. That
  re-introduces `--focus-outline-width`/`--focus-outline-offset`, which the
  cleanup pass had removed as unused — they have a consumer again.
- 12b.3's `data-shortcut` attributes are **read by the overlay**: it scrapes
  `[data-shortcut]` on open and lists each control's `aria-label`/text. Adding
  a shortcut to a control therefore lists itself, and the help can't drift from
  what the app binds. Dialog-wide behaviours (Esc, Tab, the skip link) have no
  owning element, so those three rows stay written out — a pure scrape would
  miss them.
- `?` is ignored while typing in a field and while any `[role=dialog]` is open,
  so it cannot stack a second dialog on the photo inspector.
- 12b.7 needed no changes: all 15 `btn-icon` buttons already carry `title`
  **and** `aria-label` (verified by scanning every `<button>` with an icon).

### Verification
- [x] Keyboard shortcut overlay works and is dismissible
- [x] Skip-to-content link works (`#main-content` is focusable via `tabIndex`)
- [x] Focus is visible on every interactive element
- [x] Every icon-only button has a `title`
- [x] High contrast mode renders correctly (2.9, already shipped)
- [x] Print output is clean (2.10, already shipped)
- [x] Zero unused selectors/tokens (only `skeleton-*`/`toast-*`, built dynamically)
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (187), `build` all pass
- [ ] Manual pass: tab order, skip link, overlay on a real screen pending

---

## Phase 13: Animation & Motion System

**Goal:** Create a cohesive motion language across the app.

### Tasks

- [x] **13.1] Add `@keyframes fade-in` — `opacity: 0` → `opacity: 1`
- [x] **13.2] Add `@keyframes slide-up` — `translateY(12px)` → `translateY(0)`
- [x] **13.3] Add `@keyframes scale-in` — `scale(0.95)` → `scale(1)`
- [x] **13.4] Add `@keyframes shimmer` — background-position sweep for skeletons
- [x] **13.5] Add `.animate-fade-in`, `.animate-slide-up`, `.animate-scale-in` utility classes
- [x] **13.6] Add `animation-fill-mode: both` to all animation utilities
- [x] **13.7] Add `animation-delay` stagger utilities: `.delay-1` through `.delay-8`
- [x] **13.8] Apply `animate-fade-in` to page content on route change
- [x] **13.9] Apply `animate-slide-up` to cards on scroll into view (IntersectionObserver)
- [x] **13.10] Add `animate-scale-in` to modals and dropdowns
- [x] **13.11] Add `animate-shimmer` to skeleton components
- [x] **13.12** Add transitions to interactive elements missing them
- [x] **13.13] Add `will-change: transform` to animated elements (use sparingly)
- [x] **13.14] Add `@media (prefers-reduced-motion: reduce)` override for all animations (already exists, verify coverage)

### Files touched
- `src/styles/app.css`
- `src/lib/useReveal.ts` (new)
- `src/App.tsx`
- `src/components/Dialog.tsx`
- `src/pages/DashboardPage.tsx`
- `src/pages/NotesPage.tsx`

### Notes
- **13.12 does not use `transition: all`, deliberately.** `all` makes the
  browser watch every property on every hover — more main-thread work, and it
  animates things never intended (box-shadows, layout properties). Three
  elements genuinely had no transition (`button.chip`, `.side-remove`,
  `.year-table` cells) and each now transitions exactly the properties it
  changes. Everything else already declared one.
- 13.9 **replaces** Phase 5's `card-enter`: the reveal hook adds
  `is-revealed` + `animate-slide-up` at intersection time, and `.delay-N` in
  markup staggers it. Two entrance mechanisms for one job would have been one
  too many, so `card-enter` and its keyframes are gone.
- The reveal is an **animation, not a transition** — a transition has no
  `animation-delay` for `.delay-N` to read. That was a real bug in the first
  cut of this phase: the stagger delays were inert.
- The hook takes `ready` (`!loading` on the dashboard). Observing the container
  while it still held skeletons would have found zero targets and left the
  cards that arrived later stuck at `opacity: 0`.
- `slide-up` and `scale-in` omit `transform` from their `to` frames, so
  `animation-fill-mode: both` cannot pin a hover lift (the Phase 5 trap).
- 13.11: skeletons run `shimmer` **and** `skeleton-pulse` in one shorthand, so
  the block still reads as loading when the sweep is subtle.
  `.animate-shimmer` was dropped rather than shipped unused — a
  single-animation utility would have overwritten the pulse.
- 13.13: `will-change` only on the two animations that never stop
  (`.skeleton`, `.icon-spin`).
- 13.14: the global `prefers-reduced-motion` block already neutralises every
  animation and transition with `!important`; the per-utility block makes the
  intent explicit next to the utilities.
- 13.3 folded the Phase 11 `modal-in` keyframe into the shared `scale-in`.

### Verification
- [x] Page transitions are smooth (`animate-fade-in` on a `key={page}` `<main>`)
- [x] Cards animate in with stagger (dashboard, `.delay-1`…`.delay-8`)
- [x] Modals scale in from center (`animate-scale-in` via `Dialog`)
- [x] Skeletons shimmer
- [x] Reduced motion disables all animations
- [x] No jank: `will-change` limited to the two infinite animations
- [x] Zero unused selectors, keyframes and tokens
- [x] `npm run lint`, `token-lint`, `typecheck`, `test` (187), `build` all pass
- [ ] Manual pass on scroll reveal and motion feel pending

---

## Phase 14: Icon System Completion

**Goal:** Round out the icon set with missing icons and filled variants.

### Tasks

- [ ] **14.1] Add `IconChevronLeft` — left-pointing chevron
- [x] **14.2] Add `IconChevronRight` — right-pointing chevron *(Phase 3)*
- [x] **14.3] Add `IconSun` — sun for light mode *(Phase 10)*
- [x] **14.4] Add `IconMoon` — moon for dark mode *(Phase 10)*
- [x] **14.5] Add `IconClose` — X for modal dismiss *(Phase 11)*
- [x] **14.6] Add `IconCheck` — checkmark (already exists, verified)
- [x] **14.7] Add `IconAlert` — alert triangle *(Phase 12a)*
- [x] **14.8] Add `IconInfo` — info circle *(Phase 12a)*
- [x] **14.9] Add `IconKeyboard` — keyboard for shortcuts *(Phase 12b — owned there)*
- [x] **14.10] Add `IconSpinner` — loading spinner *(Phase 3)*
- [x] **14.11] Add `IconMarkdown` — markdown icon for editor label *(Phase 8)*
- [x] **14.12] Add `IconEye` — eye for preview label *(Phase 8)*
- [x] **14.13] Add `IconPin` — pin for pinned notes (already exists, verified)
- [ ] **14.14] Filled variants — **rejected**, see Notes
- [x] **14.15] Increase default stroke width from `1.6` to `1.8` *(Phase 3)*
- [x] **14.16] Add `IconEdit` — pencil for edit actions
- [x] **14.17] Add `IconTrash` — trash can for delete actions
- [ ] **14.18] Add `IconExternal` — **rejected**, see Notes
- [x] **14.19] Add `IconFilter` — filter funnel
- [ ] **14.20] Add `IconSort` — **rejected**, see Notes

### Files touched
- `src/components/icons.tsx`
- `src/pages/ContactsPage.tsx`
- `src/pages/GalleryPage.tsx`
- `src/pages/SettingsPage.tsx`

### Notes
- **15 of 20 tasks were already done** by Phases 3, 8, 10, 11 and 12a/b. 14.9
  was explicitly earmarked to 12b.2, so this phase is mostly verification; the
  real work was 14.16/14.17/14.19.
- **14.14 rejected.** `.icon-filled { fill: currentColor }` is a footgun for a
  stroke-first set: CSS `fill` beats the `fill="none"` presentation attribute,
  so *every* path would render as a solid blob. Filling an open polyline like
  `IconCheck`'s `m5 12.5 4.5 4.5L19 7.5` implicitly closes it and yields a
  sliver, not a checkmark. A genuine filled variant needs per-icon filled
  geometry authored in the component, and no current UI asks for one — the one
  fill-safe glyph here is the ellipsis, whose 1.5r circles with a 1.8 stroke
  already read as solid dots.
- **14.18 rejected.** The only candidate was the share URL in Settings, but it
  is a read-only field you copy from, not a link — an "opens off-device" glyph
  there decorates rather than informs. It also needed a full-width
  `.input-icon-wrap` inside a bare label, and those wraps are `inline-flex`,
  so the field would have silently shrink-wrapped. No outbound links exist in
  the app today.
- **14.20 rejected.** Nothing in the app offers a user-facing sort control;
  adding one purely to justify an icon is backwards.
- New icons were added *with* call sites rather than shipped into the library
  to sit unused, per the same zero-unused standard applied to CSS:
  `IconTrash` on the two primary delete actions (photo, contact), `IconEdit` on
  the contact save button, `IconFilter` on Settings' "Filter settings" input
  (a funnel is what that field does — `IconSearch` reads as a page search).
- Icons need no button CSS: `.btn` is already `inline-flex` with `gap`, and
  `.icon` is `1.1em` with `flex: none`.
- `IconArrowLeft` is the only declared-but-unused export, kept because
  `IconArrowRight` is used everywhere and a one-sided pair is worse.

### Verification
- [x] All icons render at consistent stroke width (single 1.8 base, `base()`)
- [x] New icons used in appropriate places
- [x] Every exported icon except `IconArrowLeft` has a call site
- [x] Icon lint passes (biome + typecheck clean)

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
- [ ] **15.15** Add `skip-to-content` link as first element in `App.tsx`
      (owned by 12b.5; drop this line if 12b has already landed)
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
- [x] Scale: `--text-xl` 24px, `--text-2xl` 28px, `--text-display` 36px
      (`--text-3xl`/`--text-4xl` were added here and removed in the cleanup —
      nothing sized between 28 and 36px exists in this app)
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
- [x] One shared hover-lift rule for `.kpi-card`, `.wallet-card`,
      `.more-card`; KPI border now `--color-accent-ring`
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

### Audit — Phases 1-7 recheck
Automated sweep: every `var(--x)` resolves to a defined token, every
`className` in TSX has a matching CSS rule, all 20 `<select>`s are covered by
the chevron rule, and the built CSS keyframe list matches intent. Four real
issues found and fixed:

- [x] **Mid-typing false positive (Phase 4).** `parseMMK("12.")` is `null`, so
      typing a decimal marked every money field invalid — red border + shake on
      each keystroke. Added `isPartialAmount()` to `src/lib/money.ts` (with
      tests) and switched all 7 `aria-invalid` bindings plus the budget warning
      to it. A half-typed amount is no longer "wrong".
- [x] **Duplicate "Today" heading (Phase 6).** The page title and the new
      section title were both "Today"; the KPI strip now carries "Overview".
- [x] **`@keyframes spin` collision risk (Phase 3).** Tailwind's `animate-spin`
      ships the same keyframe name; ours is now `icon-spin-rotate` so the two
      can't shadow each other the moment someone uses that utility.
- [x] **Print kept the screen bento rhythm (Phase 2 + 5/6).** The print block
      did not un-grid `.kpi-grid`/`.dashboard-grid`, so printed pages kept
      fixed columns and `minmax()` row heights — dead whitespace. Both are
      `display: block` in print now.

At the time of this audit `.card-hover-lift` and `.input-invalid` were kept as
the documented opt-in APIs for 5.5 and 4.5; the final cleanup below removed
them. `card-header`, `editor-title-input` and `limit-exceeded` were already
dead CSS before Phase 1.

### Audit — Phases 8-11 recheck
Same sweep plus a read of the newest logic. Five issues found and fixed:

- [x] **`.contact-detail-section` was dead CSS (Phase 10).** Added as an alias
      but never used; the contacts detail panels now actually use it, which is
      what 10.3 asked for.
- [x] **Settings filter could hide an unknown section (Phase 10).** `shows()`
      returned false for any id missing from `SETTINGS_SECTIONS`, so a section
      added without a nav entry would silently vanish while typing. It now
      defaults to visible.
- [x] **Editor split reset on every note switch (Phase 8).** The ratio lived in
      `NoteEditor`, which is keyed by note id, so switching notes snapped the
      panes back to 50/50. Lifted to the page.
- [x] **Dashed separator drawn twice on habit cards (Phase 11).** The rule hit
      both `.month-nav` rows; narrowed to `:first-child`.
- [x] **Print didn't hide the modal (Phase 2 + 11).** Printing with the photo
      inspector open would have dumped the scrim and dialog onto the page.

Verified clean: all 7 `aria-invalid` inputs sit inside a container the invalid
rules actually match (so the red border fires everywhere), `.day-cell` keeps
`position: relative` for its entry dot, and the modal has no transformed or
filtered ancestor that would break `position: fixed`.

### Cleanup — dead CSS + dead tokens
Housekeeping runs last, after the feature phases, so nothing "unused" is really
"not reached yet". Removed:

- Selectors no element can match: `.card-header`, `.limit-exceeded`, and the
  `.editor-title-input` half of the `input.editor-title` rule.
- The opt-in utilities added during the polish itself, folded into the rules
  that actually run: `.card-hover-lift` (→ `.kpi-card:hover,
  .wallet-card:hover, .more-card:hover`) and `.input-invalid` (→ the
  `aria-invalid` selectors).
- Orphaned tokens: `--focus-outline-width` / `--focus-outline-offset` (left
  behind when focus moved to `--shadow-focus`) and the never-referenced rungs
  `--text-3xl`, `--text-4xl`, `--weight-regular`, `--border-width-thick`.
- `--text-display`, added in Phase 1 and unused, was instead *put to use* on
  the lock/setup headline — which is what 1.2 reserved it for.

The bar afterwards is strict: **every class selector in `app.css` appears in
some `.tsx`, and every token in `tokens.css` is referenced** (the two
audit scripts re-run clean).

### Phase 8 — Notes Studio Refinement
- [x] Note cards on the input surface; hover lifts with the spring easing
- [x] `IconPin` + `.note-card-pin-indicator` replace the 📌 emoji
- [x] Draggable editor split (pointer capture, 25–75% clamp, arrow keys)
- [x] `IconMarkdown`/`IconEye` pane labels, live word count in `.editor-actions`
- [x] `.note-list-empty` empty state, `fade-in` on note switch
- [x] Standard `line-clamp` alongside the `-webkit-` pair
- [x] Gates green: token-lint, biome, tsc, 187 tests, vite build
- [ ] Manual drag/feel pass pending

### Phase 9 — Budget Page Polish
- [x] Progress tracks 8px → 10px, fills use `--gradient-success/warn/danger`
      (light mode retinted) and a neutral brand gradient by default
- [x] Wallet cards: gradient surface + corner watermark, `.amount-large` balance
- [x] `.figure` gained `font-feature-settings: "tnum"`
- [x] Net cashflow pulses only when positive; year rows get an accent edge
- [x] 9.4 already covered by Phase 3 chevrons
- [x] Gates green: token-lint, biome, tsc, 187 tests, vite build
- [ ] Manual pass on bar/wallet feel pending

### Phase 10 — Contacts & Settings Layout Fix
- [x] Contacts: hashed avatar gradients (5 presets), `.contact-detail-section`
      alias, nested card already gone from Phase 5
- [x] Settings: filter input + sticky anchor nav over one shared section table
- [x] `.settings-section-compact` (Vault, About) and `-expanded` (PIN, Backup)
- [x] `.theme-segmented` fieldset with `IconMoon`/`IconSun` replaces two buttons
- [x] `html { scroll-behavior: smooth }` (off under reduced motion)
- [x] Bug fix: global `[hidden] { display: none !important }` — class `display`
      rules were beating the UA rule, so filtered-out sections stayed visible
- [x] Gates green: token-lint, biome, tsc, 187 tests, vite build
- [ ] Manual pass on nav stickiness and avatar palette pending

### Phase 11 — Gallery & Habits Polish
- [x] Photo grid gap 12px → 16px; thumbs zoom the image and reveal the caption
      on hover *and* focus
- [x] Inspector is a real dialog: `aria-modal`, Escape, Tab trap, focus return;
      backdrop is a dismiss button, not a click handler on a div
- [x] `--color-scrim` / `--gradient-photo-fade` tokens (dark + light)
- [x] `IconClose` and `IconChevronDown` added
- [x] Habits: week strip and month history are separate blocks, month grid
      behind a per-habit `aria-expanded` disclosure
- [x] Day cells `--text-sm`; today is semibold (bold was fighting `.is-active`)
- [x] Gates green: token-lint, biome, tsc, 187 tests, vite build
- [ ] Manual pass on modal feel and thumb hover pending

### Phase 12a — Feedback Layer (Skeletons & Toasts)
- [x] `Skeleton` component: text/icon/card variants, last bar short
- [x] All 23 loading sites are skeletons now, shape-matched per page; zero
      "Loading…" strings remain in the app
- [x] `ToastProvider` + `useToast` in a new `Toast.tsx`; settings confirmations
      (PIN, backup export/import, key download) are toasts
- [x] `toast-in`/`toast-out`, per-tone variants, `IconAlert`/`IconInfo` added
- [x] Timer-driven dismissal (survives reduced motion), stack capped at 4,
      one polite live region, print hides the stack
- [x] Gates green: token-lint, biome, tsc, 187 tests, vite build
- [ ] Manual pass on skeleton sizing and toast timing pending

### Phase 12b — Accessibility & Keyboard Layer
- [x] `Dialog.tsx`: GalleryPage's trap/Escape/focus-return extracted and shared,
      so the overlay cannot ship a weaker modal than the inspector
- [x] `?` opens the shortcut overlay, `Ctrl/⌘+L` locks the workspace; both
      ignored while typing and while a dialog is already open
- [x] `.skip-to-content` as the shell's first tab stop, targeting a focusable
      `#main-content`
- [x] `@supports not selector(:focus-visible)` outline fallback
- [x] `.visually-hidden` gained the legacy `clip` alongside `clip-path`
- [x] `IconKeyboard` added; `data-shortcut` on the two triggerable actions,
      and the overlay scrapes those attributes so a new shortcut lists itself
- [x] 12b.7 verified, not assumed: all 15 icon-only buttons already had
      `title` + `aria-label`
- [x] Gates green: token-lint, biome, tsc, 187 tests, vite build
- [ ] Manual pass: tab order, skip link, overlay on a real screen pending

### Phase 13 — Animation & Motion System
- [x] `fade-in` (already present) + new `slide-up`, `scale-in`, `shimmer`
- [x] `.animate-*` utilities, `both` fill, `.delay-1`…`.delay-8` — all wired
- [x] `.app-main` keyed by page → fades on every route change
- [x] `useRevealWithin` + `.reveal-on-scroll` replaces Phase 5's `card-enter`;
      dashboard cards reveal on scroll, staggered from markup
- [x] `Dialog` renders `.animate-scale-in`; skeletons shimmer + pulse
- [x] 13.12 rejected `transition: all`; three transition-less elements got
      explicit property lists
- [x] `will-change` on the two infinite animations only
- [x] Caught a self-inflicted bug: the reveal was a transition, so `.delay-N`
      had no `animation-delay` to act on
- [x] Gates green: token-lint, biome, tsc, 187 tests, vite build
- [ ] Manual pass on scroll reveal and motion feel pending

### Phase 14 - Icon System Completion
- [x] 15 of 20 tasks already landed in Phases 3/8/10/11/12a/12b - verified
- [x] Added `IconEdit`, `IconTrash`, `IconFilter`, each wired to a real
      call site in the same change (contact save, two delete actions, settings
      filter)
- [x] Rejected 14.14 `.icon-filled`: `fill: currentColor` overrides the
      `fill="none"` attribute and would render every stroked path as a blob
- [x] Rejected 14.18 `IconExternal`: the share URL is a copyable field, not a
      link, and no outbound link exists in the app
- [x] Rejected 14.20 `IconSort`: no user-facing sort control exists to host it
- [x] Gates green: token-lint, biome, tsc, 187 tests, vite build

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
| Phase 12a | 2.5 hours | High |
| Phase 12b | 1.5 hours | High |
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
