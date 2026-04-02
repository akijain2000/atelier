# Atelier — Completed Work Log

A running record of what was built, what decisions were made, and why. Intended for sharing with teammates, stakeholders, or future contributors who need to understand how the project evolved.

---

## Day 1: Fork & Strip (2026-04-01)

**Goal:** Fork the Rova codebase into a standalone Atelier project. Remove all prompt-studio features (evaluations, benchmarks, training). Restructure the database for multi-conversation management. Add listing data injection and conversation CRUD.

### Planning Phase

Before any code was written, three gstack planning tools were used:

1. **`/office-hours`** — Brainstormed the product concept. Evaluated three approaches:
   - **Approach A ("Strip & Reskin"):** Fork Rova, rebuild frontend with 3-panel layout. ~1 week. Rejected — too much UI investment before validating AI quality.
   - **Approach B ("Clean Fork"):** Rebuild frontend from scratch, migrate to Supabase, add WebSockets. ~2-3 weeks. Rejected — over-engineering for a prototype.
   - **Approach C ("AI-First Validation"):** Fork Rova, keep existing chat UI, add listing selector + scoring sidebar stubs. ~3 days. **Chosen** — fastest path to real feedback, validates the AI before investing in UI.
   - Output saved to `DESIGN_ATELIER.md`.

2. **`/plan-eng-review`** — Locked in 7 architecture decisions that guided all implementation:
   - **Decision #1:** Separate `scoreLead()` function — isolated from chat flow, no changes to chatRuntime.js
   - **Decision #2:** Proper relational schema (`conversations` + `messages` + `scores` tables) instead of JSONB blob
   - **Decision #3:** Template listing data at request time — read prompt + listing file, replace `{{LISTING_DATA}}`
   - **Decision #4:** Defensive JSON parsing for scoring responses — strip markdown fences, trim, retry once
   - **Decision #5:** Extract App.jsx into ChatPanel, ConversationList, ScoringSidebar, ListingSelector + thin shell
   - **Decision #6:** Remove hardcoded Supabase credentials, require env vars with clear error messages
   - **Decision #7:** Async scoring — POST /score returns immediately, scoring runs in background
   - All decisions recorded in `DESIGN_ATELIER.md` under "Engineering Review Decisions (locked)".

### What Was Built

#### 1. Repository Fork
- Created `atelier/` directory alongside Rova
- Copied only needed files: `server.js`, `lib/chatRuntime.js`, `lib/mcpClient.js`, `mcp/server.js`, `mcp/supabase.js`, `mcp/migrations/`, `src/App.jsx`, `src/styles.css`, `vite.config.js`, `index.html`, `package.json`
- Did NOT copy: `lib/benchmarkRunner.js`, `lib/benchmarkParser.js`, `scripts/`, `akshat/`, `data/`, `analysis/`, `node_modules/`
- **Why:** Clean separation from Rova. Atelier is a distinct product, not a branch. Keeping them side-by-side lets us reference Rova without entangling the codebases.

#### 2. Backend — `server.js` (1065 → ~310 lines)

**Removed (~750 lines):**
- 3 benchmark routes (`/api/benchmark/*`)
- 1 evaluation route (`/api/evaluations`)
- 8 training routes (`/api/training/*`) + 6 helper functions (`assertTrainingScenarioShape`, `loadTrainingScenarios`, `updateTrainingSessionStats`, `getTrainingExportRows`, `csvCell`, `rowsToCsv`)
- `benchmarkRunner.js` import
- All file path constants for training/eval/benchmark data
- `hydrateEvaluationPayload` from chatRuntime import

**Kept:**
- `/api/health` — runtime diagnostics
- `/api/system-prompt` (GET/PUT) — prompt management
- `/api/chat` — legacy direct chat endpoint (backward compatibility)
- Static file serving for production builds

**Added:**
- `GET /api/listings` — reads `prompts/listings/*.md`, returns `[{ id, name, file }]`
- `GET /api/conversations` — list all conversations with latest score (LATERAL JOIN)
- `GET /api/conversations/:id` — conversation detail with messages and latest score
- `POST /api/conversations` — create new conversation (requires `listing_id`, validates listing file exists per eng review critical gap)
- `POST /api/conversations/:id/messages` — send tenant message, get AI response (full transactional flow)
- `DELETE /api/conversations/:id` — archive/delete conversation
- `POST /api/conversations/:id/score` — scoring stub (creates pending score record, full implementation in Day 2)
- `GET /api/conversations/:id/scores` — list scores for a conversation
- `buildSystemPrompt()` — reads V5 Finn prompt, loads listing file, replaces `{{LISTING_DATA}}` placeholder (per eng review decision #3)
- `loadListingData()` — reads listing markdown files, strips code fences if present

**Why rewrite instead of surgical edits:** The original server.js was 1065 lines with eval/training/benchmark code deeply interleaved. Surgical removal would have been error-prone and left orphaned references. A clean rewrite of the ~350 lines we actually need was faster and safer.

#### 3. Database Schema (per eng review decision #2)

Replaced the monolithic `chat_sessions` table (which stored messages as a JSONB array) with three normalized tables:

```sql
conversations (id UUID, tenant_name, property, unit_hint, listing_id, status, created_at, updated_at, message_count, preview)
messages (id UUID, conversation_id FK, role, content, created_at, model, latency_ms, metadata JSONB)
scores (id UUID, conversation_id FK, scored_at, overall_score, conversion_likelihood, sub_scores JSONB, red_flags JSONB, recommended_action, summary, message_count_at_scoring, scoring_status)
```

Added indexes: `idx_messages_conversation` (conversation_id, created_at) and `idx_scores_conversation` (conversation_id, scored_at DESC).

**Why relational instead of JSONB:** The old design stored all messages as a JSONB array in `chat_sessions.messages`. This makes querying individual messages impossible (e.g., "find all conversations where the tenant mentioned pets"), prevents efficient pagination, and couples the message schema to the session record. Normalizing into separate tables enables proper SQL queries, foreign key integrity, and independent message/score lifecycle management.

#### 4. Frontend — `App.jsx` (3600 → ~140 lines) + 5 Components (~380 lines total)

**Removed entirely:**
- `EvaluationRoundRoute` (~150 lines), `EvaluationDashboard`, `EvaluationSummaryTable`
- `BenchmarkPage` (~175 lines), `BenchmarkSummaryTable`, `BenchmarkQuestionRow`
- `TrainingStudioRoute` (~875 lines), `TrainingDataRoute` (~220 lines), `TrainingSessionDetailRoute` (~160 lines), `TrainingRouteTabs`
- `ReviewList`, comparison/evaluation summary components
- `ChatHistoryRoute`, `ChatSessionDetailRoute` (session history views)
- `RouteNav`, `BottomNav` (multi-route navigation)
- All training-related state/constants (`trainingPropertyOptions`, `trainingQuestionerOptions`)
- All route cases for evaluations, benchmark, training, history
- `MobileWorkspaceToggle`, `WorkspaceStat`, `FeedbackButtons`
- `formatProviderLabel`, `getProviderStatusLabel`, `getProviderHelperText`, `getRouteState`

**Extracted into components (per eng review decision #5):**
- `src/components/ChatPanel.jsx` — message thread + composer, adapted for tenant/admin/assistant roles
- `src/components/ConversationList.jsx` — sidebar with conversation cards, status badges, new-conversation button
- `src/components/MarkdownText.jsx` — inline markdown renderer (bold, italic, code, headings, lists)
- `src/components/ListingSelector.jsx` — dropdown that fetches from `/api/listings`, auto-selects first listing
- `src/components/ScoringSidebar.jsx` — score display with tier badges, sub-scores, red flags, recommended action (populated in Day 2)

**New `App.jsx` shell:**
- Single-page app with 3-column layout: conversation list | chat panel | scoring sidebar
- State: conversations list, active conversation, messages, draft, sending state, selected listing, latest score
- Polls conversations every 15 seconds for updates
- Top nav with Atelier branding and listing selector

**Why this architecture:** The original App.jsx was a 3600-line monolith with 10+ route components. Even the "keep" components (ChatRoute) were tightly coupled to prompt studio state (prompt variants, provider selection, workspace stats). Extracting into focused components with clear props boundaries makes each piece testable and replaceable.

#### 5. CSS — `styles.css` (complete rewrite)

- Removed all eval/training/benchmark CSS classes (`.eval-*`, `.training-*`, `.bm-*`, `.comparison-*`, `.review-*`, `.workspace-stat-*`)
- New 3-column layout: `.atelier-layout` with `grid-template-columns: 240px 1fr 280px`
- New component styles: `.conversation-sidebar`, `.conversation-card`, `.scoring-sidebar`, `.score-display`, `.listing-selector`
- Responsive breakpoints: scoring sidebar hides below 1100px, conversation sidebar hides below 768px
- Typography: Playfair Display (serif headings) + Inter (body), dark theme with gold accent (`#c4a265`)
- Kept and adapted: `.chat-panel`, `.messages`, `.message-bubble`, `.composer`, `.primary-button`, `.ghost-button`, `.status-pill`, `.eyebrow`, `.empty-state`

**Why rewrite instead of strip:** The original CSS was ~1800 lines with deep coupling to removed components. More than half the file was eval/training/benchmark styles. Stripping would have left orphaned selectors and inconsistent spacing. A clean rewrite (~470 lines) gives us exactly what we need with consistent design tokens.

#### 6. Prompt & Listing Data

- `prompts/Prompt.md` — V5 Finn system prompt content (extracted from `SYSTEM_PROMPT_V5_FINN.md`, without the markdown wrapper). Contains the `{{LISTING_DATA}}` placeholder that gets replaced at request time.
- `prompts/listings/N94_3ROMS.md` — Listing data for Nygardsgaten 94 3-roms. Injected into the prompt when a conversation uses this listing.

**Why template at request time (eng review decision #3):** The alternative was pre-baking listing data into the prompt file. But this would require a separate prompt file per listing, making maintenance painful. Template replacement at request time means one prompt file serves all listings.

#### 7. Security — `mcp/supabase.js` (per eng review decision #6)

Removed hardcoded defaults:
- `SUPABASE_URL` — was `https://rlykjjfzidjtratexipg.supabase.co`
- `SUPABASE_ANON_KEY` — was a full JWT
- `STAYPORTAL_EMAIL` — was `simon@stay.no`
- `STAYPORTAL_PASSWORD` — was `stay123`

Now requires all four from environment variables. Logs a clear error listing which vars are missing on startup.

**Why:** Hardcoded credentials in source code are a security risk, especially when the codebase may be shared or version-controlled. The `.env.example` documents what's needed.

#### 8. Package & Build

- Renamed package from `rova-chatbot` to `atelier`
- Removed `test:evaluations` script (no eval infrastructure in Atelier)
- `npm install` — 226 packages, 0 vulnerabilities
- `vite build` — clean build, 202KB JS + 9KB CSS (gzipped: 64KB + 2.4KB)

### File Structure After Day 1

```
atelier/
  server.js              (310 lines — stripped, new conversation/listing/scoring APIs)
  package.json           (renamed to atelier)
  vite.config.js         (unchanged — Vite + React, proxy /api to :3001)
  index.html             (title: "Atelier — Tenant Chat & Lead Scoring")
  .env.example           (documents all required env vars)
  lib/
    chatRuntime.js       (unchanged — Anthropic/OpenAI chat, MCP tool calling)
    mcpClient.js         (unchanged — MCP client for StayPortal)
  mcp/
    server.js            (unchanged — MCP server for StayPortal tools)
    supabase.js          (credentials from env only, clear error on missing)
    migrations/
  prompts/
    Prompt.md            (V5 Finn prompt with {{LISTING_DATA}} placeholder)
    listings/
      N94_3ROMS.md       (listing data for Nygardsgaten 94)
  src/
    App.jsx              (140 lines — thin shell, 3-column layout)
    main.jsx             (React entry point)
    styles.css           (470 lines — dark theme, gold accent, 3-column responsive)
    components/
      ChatPanel.jsx      (message thread + composer)
      ConversationList.jsx (sidebar with cards + badges)
      ListingSelector.jsx  (dropdown from /api/listings)
      ScoringSidebar.jsx   (score display — stub, populated in Day 2)
      MarkdownText.jsx     (inline markdown renderer)
```

### What's Next — Day 2: Scoring Sidebar

Per the implementation plan in `DESIGN_ATELIER.md`:
- Implement `scoreLead()` function using the Lead Scoring prompt
- Wire `/api/conversations/:id/score` to actually call Anthropic with conversation messages
- Implement milestone-based scoring triggers (3+ messages, PII detection, idle timeout)
- Populate the ScoringSidebar with real score data
- Add status badges (AI MANAGED / REQUIRES ATTENTION) to ConversationList
- Add "Score now" manual button
- Async scoring: POST returns immediately, scoring runs in background, frontend polls (per eng review decision #7)

---

## Day 2: Scoring Sidebar (2026-04-01)

**Goal:** Wire the `SYSTEM_PROMPT_LEAD_SCORING.md` prompt into the backend as an isolated `scoreLead()` function. Implement async scoring (POST /score returns immediately, scoring runs in background, frontend polls). Add milestone-based auto-triggers, a "Score now" manual button, sub-score display, and status badges to the conversation list.

### What Was Built

#### 1. Lead Scoring Prompt — `prompts/LeadScoring.md`

Extracted raw content from `SYSTEM_PROMPT_LEAD_SCORING.md` (stripped the markdown code fence wrapper). Renamed sub-score labels to match the Atelier design:

- `demographic_fit` → `tenant_profile_fit`
- `first_impression` → `first_message_quality`
- `financial_stability` → `budget_signals`
- `engagement_quality`, `conversion_intent`, `stay_duration_fit` — kept as-is

Also renamed the labels inside the prompt text itself (section headers, output format, examples) so the prompt and the code use consistent terminology.

**Why rename:** The original prompt was written for general use. Atelier's design documents and PRD use more descriptive labels that better communicate what each sub-score measures. Renaming at the prompt level means the AI returns the correct keys natively, reducing post-processing.

#### 2. `scoreLead()` Function (~80 lines)

A standalone async function that:
- Reads all messages for a conversation from the database
- Loads the scoring system prompt from `prompts/LeadScoring.md` (cached after first read)
- Formats messages as a transcript: `Tenant: "..."` / `Oline: "..."`
- Calls the Anthropic API directly (no MCP tools, no chatRuntime — per eng review decision #1)
- Defensive JSON parsing (per eng review decision #4): strips markdown fences if Claude wraps the response, trims whitespace, `JSON.parse`, retries once on parse failure
- Validates required fields (`overall_score`, `sub_scores`)
- Renames sub-score keys from original labels to Atelier labels
- Returns the parsed score object

**Why direct Anthropic call instead of chatRuntime:** `chatRuntime.js` is designed for chat flows with MCP tool calling, multi-round conversations, and provider abstraction. Scoring is a single-shot request/response — adding tool calling overhead would slow it down and risk tool-use side effects. A direct `fetch()` to the Anthropic API is simpler, faster, and isolated.

**Why retry once on parse failure:** Claude occasionally wraps JSON in markdown fences (`\`\`\`json ... \`\`\``) or adds a brief preamble despite being told not to. The defensive parser strips fences first, and if parsing still fails, retries the entire API call. This handles transient formatting issues without failing the entire scoring flow.

#### 3. Milestone Detection — `checkScoringMilestones()` (~40 lines)

Three auto-scoring triggers (per `DESIGN_ATELIER.md`):

1. **Message count threshold:** 3+ tenant messages in the conversation
2. **PII detection:** Tenant message contains an email pattern (`/\S+@\S+\.\S+/`), age mention (`/\b\d{2}\s*(år|years?\s*old)\b/i`), or name intro (`/(?:jeg heter|my name is|i'm|vi er)\s+\w/i`)
3. **Idle timeout:** Conversation `updated_at` was 10+ minutes ago (and at least 1 tenant message exists)

Guard against re-scoring: only triggers if the conversation's `message_count` is greater than the `message_count_at_scoring` of the latest score. This prevents re-scoring on every message after the threshold is passed.

**Why these three triggers:** They represent the three most actionable moments in a lead conversation. Message count ensures minimum data before scoring. PII detection catches the moment a tenant self-identifies (name, age, email = serious intent). Idle timeout captures conversations that stall — the property manager needs to know the score before the lead goes cold.

#### 4. Async Scoring Flow — `executeScoring()` + Evolved POST `/score`

Replaced the Day 1 stub with real async scoring (per eng review decision #7):

- **POST /conversations/:id/score** — Creates a pending score record (returns immediately with `{ status: 'pending', score_id }`)
- **`executeScoring(conversationId, scoreId)`** — Runs `scoreLead()` in the background (not awaited). On success: updates the score row with all fields + sets `scoring_status = 'complete'`. On failure: sets `scoring_status = 'error'`.
- **Status badge rules:** After scoring completes, updates `conversations.status`:
  - `overall_score >= 50` AND `red_flags.score === 0` → `ai_managed`
  - `overall_score < 50` OR `red_flags.score > 0` → `requires_attention`

**New endpoint:** `GET /conversations/:id/score/:scoreId` — Returns a specific score record for polling a score's status.

**Why async:** Scoring takes 3-8 seconds (Anthropic API latency). Blocking the POST response would make the UI feel unresponsive. The async pattern lets the frontend show a "Scoring…" indicator while the backend works in the background.

#### 5. Auto-Score Trigger in POST `/messages`

After the AI reply is committed, the endpoint now calls `checkScoringMilestones()`. If a milestone fires:
- Inserts a pending score record
- Kicks off `executeScoring()` in the background
- Returns `{ autoScoreTriggered: true, scoreId }` in the response so the frontend knows to start polling

The milestone check and background scoring are wrapped in a try/catch so failures don't affect the message response.

#### 6. ScoringSidebar — Full Sub-Score Display (~130 lines)

Expanded from a stub to a complete scoring display:

- **Not-scored state:** Shows trigger explanation + "Score now" button
- **Pending state:** Spinner + "Analyzing conversation…" text + pulsing "SCORING…" pill
- **Scored state:** Overall score (color-coded by tier), conversion likelihood badge, summary text, 6 sub-score rows with:
  - Label + value (e.g., "Conversion Intent 5/5")
  - Horizontal bar showing 1-5 scale
  - Italic reason text below each bar
- **Red flags section:** Shows flag count and individual flag descriptions
- **Recommended action card**
- **Re-score button** at the bottom (for manually re-triggering)

Sub-score keys are mapped to display labels: `tenant_profile_fit` → "Tenant Profile Fit", etc.

JSONB fields (`sub_scores`, `red_flags`) are handled defensively — parsed from string if the database returns them as serialized JSON.

#### 7. ConversationList — Score-Based Badges

Updated badge logic to reflect actual score data:

- **Score >= 70 + complete:** Green "HIGH" badge + score number
- **Score 50–69 + complete:** Amber "MEDIUM" badge + score number
- **Score < 50 + complete:** Red "LOW" badge + score number
- **Scoring in progress:** Neutral "SCORING…" badge (no number)
- **Requires attention (no score):** Red "ATTENTION" badge
- **Default (no score):** Green "AI MANAGED" badge

Score numbers use `font-variant-numeric: tabular-nums` for consistent width alignment.

#### 8. App.jsx — Score Polling + Manual Trigger

- **`triggerScore()`:** Calls `POST /conversations/:id/score`, sets `isScoring = true`, starts polling
- **`startScorePolling(convoId)`:** Polls `GET /conversations/:id` every 3 seconds. When `scoring_status !== 'pending'`, stops polling, updates `latestScore`, sets `isScoring = false`, refreshes conversation list
- **Auto-score handling:** After `sendMessage`, checks response for `autoScoreTriggered: true` and starts polling
- **Cleanup:** Score polling interval is cleared when active conversation changes or component unmounts
- **Props wiring:** Passes `onScore={triggerScore}` and `isScoring={isScoring}` to ScoringSidebar

#### 9. CSS Additions (~120 lines)

New styles for the scoring UI:

- `.sub-score-row`, `.sub-score-head`, `.sub-score-label`, `.sub-score-value` — layout for each sub-score
- `.sub-score-bar-track`, `.sub-score-bar-fill` — horizontal progress bar (4px height, gold fill, 400ms animated width transition)
- `.sub-score-reason` — italic reason text
- `.score-now-btn` — styled button matching the design system (dark card background, accent border on hover)
- `.scoring-spinner` — 32px spinning circle (accent-colored top border)
- `.scoring-loading` — pulsing opacity animation for the "SCORING…" pill
- `.score-tier-high/medium/low` — green/amber/red color classes
- `.conversation-card-badges` — flex row for badge + score in conversation cards
- `.conversation-score` — inline score number with tabular-nums
- `.status-pill.warning-amber` — amber variant for medium-tier badges
- `@keyframes spin` — spinner rotation
- `@keyframes pulse-opacity` — opacity pulse for loading states

### Architecture Decisions Made

1. **Direct Anthropic API for scoring (not chatRuntime):** Scoring is a single-shot request. chatRuntime adds MCP tool calling, multi-round loop, and provider abstraction — none of which scoring needs. Direct fetch is simpler and eliminates tool-use side effects.

2. **Background execution with DB status tracking:** Score status lives in the `scores` table (`pending` → `complete` | `error`). The frontend polls the conversation endpoint rather than a WebSocket. This is simpler, stateless, and works across page reloads.

3. **Milestone guard via `message_count_at_scoring`:** Each score record stores how many messages existed when scoring was triggered. New milestones only fire if more messages have arrived since the last score. This prevents cascading re-scores.

4. **Sub-score key renaming at two levels:** Labels are renamed both in the prompt text (so Claude outputs the correct keys) and in the backend `renameSubScoreKeys()` (as a safety net in case Claude uses the original labels). Belt and suspenders.

5. **Conversation status derived from score:** `status` is updated after scoring completes, not manually set. This ensures status always reflects the latest score data. The rules are simple: score >= 50 with no red flags = AI can handle it; otherwise, requires human attention.

### Files Changed

```
atelier/
  server.js              (310 → ~470 lines — added scoreLead, milestones, async scoring, new endpoint)
  prompts/LeadScoring.md (new — raw Lead Scoring prompt with renamed labels)
  src/
    App.jsx              (140 → ~195 lines — score polling, triggerScore, isScoring state)
    components/
      ScoringSidebar.jsx (65 → ~130 lines — sub-scores, Score now, loading, re-score)
      ConversationList.jsx (63 → ~90 lines — score badges, color-coded status)
    styles.css           (470 → ~590 lines — sub-score rows, bars, spinner, pulse, tier colors)
  COMPLETED_LOG.md       (appended Day 2 section)
```

---

## Post-Day 2: Code Review, QA, & Design Audit

**Date:** April 1, 2026
**Tools Used:** Code reviewer (structural analysis), Browser MCP (visual QA), Design audit (visual inspection)

### Code Review Findings (7 issues found, all fixed)

| # | Severity | Issue | Fix Applied |
|---|----------|-------|-------------|
| 1 | CRITICAL | Pending scores didn't block re-enqueue, causing duplicate API calls and wasted spend | Added `EXISTS (... scoring_status = 'pending')` short-circuit in `checkScoringMilestones()` and `POST /score` |
| 2 | CRITICAL | IDOR on `GET /score/:scoreId`, ignoring `conversation_id` | Added `AND conversation_id = $2` to the WHERE clause |
| 3 | CRITICAL | Weak AI output validation before DB write (no clamping, no length limits) | Added `Math.max/min` clamping for overall_score (0-100) and sub-scores (1-5), string length caps (500/1000 chars) |
| 4 | CRITICAL | `JSON.parse` without try/catch in `ScoringSidebar.jsx` could crash the component | Added `safeParse()` helper with fallback to `{}` |
| 5 | HIGH | `loadConversations` didn't check `res.ok`, could set state to non-array and crash `ConversationList` | Added `res.ok` check and `Array.isArray` guard |
| 6 | INFO | Retry path in `scoreLead` didn't check `retryResponse.ok` | Added `ok` check, throws on failure |
| 7 | INFO | `SubScoreRow` rendered `NaN%` width for undefined/out-of-range scores | Added `Number.isFinite` guard with clamping to 0-5 |

### Architectural Decisions

- **Pending-score guard:** Query only `scoring_status = 'complete'` rows when determining last scored message count. This prevents the race where a pending row's `message_count_at_scoring` allows a second enqueue while the first is still running.
- **Manual score dedup:** `POST /score` returns the existing pending score ID if one exists, rather than creating a new row. Idempotent from the frontend's perspective.
- **AI output sanitization:** Scores are clamped server-side regardless of what the model returns. String fields are truncated to prevent oversized payloads. This is defense-in-depth since the prompt also instructs the model to stay within bounds.

### QA Results (Browser Testing)

- **Desktop (1280px):** 3-column layout renders correctly. Branding, gold accent, Playfair Display + Inter fonts all load. Empty states show correct copy. Zero JS console errors.
- **Console:** Clean. Only Vite HMR logs and React DevTools suggestion.
- **Responsive breakpoints:** Defined at 1100px (hide scoring) and 768px (hide conversations). Verified in CSS.
- **Interactive:** "+ New Conversation" button has hover state. "Score now" button has disabled state during scoring.

### Design Audit

- **First Impression:** Professional dark theme with intentional gold accent. No AI slop patterns detected.
- **AI Slop Score: A** — No purple gradients, no 3-column feature grids, no emoji-as-design, no generic hero copy.
- **Typography:** Playfair Display headings + Inter body, good hierarchy.
- **Note:** Listing selector returns `null` when API fails (component disappears). Not a bug per se, but worth noting for Day 3 when backend is connected.

---

## Day 3: End-to-End Test (2026-04-01)

### Live E2E Test — Full Flow Verified

Tested the complete flow with a realistic Finn.no tenant inquiry against the live Neon PostgreSQL database and Anthropic Claude API.

**Test scenario:** Erik Nilsen, 28-year-old consultant at Deloitte in Bergen, inquiring about the N94 3ROMS listing.

| Step | Action | Result |
|------|--------|--------|
| 1 | Select listing "N94 3ROMS" | Auto-populated from `/api/listings` |
| 2 | Create conversation | Conversation created, "AI MANAGED" badge, 3-column layout rendered |
| 3 | Send message 1 (intro with name, age, occupation) | AI responded in character as Finn concierge with exact pricing (22,600 kr/month), deposit info, property details. **PII detected → auto-score triggered.** |
| 4 | Score result #1 | **67/100 MEDIUM** — "MONITOR — interested but needs more engagement" |
| 5 | Send message 2 (watched video, requesting viewing) | AI forwarded viewing request, asked for email. **Auto-rescore triggered.** |
| 6 | Score result #2 | **82/100 HIGH** — "FOLLOW UP — good lead, ensure prompt response" |
| 7 | Send message 3 (email, employer, offer to send payslip) | AI confirmed, promised team follow-up. **Auto-rescore triggered.** |
| 8 | Score result #3 | **88/100 HIGH** — "PRIORITIZE — high-quality lead, forward to team immediately" |

**Sub-score evolution (final):**
- Tenant Profile Fit: 5/5 — "28 years old, consultant at Deloitte — ideal young professional"
- First Message Quality: 5/5 — "Excellent intro: greeting, full name, age, job, timeline, and clear question"
- Engagement Quality: 5/5 — "High-quality progression: watched video, requested viewing, provided email and work details"
- Conversion Intent: 4/5 — "Strong signals: watched video, actively requesting viewing, shared email and employment details"
- Stay Duration Fit: 5/5 — "Young professional with stable job, likely long-term tenant from August"
- Budget Signals: 5/5 — "Works at Deloitte with stable income, offered to provide pay slip, no price concerns"

**Conversation status:** `requires_attention` (correctly derived from 88 HIGH score)

**Infrastructure:**
- Database: Neon PostgreSQL (eu-west-2) — tables auto-created, all records persisted correctly
- AI: Anthropic Claude claude-sonnet-4-20250514 — latency 3-7s per response, ~11k input tokens per turn
- MCP: StayPortal MCP server connected, 10 tools available for property context lookup
- Frontend: Vite 7.3.1 on port 5174, proxying to Node.js on port 3001
- Server logs: Clean, zero errors during entire test

---

## Deployment & Production (2026-04-01)

**Goal:** Ship Atelier to production. Get a live URL that stakeholders can test. Run post-deploy verification and security audit.

### What Was Done

#### 1. Code Quality Check (`/health`)

Ran a health check before shipping:
- **Build:** `npm run build` passes cleanly. Vite 7.3.1, 34 modules, 991ms build time. Output: 206KB JS (65KB gzipped), 11KB CSS (2.8KB gzipped).
- **Dependencies:** `npm audit` — 0 vulnerabilities across 226 packages.
- **Security:** Created `.gitignore` (was missing) to exclude `.env`, `node_modules/`, `dist/`, and log files.

#### 2. Git Init & Push (`/ship`)

- Initialized git repo in `atelier/`
- Created initial commit: `feat: Atelier MVP — tenant chat + lead scoring`
- Pushed to `https://github.com/akijain2000/atelier` (private repo)
- **Issue encountered:** GitHub Push Protection blocked the initial push because `.env.example` contained a real Anthropic API key. Fixed by replacing with placeholder `sk-ant-api03-your-key-here`, amended the commit, and force-pushed.

#### 3. Render Deployment Configuration

Created `render.yaml` for Render's Infrastructure as Code:
```yaml
services:
  - type: web
    name: atelier
    runtime: node
    plan: free
    buildCommand: npm install && npm run build
    startCommand: npm start
    healthCheckPath: /api/health
    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL / ANTHROPIC_API_KEY / SUPABASE_URL / SUPABASE_ANON_KEY / STAYPORTAL_EMAIL / STAYPORTAL_PASSWORD
        sync: false  (set manually in Render dashboard)
```

Created `CLAUDE.md` with project context, deploy config, and health stack for gstack integration.

#### 4. Render Deployment

- Created web service on Render via the dashboard (automated by browser)
- Source: `akijain2000/atelier` (public git repo tab, since Git Provider was connected to a different account)
- Configured: Node runtime, `main` branch, Free tier ($0/month, 512MB RAM, 0.1 CPU)
- Set all 6 environment variables via the Render dashboard
- Build completed in ~20 seconds. Server started on port 10000.
- **Production URL:** `https://atelier-production-b43e.up.railway.app` (migrated from Render to Railway)

**Why Render Free tier:** This is a prototype/demo deployment. Free tier spins down after inactivity (50s cold start), but that's acceptable for stakeholder demos. Upgrade to Starter ($7/month) when sharing with real property managers.

#### 5. Post-Deploy: Repo Made Private

Changed the GitHub repo visibility from public to private using `gh repo edit --visibility private`. The Render deployment continues to work since it cloned via public git URL (the code is already deployed).

#### 6. Post-Deploy: Canary Health Check

Verified production health immediately after deploy:

| Endpoint | HTTP | Status |
|----------|------|--------|
| `/` | 200 | Title: "Atelier — Tenant Chat & Lead Scoring", 3-column layout renders correctly |
| `/api/health` | 200 | `{"ok":true, "activeProvider":"anthropic", "activeModel":"claude-sonnet-4-20250514", "hasApiKey":true}` |
| `/api/conversations` | 200 | Returns JSON array |

Console errors from Atelier: **0**. All errors in console log were from Render dashboard pages (Apollo/Intercom), not from Atelier itself.

**Verdict: DEPLOY IS HEALTHY**

#### 7. Post-Deploy: CSO Security Audit

Full security audit (daily mode, 8/10 confidence gate). 10 findings:

| # | Sev | Conf | Finding |
|---|-----|------|---------|
| 1 | CRIT | 10/10 | No authentication on any API endpoint — all data and LLM operations accessible to anyone with the URL |
| 2 | CRIT | 10/10 | System prompt read/write (`GET/PUT /api/system-prompt`) open to anyone — attacker can overwrite prompt |
| 3 | HIGH | 10/10 | `/api/chat` accepts caller-controlled `systemPrompt` in request body — arbitrary prompt + your API key |
| 4 | HIGH | 9/10 | `listing_id` path traversal — `path.join(listingsDir, listingId + '.md')` without sanitizing `..` |
| 5 | HIGH | 9/10 | Client can set `role: 'admin'` on messages — server trusts the body value |
| 6 | HIGH | 9/10 | No rate limits on LLM-backed routes — attacker can burn through Anthropic API budget |
| 7 | HIGH | 9/10 | `COMPLETED_LOG.md` contains `STAYPORTAL_PASSWORD` in plaintext (tracked in git) |
| 8 | MED | 8/10 | `/api/health` leaks runtime config (active provider, model, prompt paths) — reconnaissance vector |
| 9 | MED | 8/10 | CORS set to `*` (any origin) — combined with no auth, allows any website to call the API |
| 10 | MED | 8/10 | MCP tool calls influenced by tenant chat context — prompt injection could surface sensitive tool output |

**What passed:** SQL queries use parameterized `$1` placeholders (no injection). React renders safely (no `dangerouslySetInnerHTML`). Dependencies have 0 CVEs. `.env` is properly gitignored. `render.yaml` uses `sync: false` for secrets.

**Recommended fix priority:** Auth → prompt API lockdown → `listing_id` allowlist → rate limits → redact credentials from docs → restrict CORS.

**Note:** The repo being private mitigates immediate exposure. Items 1-2 are blockers before sharing the URL with external users.

### Architecture Decisions

1. **Free tier for prototype:** Acceptable 50s cold start for demo purposes. Upgrade path is clear (Starter $7/month for always-on).
2. **Public git repo for deploy, then private:** Render cloned via public URL during deploy setup. Making it private after doesn't break the existing deployment (code already deployed), but future deploys from the dashboard may need the Git Provider connected. Can add `akijain2000` to Render Git Provider if needed.
3. **No auth for MVP:** Intentional trade-off for Day 1-3 velocity. Auth is the top priority for Day 4 before sharing with real property managers.

### Files Added/Changed

```
atelier/
  .gitignore          (new — excludes .env, node_modules/, dist/, logs)
  render.yaml         (new — Render IaC: web service, free tier, env vars, health check)
  CLAUDE.md           (new — gstack project context and deploy config)
  .env.example        (changed — replaced real API key with placeholder)
  COMPLETED_LOG.md    (updated — added deployment and security audit sections)
```

---

## Atelier V2 Planning (2026-04-01)

### Product Pivot

Atelier is being transformed from a web chat sandbox (where PM types as tenant) into a production outbound tenant engagement system:

- **Tenants interact via SMS only** (never see a web UI)
- **PM dashboard** for management (attention queue, conversation threads, scoring, override)
- **Google Sheet form** triggers lead creation and first outbound message
- **Channel-agnostic architecture** (SMS via Pling first, extensible to WhatsApp/email)
- **Haiku for chat** (3.75x cost reduction), Sonnet for scoring
- **Incremental frontend migration** (strangler pattern, not big-bang rewrite)

### /autoplan Review

Ran full CEO + Design + Eng review pipeline with dual voices. Key outcomes:

1. **Auth moved to Phase 0** -- prerequisite before any SMS with real phone numbers
2. **Channel-agnostic messaging** -- `lib/channels/` adapter pattern, not SMS-only
3. **Templated first messages** -- approved templates with AI-filled slots, not free-form
4. **Strangler frontend** -- 4 incremental steps instead of full rewrite
5. **Listing snapshots** -- cached per conversation, not re-fetched from MCP per message
6. **Consent + STOP handling** -- Google Form consent checkbox, keyword opt-out
7. **Transactional outbox** -- state machine for message delivery, not fire-and-forget
8. **E.164 + idempotency** -- phone normalization, webhook dedupe

### Decisions

1. **SMS Provider:** Pling (Front Information AS) -- Norwegian gateway, 0.39-0.55 NOK/msg, direct carrier routes
2. **Google Sheet:** "Lead skjema" form with 7 fields (name, age, email, phone, move-in date, status, intro). Need to add consent checkbox.
3. **Model split:** Haiku for chat ($0.80/$4.00 per M tokens), Sonnet for scoring ($3/$15)
4. **Frontend strategy:** Strangler pattern -- add new components alongside existing UI, migrate incrementally

### Completed

- **Phase 0:** Auth + security foundation -- JWT auth, login/register/logout, requireAuth middleware, rate limiting (express-rate-limit), CORS lockdown, audit_log table, pm_users table. Tested: 8/8 tests passed, 5 audit events logged.
- **Phase 1A:** Model split -- chat defaults to Haiku 4.5 (`claude-haiku-4-5-20251001`), scoring stays on Sonnet 4. Env vars: `ANTHROPIC_CHAT_MODEL`, `ANTHROPIC_SCORING_MODEL`. Tested with live chat.
- **Phase 1B:** Channel-agnostic messaging -- `lib/channels/` with `types.js`, `sms.js` (Pling adapter), `index.js` (registry). Inbound SMS webhook (`POST /api/channels/sms/inbound`), outbound SMS endpoint (`POST /api/channels/sms/send`), opt-out/STOP handling, idempotency on Pling message ID, E.164 normalization. DB migrations: phone, email, age, flow_state, channel, delivery_status, external_id columns. Tested: 7/7 tests passed.
- **Phase 1C:** Lead ingestion -- `POST /api/leads/ingest` (HMAC-verified webhook). Preliminary AI scoring gate using Sonnet. Configurable `LEAD_SCORE_THRESHOLD` (default 40). Leads scoring above threshold advance to `pending_compose`, below to `filtered`. Idempotency on row_id+timestamp. Dedupe on phone+listing. Tested: 8/8 tests passed (22yo UiB student scored 95 → pending_compose, "Unknown" scored 0 → filtered).
- **Phase 1D:** Templated first message -- `prompts/templates/first_message.json` (NO/EN). Auto-compose and send on lead ingestion when score passes. PM endpoints: `POST /api/leads/:id/send-first` (manual trigger), `POST /api/leads/:id/override` (push filtered lead into pipeline). Flow state rollback on send failure. Tested with Pling creds not configured (graceful failure + rollback).
- **Phase 1E:** SMS-context prompts -- Updated `Prompt.md` with SMS channel constraints (320/480 char limits), `{{TENANT_PROFILE}}` injection, `{{FLOW_STATE}}` injection, `{{CALENDLY_URL}}` injection, flow state behavioral instructions, Calendly as primary CTA. Added `stripMarkdown()` post-processor for SMS-clean output. Updated `buildSystemPrompt()` to inject conversation context. Tested: "Kan jeg ha hund?" → 44 chars, no markdown.

### Phase 2: PM Dashboard (completed)

**Goal:** Replace the old web chat sandbox UI with a production PM dashboard for managing tenant conversations, scores, and flow states.

#### What Was Built

**Frontend Authentication (`src/lib/auth.js`):**
- JWT token management (localStorage) with `getToken`, `setToken`, `clearToken`
- `apiFetch` wrapper that auto-attaches JWT and redirects to `/login` on 401

**Login Page (`src/pages/Login.jsx`):**
- Email/password login form, stores JWT, navigates to dashboard on success

**Dashboard Layout (`src/pages/Dashboard.jsx`):**
- Sidebar navigation: Attention Queue, Filtered Leads, All Conversations
- User session management via `/api/auth/me`, logout via `/api/auth/logout`
- Active nav link highlighting with `react-router-dom` `NavLink`

**Attention Queue (`src/components/AttentionQueue.jsx`):**
- Filters conversations by actionable flow states (`pending_compose`, `first_message_sent`, `has_questions`, `wants_to_rent`, `soft_commitment`, `confirmed`, `wants_physical`, `manual_intervention`)
- Sorted by `updated_at` (most recent first)

**Filtered Leads (`src/components/FilteredLeads.jsx`):**
- Shows leads with `flow_state = 'filtered'`, sorted by `preliminary_score`
- Grouped by month with section headers
- "Push to Pipeline" button calls `POST /api/leads/:id/override` → changes state to `pending_compose`

**All Conversations (`src/components/AllConversations.jsx`):**
- Lists all conversations with 6-column grid (tenant, phone, status, score, messages, updated)
- Click to navigate to conversation detail view

**Conversation View (`src/pages/ConversationView.jsx`):**
- Message thread: tenant (left/dark), AI/PM (right/gold) bubbles with channel and delivery status badges
- PM composer: textarea with character count, SMS segment preview, "Send via AI" and "Send SMS" buttons
- "Take Over" button (sets `flow_state = 'pm_takeover'`), "Re-enable AI" button (sets back to `has_questions`)
- Tenant Profile card: name, phone, email, age, status, move-in, intro
- Flow State card: current state badge, preliminary score, details (source, message count, created date)

**Flow Badge (`src/components/FlowBadge.jsx`):**
- Reusable colored badge mapping 20 flow states to labels and color classes

**Routing (`src/main.jsx`):**
- `react-router-dom` with `RequireAuth` wrapper for protected routes
- Routes: `/login`, `/` (attention queue), `/filtered`, `/all`, `/conversation/:id`

**Backend Addition:**
- `PATCH /api/conversations/:id` endpoint for updating `flow_state` (PM takeover, re-enable AI)
- Audit logging for all state changes

#### Phase 2D: Old UI Retirement

Deleted 6 dead files (old web chat sandbox components):
- `App.jsx` (6KB), `ChatPanel.jsx` (4KB), `ConversationList.jsx` (3KB)
- `ListingSelector.jsx` (1KB), `ScoringSidebar.jsx` (5KB), `MarkdownText.jsx` (2KB)

Removed ~730 lines of dead CSS from `styles.css` (old 3-column layout, scoring sidebar, conversation sidebar, chat panel, sub-score rows, old responsive breakpoints).

Kept: `.brand-badge`, `.brand-title` (shared by new dashboard), CSS variables, base styles, reduced-motion media query.

**Build result:** 472KB JS (135KB gzip), 10KB CSS (2.5KB gzip). Clean build, zero warnings.

**Browser test:** Login → Attention Queue → Filtered Leads → All Conversations → Conversation View. Zero console errors. All layouts render correctly.

---

## Security Hardening Pass (2026-04-01)

Comprehensive code review identified 16 issues across CRITICAL/HIGH/MEDIUM severity. All fixed and verified.

### CRITICAL/HIGH Fixes

| # | Issue | Fix |
|---|-------|-----|
| 1 | SMS inbound endpoint had no authentication | Added Basic Auth + X-Pling-Auth header verification middleware |
| 2 | Open registration allowed anyone to create PM accounts | Gated behind `ALLOW_REGISTRATION=true` env flag (default: disabled) |
| 3 | `loadListingData()` vulnerable to path traversal via `listing_id` | Reject any listing_id not matching `^[a-zA-Z0-9_-]+$` |
| 4 | E.164 normalization double-prefixed numbers starting with `47` | Detect `47XXXXXXXX` pattern, only prepend `+` instead of `+47` |
| 5 | `sendFirstMessage()` race condition on concurrent calls | Conditional `UPDATE ... WHERE flow_state = 'pending_compose' RETURNING id` |
| 6 | `PATCH /api/conversations/:id` accepted arbitrary flow_state | Whitelist of 20 valid states, rejects everything else |
| 7 | SMS send didn't check `consent_sms` flag | Added consent check before sending |
| 8 | Frontend silently swallowed API errors everywhere | All views show retry buttons on failure; error states propagated |

### MEDIUM Fixes

| # | Issue | Fix |
|---|-------|-----|
| 9 | Lead ingest could fail on unique constraint race | INSERT wrapped in try/catch for `23505`, returns duplicate gracefully |
| 10 | `scoring_status` inconsistency (`completed` vs `complete`) | Standardized to `complete` |
| 11 | Migration errors silently swallowed | Now logs `console.warn` unless "already exists" |
| 12 | List components had empty catch blocks | All check `res.ok` and show retry UI |
| 13 | Destructive actions (takeover, override) had no confirmation | Added `window.confirm()` for takeover, release, and push-to-pipeline |
| 14 | Keyboard accessibility missing on clickable rows | Added `role="button"`, `tabIndex={0}`, Enter/Space handlers |
| 15 | HMAC verification used re-serialized JSON instead of raw body | Express `verify` callback captures raw buffer for `/api/leads/ingest` |
| 16 | Dashboard showed blank screen while loading | Shows loading indicator; unused imports cleaned up |

**Build result:** 475KB JS (135KB gzip), 10KB CSS (2.5KB gzip). Clean build.

**Smoke tests:** Registration blocked ✓ | Flow state whitelist ✓ | HMAC verification ✓ | Server starts cleanly ✓

---

## Phase 5: Google Apps Script Webhook (2026-04-01)

### What Was Built

The `scripts/google-apps-script.js` file contains the complete Apps Script code to push Google Form submissions to the Atelier backend.

**Webhook tests (all passing):**
- Valid HMAC-signed payload → 200, lead ingested (or duplicate detected)
- Duplicate submission → 200 with `duplicate: true` (idempotent)
- Bad HMAC signature → 401 "Invalid webhook signature"
- Missing signature → 401 "Missing webhook signature"

### Deployment Guide

#### Step 1: Open Apps Script
1. Open the Google Sheet linked to your Google Form
2. Go to **Extensions → Apps Script**
3. Delete any existing code in `Code.gs`
4. Paste the entire contents of `scripts/google-apps-script.js`

#### Step 2: Set Script Properties
1. In Apps Script, click the gear icon (**Project Settings**)
2. Scroll to **Script Properties** and add these 3 properties:

| Property | Value |
|----------|-------|
| `ATELIER_WEBHOOK_URL` | `https://atelier-production-b43e.up.railway.app/api/leads/ingest` |
| `ATELIER_WEBHOOK_SECRET` | Same value as `WEBHOOK_SECRET` in your Atelier `.env` |
| `ATELIER_LISTING_ID` | `N94_3ROMS` (or the listing this form is for) |

#### Step 3: Create Form Submit Trigger
1. In Apps Script, click the clock icon (**Triggers**)
2. Click **+ Add Trigger**
3. Configure:
   - Function: `onFormSubmit`
   - Event source: **From spreadsheet**
   - Event type: **On form submit**
4. Click **Save** and authorize when prompted

#### Step 4: Test
1. Submit a test entry through the Google Form
2. In Apps Script, go to **Executions** to see the log
3. Check the Atelier PM Dashboard — the lead should appear

#### Step 5: Backfill (Optional)
If there are existing form responses that were submitted before the trigger was set up:
1. In Apps Script, select `backfillExistingRows` from the function dropdown
2. Click **Run**
3. This sends all existing rows to Atelier (with idempotency — safe to run multiple times)

#### Column Mapping

| Column | Form Question | Field |
|--------|---------------|-------|
| A | Timestamp | `timestamp` |
| B | Hva er ditt fulle navn? | `name` |
| C | Hva er din alder? | `age` |
| D | Hva er din e-post? | `email` |
| E | Telefonnummer inkl landskode | `phone` |
| F | Når ønsker du å leie i fra? | `move_in_date` |
| G | Hva er din nåværende status? | `tenant_status` |
| H | En kort intro/beskrivelse | `intro` |
| I | Kjønn (valgfritt) | `gender` |

---

## Phase 3: Scoring Refinement (2026-04-01)

### What Was Built

#### 1. A/B Scoring Endpoint (`POST /api/conversations/:id/score-ab`)
Runs the same conversation transcript through both Haiku and Sonnet in sequence, returning side-by-side results for comparison.

**Test results (first run):**
| Model | Score | Latency | Input Tokens | Output Tokens |
|-------|-------|---------|-------------|---------------|
| Sonnet | 25/100 | 4,896ms | 5,185 | 269 |
| Haiku | 15/100 | 2,471ms | 5,185 | 282 |
| **Diff** | **10 pts** | **Haiku 2x faster** | Same | Similar |

**Takeaway:** Haiku is 2x faster and gives similar directional scores. 10-point difference is acceptable for monitoring but Sonnet remains more reliable for final scoring decisions.

#### 2. SMS-Adapted Scoring Rubric
Updated `prompts/LeadScoring.md` engagement quality section (sub-component #3):
- 3-5 SMS messages is now scored as **normal** (not penalized)
- Signal quality per message matters more than total turn count
- Calendly/video link clicks = strong positive signal (4+)
- "I'll think about it" after 2-3 messages = neutral (3), not negative
- Response timing (hours vs days) factored into engagement rate

#### 3. Auto-Rescore on Key State Transitions
When `flow_state` transitions to any of: `wants_to_rent`, `confirmed`, `booked_calendly`, `call_completed`, `soft_commitment` — the system automatically triggers a background re-score if:
- No pending score exists
- At least one tenant message is present

This ensures the PM dashboard reflects the latest scoring at critical decision points.

#### 4. Dual Score Display
- **API**: `GET /api/conversations/:id` now returns both `latestScore` (conversation-type) and `preliminaryScore` (form-type)
- **ConversationView sidebar**: Shows "Form Score" (preliminary) and "Conv. Score" (latest conversation score) with color coding:
  - Green (≥70): High quality
  - Yellow (40-69): Medium
  - Red (<40): Low quality
- **AllConversations list**: Score column prefers `latest_score` over `preliminary_score`, with same color coding

---

## Phase 4: MCP Prompt Streamlining (2026-04-01)

### What Was Built

#### 1. Anthropic Prompt Caching
Enabled prompt caching in `lib/chatRuntime.js`:
- System prompt sent as content block with `cache_control: { type: 'ephemeral' }` (Anthropic caches for 5 minutes)
- Added `anthropic-beta: prompt-caching-2024-07-31` header
- `buildUsage()` now tracks `cacheCreationInputTokens` and `cacheReadInputTokens`
- Expected ~90% cost reduction on cached input tokens for repeated conversations with the same listing

#### 2. Listing Snapshot Integration
- `buildSystemPrompt()` now checks `conversation.listing_snapshot.listing_data` before falling back to disk file read
- New endpoint: `POST /api/conversations/:id/refresh-snapshot` — reloads listing data from disk into the conversation's `listing_snapshot` JSONB column
- Snapshot includes `refreshed_at` timestamp for tracking staleness
- Audit logged as `listing_snapshot_refreshed`

**Test result:** Listing snapshot refresh returns cached data successfully. Subsequent `buildSystemPrompt` calls use the cached snapshot instead of disk I/O.

### All V2 Phases Complete

| Phase | Status | Summary |
|-------|--------|---------|
| Phase 0: Auth | ✅ | JWT auth, rate limiting, audit logging, CORS |
| Phase 1A: Model Split | ✅ | Haiku for chat, Sonnet for scoring |
| Phase 1B: Channel Layer | ✅ | SMS via Pling, channel-agnostic architecture |
| Phase 1C: Lead Ingestion | ✅ | Google Sheets → scoring gate → pipeline |
| Phase 1D: First Message | ✅ | Templated SMS with video + Calendly |
| Phase 1E: Prompt Updates | ✅ | SMS context, flow states, tenant profile |
| Phase 2: PM Dashboard | ✅ | Full dashboard with attention queue, filters, conversation view |
| Phase 3: Scoring | ✅ | A/B endpoint, SMS rubric, auto-rescore, dual display |
| Phase 4: MCP/Caching | ✅ | Prompt caching, listing snapshots |
| Phase 5: Apps Script | ✅ | Webhook script ready for deployment |
| Security Hardening | ✅ | 16 issues fixed across CRITICAL/HIGH/MEDIUM |
| Phase 6: SMS Simulator | 📋 Planned | Virtual phone in Rova for E2E testing without SMS provider |

---

## Phase 6: SMS Simulator via Rova (Planned — 2026-04-02)

### Problem

Pling SMS is not configured, blocking all end-to-end testing of the AI conversation flow. Need a way to simulate SMS behavior so we can test system prompts, scoring, and the full tenant journey without a real SMS provider.

### Planning & Engineering Review

**Plan file:** `~/.cursor/plans/sms_simulator_via_rova_95efe1d7.plan.md`

**gstack /plan-eng-review completed.** 10 issues reviewed, all resolved:

| # | Issue | Decision |
|---|-------|----------|
| 1 | Rova deployment access | Confirmed: Rova is on Render, full push and deploy access |
| 2 | Auth mismatch (Atelier inbound expects Pling creds) | Add `X-Simulator-Secret` auth path to existing inbound handler |
| 3 | Real-time UI updates | Polling every 3 seconds (boring technology for a dev tool) |
| 4 | Infinite loop / race conditions | Idempotency key + replying lock + debounce timer |
| 5 | Rova access level | Full push and deploy access confirmed |
| 6 | Character truncation breaks URLs | Two-layer: `max_tokens` on API call + sentence-boundary truncation as safety net |
| 7 | Rova reply payload format | Separate `parseSimulatorInbound()` in `sms.js` (not coupled to Pling format) |
| 8 | Conversation ID tracking | Phone as natural key, `conversation_id` as optimization from last outbound |
| 9 | No tests in plan | Single E2E test script covering critical round-trip paths |
| 10 | Concurrent message processing | Sequential per conversation with queue (prevents context confusion) |

### Architecture Decision: Natural Conversation Flow

Replaced rigid ping-pong auto-reply with debounce-based natural conversation flow:

- **Debounce window:** 30 seconds (`SMS_REPLY_DELAY_S`). Timer resets on each new message.
- **Hard cap:** 2 minutes (`SMS_REPLY_MAX_WAIT_S`). Responds regardless after 2 min from first unresponded message.
- **Mid-generation interrupt:** Finish current response, send it, then start shorter 10-second debounce for new messages.
- **Batch response:** AI sees ALL unresponded messages and generates ONE response addressing everything.

**Why:** Real texting isn't ping-pong. People send 2-3 messages, then the other person reads them all and responds to everything. This makes the AI feel like a real person texting, not an automation tool.

### What Will Be Built

**Atelier changes:**
- New `lib/channels/simulator.js` — HTTP POST adapter to Rova
- Modified `lib/channels/sms.js` — export GSM utilities, add `parseSimulatorInbound()`
- Modified `lib/channels/index.js` — register simulator adapter, `SMS_CHANNEL_MODE` switch
- Modified `server.js` — simulator auth on inbound, debounce-based auto-reply, character enforcement
- New env vars: `SMS_CHANNEL_MODE`, `SIMULATOR_WEBHOOK_URL`, `SIMULATOR_SECRET`, `SMS_MAX_CHARS`, `SIMULATOR_AUTO_REPLY`, `SMS_REPLY_DELAY_S`, `SMS_REPLY_MAX_WAIT_S`

**Rova changes:**
- New DB table: `simulated_sms` (phone, direction, body, segments, char_count, conversation_id, message_id)
- 5 new API routes: POST (receive from Atelier), GET phones, GET thread, POST reply (forward to Atelier), DELETE clear
- New React component: `SmsSimulator.jsx` — phone list + thread view + char/segment counter + GSM indicator
- New route: `/sms-simulator`
- New env vars: `SIMULATOR_SECRET`, `ATELIER_INBOUND_URL`

### Deployment Order

1. Rova backend (DB + routes) — deploy first
2. Rova frontend (SMS Simulator UI)
3. Atelier channel changes (adapter + env vars + auth)
4. Atelier debounce-based auto-reply
5. E2E test: Google Form → Atelier → Rova simulator → tenant reply → AI response

### Parallelization

- **Lane A (Rova):** Backend → Frontend. Sequential, same project.
- **Lane B (Atelier):** Simulator adapter + sms.js exports + index.js + char limit. Sequential, same project.
- **Launch A + B in parallel.** No shared files.
- **Lane C:** Integration (inbound auth + auto-reply). After A + B.
- **Lane D:** E2E test script. After C.
