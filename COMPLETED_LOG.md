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

### What's Next

- Create 2-3 additional listing data files for real N94 units
- Deploy to Render
- Run the V5 Finn prompt evaluation (5 test conversations)
- Run the Lead Scoring prompt evaluation (4 examples from the prompt)
