# Changelog

All notable changes to this repository ([akijain2000/atelier](https://github.com/akijain2000/atelier) — legacy Vite + Express PM dashboard) are documented here. The product-wide PRD lives in `docs/PRD_ATELIER.md` (mirrors the workspace `PRD_ATELIER.md` at Stay; **v2.4** as of 2026-04-04).

## [Unreleased]

Nothing yet.

## [2026-04-04] — UI V2 pack, ops hardening, documentation

### Added

- **`DESIGN.md`** — App UI design system: color tokens, typography, spacing, breakpoints, motion, accessibility (`:focus-visible`), and notes for dashboard components. Required reading before UI edits (`CLAUDE.md` points here).
- **`docs/atelier-ui-v2-plan.md`** — Full **Atelier UI V2 Plan**: screen-by-screen targets, empty/error states, responsive rules, information architecture, PM journey, and consolidated **plan-design-review** decisions (queue columns, dual scores, Score Now, confirm dialogs, session toast, heading rule).
- **`docs/PRD_ATELIER.md`** — Product requirements **v2.4** snapshot, including new §**1.2** (legacy UI V2 pack and where specs live in this repo).
- **`src/components/ConfirmDialog.jsx`** — Accessible confirmation modal for destructive or high-impact actions.
- **`src/components/Toast.jsx`** — Lightweight toast for transient messages (e.g. session expired).

### Changed

- **`server.js`**
  - Inbound SMS/webhook path: **reject unauthenticated** requests when neither Pling nor simulator configuration authorizes the payload.
  - **`GET /api/health`**: runs **`SELECT 1`** against Postgres; JSON includes database connectivity; responds **503** when the database is unavailable.
- **`src/pages/Dashboard.jsx`** — Session expiry: dispatch/listen for custom event and show **toast** before redirect to `/login`; **mobile** navigation via hamburger + overlay sidebar.
- **`src/components/AttentionQueue.jsx`** — Two-column mental model (form vs conversation), **stale** signaling, **updated-ago** display.
- **`src/components/FilteredLeads.jsx`** — Clickable rows with **ConfirmDialog** where the flow needs an explicit guard.
- **`src/components/AllConversations.jsx`** — Clearer **empty** states aligned to the UI plan.
- **`src/pages/ConversationView.jsx`** — Empty thread treatment, **last updated**, composer hint, **Score Now** → `POST /api/conversations/:id/score`.
- **`src/styles.css`** — Dialog and toast styling, empty-state patterns, responsive sidebar, focus-visible rings, login spacing per `DESIGN.md`.
- **`src/lib/auth.js`** — Supporting behavior for session / client flows as used by the dashboard (see diff for specifics).
- **`CLAUDE.md`** — Deploy/hosting notes aligned to **Render** (`https://atelier.onrender.com` with verify-in-dashboard caveat); health check path; mandatory `DESIGN.md` for UI.

### Documentation

- **`COMPLETED_LOG.md`** — New section **“gstack UI V2 pipeline + ops hardening (2026-04-04)”** with planning steps, file map, and PRD pointer.
- **`CHANGELOG.md`** — This file.

### Notes

- **Canonical Next.js app** for net-new product work remains [anubhavb11/Atelier](https://github.com/anubhavb11/Atelier); this release improves the **legacy** stack for testing, Render deploys, and strangler migration.
- Design-review and QA-only **evidence** (screenshots, reports) intentionally stay under local gstack paths (e.g. `~/.gstack/projects/atelier/`), not in git.

### Also touched (content / prompts)

- `prompts/Prompt.md`, `prompts/listings/N94_3ROMS.md`, and **`prompts/contracts/`** (new) — prompt and listing contract assets updated in the same integration window; review commit diff for exact wording.
