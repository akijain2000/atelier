# Atelier UI V2 Plan

## Purpose

This document defines every screen, state, and interaction in Atelier's PM dashboard,
aligned to PRD_ATELIER.md and the prior analysis backlog. It serves as the input for
plan-design-review and as the spec for implementation.

## Screens

### 1. Login

**Route:** `/login`


| Aspect     | Current                           | V2 target                                                         |
| ---------- | --------------------------------- | ----------------------------------------------------------------- |
| Layout     | Centered card, 380px max-width    | Keep. Add focus ring on inputs (DESIGN.md a11y).                  |
| Error      | Red inline banner                 | Keep; add session-expired variant when redirected from Dashboard. |
| Loading    | Button text swap                  | Keep.                                                             |
| Responsive | Already centered; works on mobile | No change needed.                                                 |


### 2. Dashboard Shell

**Route:** `/` (layout wrapper for all authenticated pages)


| Aspect         | Current                                                     | V2 target                                                            |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Sidebar        | Fixed 240px, no collapse, no mobile treatment               | Add hamburger/overlay below 768px (DESIGN.md layout).                |
| Nav links      | 3 items: Attention Queue, Filtered Leads, All Conversations | Keep. Consider adding a count badge on Attention Queue.              |
| User info      | Email below brand                                           | Keep.                                                                |
| Session expiry | Silent redirect to `/login` on `/me` 401                    | Show toast: "Session expired. Please log in again." before redirect. |
| Auth check     | `getToken()` gate in React Router                           | Keep.                                                                |


### 3. Attention Queue

**Route:** `/` (index route inside Dashboard)


| Aspect      | Current                                                              | V2 target                                                                     |
| ----------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Data source | `GET /api/conversations`, client filter by ATTENTION_STATES          | Keep.                                                                         |
| Columns     | Tenant, Phone, Status (FlowBadge), Score (preliminary only), Updated | **Add:** Conversation score column if `latest_score` exists.                  |
| Empty state | Text: "No leads need attention right now."                           | Add icon + contextual copy.                                                   |
| Error state | "Failed to load." + Retry button                                     | Keep; suppress full-page error on poll failure (show stale data + indicator). |
| Poll        | 15s interval                                                         | Add "Updated X ago" indicator in header.                                      |
| Rows        | Clickable, keyboard accessible                                       | Keep.                                                                         |
| Responsive  | Grid columns compress; no stacking                                   | Stack to card layout below 768px.                                             |


### 4. Filtered Leads

**Route:** `/filtered`


| Aspect      | Current                                                | V2 target                                                            |
| ----------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| Rows        | Not clickable to conversation view                     | **Make rows clickable** to `/conversation/:id`.                      |
| Override    | `window.confirm` before push to pipeline               | Replace with in-app confirm dialog (DESIGN.md component convention). |
| Columns     | Tenant, Score, Status, Move-in, Intro, Override button | Keep; add Phone column for consistency.                              |
| Groups      | By month                                               | Keep.                                                                |
| Empty state | "No filtered leads."                                   | Add icon + contextual copy.                                          |
| Responsive  | 6-col grid; breaks on narrow                           | Stack to card layout below 768px.                                    |


### 5. All Conversations

**Route:** `/all`


| Aspect        | Current                                                                      | V2 target                         |
| ------------- | ---------------------------------------------------------------------------- | --------------------------------- |
| Columns       | Tenant, Phone, Status, Score (best of latest/preliminary), Messages, Updated | Keep.                             |
| Score display | Color-coded class but no legend                                              | Add tooltip or legend.            |
| Empty state   | "No conversations yet."                                                      | Add icon + contextual copy.       |
| Responsive    | 6-col grid                                                                   | Stack to card layout below 768px. |


### 6. Conversation View

**Route:** `/conversation/:id`


| Aspect          | Current                                               | V2 target                                                                 |
| --------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| Layout          | Thread column + 280px sidebar                         | Sidebar collapses to bottom panel below 768px.                            |
| Composer        | Enter = Send via AI, separate SMS button              | Keep behavior. Add visual label clarifying which channel the tenant sees. |
| Takeover        | `window.confirm`                                      | Replace with in-app confirm dialog.                                       |
| Release         | `window.confirm`                                      | Replace with in-app confirm dialog.                                       |
| Empty thread    | No designed state                                     | Add empty state: "No messages yet. Compose the first message below."      |
| Poll            | 8s interval                                           | Add "last updated" timestamp in thread header.                            |
| Score sidebar   | Shows Form Score + Conv. Score + Likelihood + Summary | **Add "Score Now" button** to trigger scoring API from sidebar.           |
| Delivery status | Per-message badge                                     | Keep; ensure `pending` status shows spinner.                              |
| Back button     | `navigate(-1)`                                        | Keep.                                                                     |


## Interaction State Matrix


| State                          | Visual treatment                                                        |
| ------------------------------ | ----------------------------------------------------------------------- |
| Loading (initial)              | Skeleton rows matching grid layout; "Loading..." text as fallback.      |
| Loading (poll refresh)         | No visual change; data updates silently. Stale indicator if poll fails. |
| Empty                          | Icon + descriptive text + primary action where applicable.              |
| Error (initial load)           | Message + Retry button.                                                 |
| Error (poll fail)              | Show stale data with amber "Connection issue" indicator; auto-retry.    |
| Session expired                | Toast notification, then redirect to `/login`.                          |
| Sending (message)              | Button disabled, text "Sending...", composer locked.                    |
| Send error                     | Inline red text below composer.                                         |
| Confirming (takeover/override) | In-app modal dialog with Cancel/Confirm.                                |


## Responsive Breakpoints


| Breakpoint | Behavior                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------ |
| >= 1024px  | Full layout: sidebar + main + conversation sidebar.                                        |
| 768-1023px | Sidebar collapsed to icon strip or hamburger. Conversation sidebar below thread.           |
| < 768px    | Sidebar as overlay. Lead tables stack to cards. Conversation profile as collapsible panel. |


## Prior Analysis — Scope Classification

### In-scope for V2 implementation


| #   | Finding                                                              | Priority | Plan step        |
| --- | -------------------------------------------------------------------- | -------- | ---------------- |
| 1   | Inbound SMS auth open when Pling unset                               | P0       | implement        |
| 2   | Session expiry: silent redirect → toast                              | P1       | implement        |
| 3   | `window.confirm` → in-app dialogs (takeover, override, release)      | P1       | implement        |
| 4   | Filtered leads rows not clickable                                    | P1       | implement        |
| 5   | Empty states bare text                                               | P1       | implement        |
| 6   | Mobile/responsive: sidebar, tables, conversation                     | P1       | implement        |
| 7   | "Send via AI" clarity: label which channel tenant sees               | P1       | implement        |
| 8   | Poll failure: show stale data + indicator instead of full-page error | P1       | implement        |
| 9   | Conversation score on queue rows                                     | P2       | implement        |
| 10  | "Score Now" button in conversation sidebar                           | P2       | implement        |
| 11  | "Updated X ago" indicator on polled lists                            | P2       | implement        |
| 12  | Health endpoint hardening (DB/AI/MCP checks)                         | P2       | implement        |
| 13  | CLAUDE.md URL/platform drift fix                                     | P1       | docs-ops-hygiene |


### Deferred (not in V2 scope)


| #   | Finding                                                | Reason                                          |
| --- | ------------------------------------------------------ | ----------------------------------------------- |
| D1  | Next.js migration (PRD §1.1 vs Express monolith)       | Strategic decision, not UI polish               |
| D2  | Full lead-to-lease pipeline (Calendly, BankID, credit) | Requires product scope expansion                |
| D3  | Unit holding / cross-tenant arbitration                | Requires backend architecture                   |
| D4  | Philippines ops personas / analytics routes            | New feature, not in current sprint              |
| D5  | WebSocket/SSE for realtime                             | Infrastructure change; polling adequate for now |
| D6  | JWT → httpOnly cookie migration                        | Security project, separate workstream           |
| D7  | Prompt versioning and changelog                        | Prompts/ops workstream                          |
| D8  | MCP least-privilege / correlation IDs                  | Infrastructure hardening                        |
| D9  | CI pipeline / automated tests                          | DevOps workstream                               |


## Information Architecture

```
Login
└── Dashboard Shell (authenticated)
    ├── / (Attention Queue) ← default view, highest urgency
    ├── /filtered (Filtered Leads) ← low-score, reviewable
    ├── /all (All Conversations) ← complete list, sortable
    └── /conversation/:id (Conversation View)
        ├── Thread column (messages, composer)
        └── Profile sidebar (tenant info, scores, actions)
```

Navigation hierarchy: flat. All three list views are siblings in the sidebar.
Conversation View is a drill-down from any list. Back button returns to the
originating list (browser history).

## User Journey: PM Triage Session

1. **Login** → Dashboard opens to Attention Queue.
2. **Scan queue** → PM sees leads sorted by recency. Red badges (Manual Needed, PM Takeover) draw eye first.
3. **Open lead** → Click row → Conversation View. Thread loads with auto-scroll to bottom.
4. **Review context** → Sidebar shows tenant profile, scores, flow state.
5. **Act:**
  - **AI response:** Type message, press Enter or "Send via AI" button. Oline generates response.
  - **SMS:** Type message, click "Send SMS". Direct to tenant's phone.
  - **Take over:** Click "Take Over" → confirm dialog → AI paused, PM replies directly.
  - **Score:** Click "Score Now" → triggers scoring API → sidebar updates.
6. **Return** → Back button → Attention Queue. Lead state may have changed.
7. **Check filtered** → Switch to Filtered Leads. Review low-score leads. Click "Push to Pipeline" if warranted.
8. **End session** → Log out.

## Design Review Decisions


| Dimension                | Score (0-10) | Decision                                                                                                             |
| ------------------------ | ------------ | -------------------------------------------------------------------------------------------------------------------- |
| Information Architecture | 8            | Flat nav is correct for 3 views + drill-down. No deeper nesting needed.                                              |
| Interaction States       | 7 → 9        | Plan covers all states. Implementation must follow the state matrix exactly.                                         |
| Visual Hierarchy         | 7            | Headings use Playfair Display (DESIGN.md restricts to brand mark only). **Fix:** Use Inter 600 for section headings. |
| Responsive               | 6 → 8        | Plan defines breakpoints. Implementation must test all three tiers.                                                  |
| Accessibility            | 7            | Focus rings, keyboard nav, ARIA landmarks defined. Confirm dialogs must trap focus.                                  |
| Motion                   | 8            | Minimal-functional per DESIGN.md. Toast uses slide-in, 200ms ease-out.                                               |
| Component Consistency    | 7 → 9        | New ConfirmDialog and Toast components use DESIGN.md tokens. Empty states follow pattern.                            |


### Resolved Design Questions

1. **Queue semantics:** Attention Queue filters by `ATTENTION_STATES` (client-side). This is correct for V2. Server-side attention scoring is deferred.
2. **SMS vs AI composer:** Keep dual-button layout. Add a subtle label above the composer: "Messages sent via AI are processed by Oline. SMS goes directly to the tenant's phone." This resolves the product risk of PMs not knowing which channel the tenant sees.
3. **Dual scores on queue rows:** Show `preliminary_score` by default. If `latest_score` exists, show it in a second column or replace preliminary. Decision: show both when both exist (two columns: "Form" and "Conv.").
4. **"Score Now" button:** Place below the Conv. Score field in the sidebar. Disabled when scoring is in progress. Shows spinner.
5. **Confirm dialogs:** Use a shared `ConfirmDialog` component. Destructive actions (takeover) use red confirm button. Non-destructive (push to pipeline) use accent (gold) confirm button.
6. **Headings font:** DESIGN.md says Playfair Display for brand mark only. Current CSS applies it to all h1/h2/h3. **Fix in implementation:** Remove `font-family: "Playfair Display"` from h1/h2/h3 rule; apply only to `.brand-badge` and `.brand-title`.

## Component Changes Summary


| Component                | Change                                                                                                                                                      |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Dashboard.jsx`          | Add mobile hamburger toggle for sidebar. Session expiry toast.                                                                                              |
| `AttentionQueue.jsx`     | Conversation score column. Empty state. Stale-data indicator. "Updated ago" header. Card layout for mobile.                                                 |
| `FilteredLeads.jsx`      | Clickable rows. In-app confirm dialog. Phone column. Empty state. Card layout for mobile.                                                                   |
| `AllConversations.jsx`   | Empty state. Card layout for mobile.                                                                                                                        |
| `ConversationView.jsx`   | In-app confirm dialogs. Empty thread state. "Score Now" button. Channel label on composer. Collapsible sidebar for mobile. "Last updated" in thread header. |
| `FlowBadge.jsx`          | No change needed.                                                                                                                                           |
| `styles.css`             | Mobile breakpoints (@media queries). Confirm dialog styles. Empty state styles. Toast styles. Stale indicator.                                              |
| `server.js`              | Inbound SMS auth hardening. Health endpoint expansion.                                                                                                      |
| New: `ConfirmDialog.jsx` | Shared in-app confirm modal component.                                                                                                                      |
| New: `Toast.jsx`         | Session expired toast component.                                                                                                                            |


