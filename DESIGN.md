# Design System — Atelier

## Product Context
- **What this is:** PM dashboard for tenant engagement, AI-driven SMS lead scoring, and conversation management.
- **Who it's for:** Property managers at Stay Management AS doing desktop triage sessions with occasional mobile check-ins.
- **Space/industry:** PropTech / tenant engagement (Bergen, Norway). Peers: Hybel, Finn.no, Rentr.
- **Project type:** App UI (data-dense dashboard, task-focused, status-driven).

## Aesthetic Direction
- **Direction:** Industrial / Utilitarian
- **Decoration level:** Minimal. Typography, color, and spacing do all the work. No decorative blobs, gradients, or ornamental icons.
- **Mood:** Calm, dense, precise. The PM should feel like a professional at a well-organized workstation, not a consumer browsing a marketing site.
- **Classifier:** APP UI. Apply App UI rules from gstack design-review.

## Typography
- **Display/Hero:** Playfair Display (serif) for brand mark only (the "A" badge, page title). Not used for headings inside the app shell.
- **Body:** Inter for all UI text, labels, table content, and buttons.
- **UI/Labels:** Inter (same as body).
- **Data/Tables:** Inter with `font-variant-numeric: tabular-nums` for scores, counts, and timestamps.
- **Code:** SF Mono, Fira Code, monospace (for message previews or debug views).
- **Loading:** Google Fonts for Playfair Display; Inter via system font stack or CDN.
- **Scale:** 12px captions / 13px labels / 14px body / 16px section headings / 20px page titles / 28px brand.

## Color
- **Approach:** Restrained. One warm accent, neutrals, and semantic colors.
- **Primary surfaces:**
  - `--bg-primary: #0d0f11` (app background)
  - `--bg-secondary: #151719` (sidebar, panels)
  - `--bg-card: #1a1d20` (cards, rows)
  - `--bg-elevated: #22262a` (inputs, hover)
  - `--border: #2a2e33`
- **Text:**
  - `--text-primary: #e8e8e8` (headings, body)
  - `--text-secondary: #9a9ea3` (labels, metadata)
  - `--text-muted: #6b7075` (placeholders, disabled)
- **Accent:** `--accent: #c4a265` (warm gold, CTAs, brand badge, active nav).
- **Semantic:**
  - Success: `--accent-green: #4dbd74`
  - Error: `--accent-red: #e54d4d`
  - Warning: `--accent-amber: #e5a84d`
  - Info: `--accent` (gold, same as primary accent)
- **Dark mode:** This IS the dark mode. No light mode planned. Off-white text (~#e8e8e8), not pure white. Surfaces use elevation (bg-primary < bg-secondary < bg-card < bg-elevated).

## Spacing
- **Base unit:** 4px
- **Density:** Comfortable (not compact, not spacious). PM scans many rows but needs breathing room.
- **Scale:** 2xs(2px) xs(4px) sm(8px) md(16px) lg(24px) xl(32px) 2xl(48px) 3xl(64px)

## Layout
- **Approach:** Grid-disciplined. Sidebar + main content. Tables use CSS grid with fixed column templates.
- **Sidebar:** Fixed 240px on desktop. Collapses to icon-only or hamburger on mobile (below 768px).
- **Main content:** Fluid, max-width not needed (dashboard fills viewport).
- **Conversation view:** Two-column (thread + profile sidebar 280px). Stacks vertically below 768px with profile as collapsible panel.
- **Border radius hierarchy:**
  - `--radius-sm: 8px` (inputs, small badges)
  - `--radius-md: 12px` (cards, modals)
  - `--radius-lg: 16px` (login card, panels)
  - `--radius-xl: 20px` (page-level containers)

## Motion
- **Approach:** Minimal-functional. Only transitions that aid comprehension.
- **Easing:** ease-out for entrances, ease-in for exits.
- **Duration:** micro 50-100ms (hover, focus), short 150-250ms (state changes, nav transitions).
- **Constraint:** Respect `prefers-reduced-motion`. No layout-property animations (width, height). Only transform and opacity.

## Interaction States
- **Hover:** `--bg-elevated` background shift on rows and nav links.
- **Focus:** Visible `outline` ring using `--accent` color, 2px offset. Never `outline: none` without replacement.
- **Active/pressed:** Slight scale or darken.
- **Disabled:** 0.5 opacity + `cursor: not-allowed`.
- **Loading:** Skeleton shapes matching row layout with shimmer. "Loading..." text as fallback.
- **Empty states:** Warm message, primary action button, contextual icon. Never bare "No items."
- **Error:** Specific message + suggested action. Red accent border for inline errors.

## Accessibility
- **Contrast:** Body text on bg-primary meets WCAG AA (4.5:1). Labels on bg-card meet 3:1 for large text.
- **Touch targets:** 44px minimum on all interactive elements.
- **Keyboard:** All interactive elements focusable. Tab order follows visual order. Escape closes modals/drawers.
- **Screen readers:** ARIA landmarks on sidebar (nav), main content (main), and conversation (region).
- **No color-only encoding:** Flow badges use text labels alongside color. Score tiers labeled, not color-only.

## Component Conventions
- **FlowBadge:** Pill with colored background at 12% opacity + colored text. Unknown states show raw state string as fallback (acceptable for dev, refine for prod).
- **Lead rows:** CSS grid with consistent column template. Clickable rows use `role="button"` + keyboard handlers.
- **Conversation composer:** Single text area. Enter for primary action (currently AI), explicit button for SMS. Shift+Enter for newline.
- **Confirm dialogs:** In-app modal preferred over `window.confirm` for takeover, override, and destructive actions.

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-04 | Initial design system created from existing CSS variables and UI patterns | Extracted from styles.css, Dashboard.jsx, and component conventions by /design-consultation analysis |
| 2026-04-04 | Classified as APP UI, not marketing | Dashboard is data-dense, task-focused. Apply calm hierarchy, utility language, minimal chrome |
| 2026-04-04 | Kept Inter as primary body font | Already in use, good tabular-nums support, readable at small sizes |
| 2026-04-04 | Playfair Display restricted to brand mark only | Serif display font does not belong in data tables or headings for an app UI |
