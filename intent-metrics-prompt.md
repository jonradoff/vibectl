# Intent-Oriented Productivity Metrics — Implementation Prompt

Read CLAUDE.md, VIBECTL.md, and CHANGELOG.md before starting. This is a multi-phase feature. Complete each phase fully (including tests and doc updates per CLAUDE.md conventions) before moving to the next. Do not skip phases.

## Context

The Productivity tab in Mission Control currently shows basic code delta metrics (lines added/removed, bytes, files, prompts) aggregated from `code_deltas`. We want to replace this with an intent-oriented productivity system that automatically extracts developer intents from completed chat sessions, auto-sizes and classifies them, tracks delivery, and surfaces ROI metrics. Zero manual input from the developer — everything is inferred from data we already capture.

### What exists today (do not break any of this):
- `CodeDelta` model + `code_delta_service.go` — records per-prompt git diff stats (lines, bytes, files) via `git diff --numstat` before/after each prompt. Stored in `code_deltas` collection.
- `ChatHistoryEntry` — archives full session transcripts (assistant + user messages as raw JSON, including tool_use blocks with file paths and bash commands). Stored in `chat_history`.
- `ClaudeUsageRecord` — per-response token tracking (input, output, cache read, cache creation, model, session ID, project ID). Stored in `claude_usage_records` with 90-day TTL.
- `ActivityLog` — event journal including `prompt_sent`, `plan_received`, `plan_accepted`, `plan_rejected` entries.
- The Productivity tab in `MissionControl.tsx` (lines 607-735) shows a table of per-project code deltas.
- The git baseline/diff logic in `main.go` (lines 297-421) captures before/after snapshots per prompt.

### Key gap to address first:
`CodeDelta` records only store aggregate line/byte/file counts — NOT which files were changed or their types. The chat history has tool_use blocks with file paths, but nothing extracts them. For intent classification (UI vs. API vs. infra, tech stack tagging), we need per-file change data.

---

## Phase 1: Enrich code delta capture with file-level detail

**Goal:** When recording a `CodeDelta` after each prompt, also store which files changed and their line counts.

1. Add a `FileChange` struct to `internal/models/code_delta.go`:
   ```go
   type FileChange struct {
       Path         string `json:"path" bson:"path"`
       LinesAdded   int64  `json:"linesAdded" bson:"linesAdded"`
       LinesRemoved int64  `json:"linesRemoved" bson:"linesRemoved"`
   }
   ```

2. Add a `Files []FileChange` field to the `CodeDelta` struct.

3. Update `parseNumstat` in `main.go` (around line 325) to return the per-file breakdown in addition to the aggregates. The third field in each numstat line is the file path — it's already there, just not captured.

4. Thread the file list through the code delta recording callback (the `func(projectID, localPath, sessionID string)` at line 355) so it gets stored.

5. No frontend changes yet — this phase is backend-only data enrichment.

---

## Phase 2: Intent model and extraction service

**Goal:** Define the Intent data model and build a service that analyzes archived chat sessions to extract intents.

1. Create `internal/models/intent.go` with:
   ```go
   type Intent struct {
       ID              bson.ObjectID   `json:"id" bson:"_id,omitempty"`
       ProjectID       bson.ObjectID   `json:"projectId" bson:"projectId"`
       SessionIDs      []string        `json:"sessionIds" bson:"sessionIds"`       // chat sessions that contributed
       Title           string          `json:"title" bson:"title"`                 // short name, e.g. "Add pagination to users endpoint"
       Description     string          `json:"description" bson:"description"`     // one-sentence summary
       Category        string          `json:"category" bson:"category"`           // UI | API | infra | data | test | docs | bugfix | refactor
       TechTags        []string        `json:"techTags" bson:"techTags"`           // e.g. ["react", "typescript"] or ["go", "mongodb"]
       UXJudgment      string          `json:"uxJudgment" bson:"uxJudgment"`       // low | medium | high — how much visual/UX taste was required
       Size            string          `json:"size" bson:"size"`                   // S | M | L | XL
       SizePoints      int             `json:"sizePoints" bson:"sizePoints"`       // 1 | 3 | 5 | 8
       Status          string          `json:"status" bson:"status"`               // delivered | partial | abandoned | deferred
       StatusEvidence  string          `json:"statusEvidence" bson:"statusEvidence"` // why the LLM assigned this status
       FilesChanged    []string        `json:"filesChanged" bson:"filesChanged"`   // unique file paths touched
       CommitCount     int             `json:"commitCount" bson:"commitCount"`
       PromptCount     int             `json:"promptCount" bson:"promptCount"`     // user messages in the session
       TokensInput     int64           `json:"tokensInput" bson:"tokensInput"`     // total input tokens consumed
       TokensOutput    int64           `json:"tokensOutput" bson:"tokensOutput"`   // total output tokens consumed
       WallClockSecs   int64           `json:"wallClockSecs" bson:"wallClockSecs"` // session duration
       AnalysisModel   string          `json:"analysisModel" bson:"analysisModel"` // which model did the extraction (e.g. "haiku")
       StartedAt       time.Time       `json:"startedAt" bson:"startedAt"`
       CompletedAt     time.Time       `json:"completedAt" bson:"completedAt"`
       ExtractedAt     time.Time       `json:"extractedAt" bson:"extractedAt"`     // when analysis ran
   }
   ```

2. Create `internal/services/intent_service.go` with:
   - `EnsureIndexes` — indexes on `(projectId, completedAt)`, `(status)`, `(category)`, `(extractedAt)`
   - `Create(ctx, intent)` / `GetByID` / `ListByProject(ctx, projectID, since, limit)` — standard CRUD
   - `GetBySessionID(ctx, sessionID)` — find intents linked to a specific chat session
   - `ListUnanalyzedSessions(ctx)` — query `chat_history` for sessions that don't yet have a linked intent

3. Create `internal/services/intent_extractor.go` — the core analysis logic:
   - `ExtractFromSession(ctx, chatHistoryEntry)` method that:
     a. Walks the `Messages` array and extracts: all user message texts, all tool_use blocks (name + file path), any bash commands that look like git commits
     b. Looks up `CodeDelta` records matching the session ID to get file-level change data (from Phase 1)
     c. Looks up `ClaudeUsageRecord` entries matching the session ID to get token totals
     d. Builds a condensed summary struct (user prompts, files touched with extensions, commands run, token counts, duration, commit evidence)
     e. Sends the condensed summary to Claude API (use Haiku — `claude-haiku-4-5-20251001`) with a structured extraction prompt
     f. Parses the JSON response into one or more `Intent` structs
     g. Stores them via `intent_service`
   - The Haiku prompt should include calibration examples for sizing:
     - S (1 pt): Single-file change, config tweak, copy edit, simple bugfix
     - M (3 pts): 2-5 files across one layer, moderate feature addition
     - L (5 pts): Crosses multiple layers (frontend + backend), new API endpoint with UI, schema migration
     - XL (8 pts): Major new feature, architectural change, new subsystem
   - For delivery status, instruct Haiku to look for: git commit evidence → delivered; developer confirmation phrases → delivered; session ends mid-error or with "never mind" → abandoned; explicit "I'll come back to this" → deferred; code written but no commit → partial

4. For the Claude API call: check if there's already a pattern in the codebase for calling Claude directly (look for any existing `anthropic` or `claude` API client usage, e.g. in the triage feature). Reuse that pattern. If none exists, use a simple HTTP POST to `https://api.anthropic.com/v1/messages` with the API key from environment (`ANTHROPIC_API_KEY`).

---

## Phase 3: Trigger extraction on session archive

**Goal:** Automatically run intent extraction when a chat session is archived.

1. In `chat_session.go`'s `archiveSession` method (around line 607), after the successful `ChatHistoryService.Archive` call, trigger intent extraction asynchronously (don't block the archive flow).

2. Add a background goroutine or async call: `intentExtractor.ExtractFromSessionAsync(chatHistoryEntry)` — fire and forget with its own timeout (30 seconds should be plenty for a Haiku call).

3. Also add a backfill endpoint: `POST /api/v1/intents/backfill` that finds all `chat_history` entries without linked intents and runs extraction on them. This lets us analyze historical sessions. Rate-limit this to process sessions sequentially with a small delay to avoid hammering the API.

4. Wire up the intent service and extractor in `main.go` — initialize them alongside the other services, pass to ChatManager.

---

## Phase 4: Intent API endpoints

**Goal:** Expose intents through the API for the frontend to consume.

1. Create `internal/handlers/intents.go` with routes:
   - `GET /api/v1/intents` — list intents with optional filters: `?projectId=`, `?status=`, `?category=`, `?since=`, `?limit=`
   - `GET /api/v1/intents/{id}` — single intent detail
   - `GET /api/v1/intents/productivity` — aggregated productivity metrics:
     - Per project: total intent points delivered, count by status, count by category, total tokens consumed, average wall-clock time per point
     - Accepts `?days=` filter (default 7)
   - `GET /api/v1/intents/insights` — comparative analysis data:
     - Average tokens-per-point by category (UI vs. API vs. infra etc.)
     - Average tokens-per-point by tech tag
     - Average prompts-per-intent by UX judgment level
     - Trend data: points delivered per day/week over the requested period
   - `POST /api/v1/intents/backfill` — trigger backfill (from Phase 3)
   - `PATCH /api/v1/intents/{id}` — allow manual override of title, size, status, category (for the rare case where the auto-extraction got it wrong — just a simple merge-patch, no form UI needed)

2. Mount routes in `main.go` under `/api/v1/intents`.

3. Update `docs/api.md` with the new endpoints.

---

## Phase 5: Replace the Productivity tab with Intent metrics

**Goal:** Replace the current lines-of-code table with an intent-oriented productivity dashboard.

1. Keep the existing `ProductivityTab` component code but rename it to `CodeDeltaTab` as a secondary/detail view (don't delete it — it's still useful as a raw data view).

2. Build a new `ProductivityTab` that shows:

   **Summary cards row** (top of tab):
   - Total intent points delivered (with trend arrow vs. prior period)
   - Intents completed count
   - Average cycle time (wall-clock per intent)
   - Total token cost (show as formatted token count, not dollars — we don't know their pricing tier)

   **Intents table** (main content):
   - Columns: Project, Intent (title), Category (with colored badge), Size, Status (with icon), Tokens, Duration, Date
   - Sortable by any column
   - Filterable by project, category, status
   - Click an intent row to expand and show: description, files changed, tech tags, UX judgment level, linked session IDs, status evidence
   - Same tag filtering as current tab

   **Insights panel** (collapsible section below table, or a sub-tab):
   - Bar chart: average tokens per point, grouped by category
   - Bar chart: average tokens per point, grouped by primary tech tag
   - Line chart: intent points delivered per week over time
   - Stat: prompts-per-intent by UX judgment level (proving or disproving the hypothesis that high-UX tasks cost more)

3. Use recharts for charts (already available in the frontend dependencies).

4. Add a "Raw Deltas" toggle or sub-tab that shows the old code delta table for users who want the low-level view.

5. Add a "Backfill" button (visible only if there are unanalyzed sessions) that triggers `POST /api/v1/intents/backfill` and shows progress.

---

## Phase 6: Update documentation and changelog

1. Update `docs/api.md` and `frontend/src/pages/docs/APIDocsPage.tsx` with all new endpoints.
2. Update `CHANGELOG.md` with a new version entry describing the feature.
3. Update `README.md` if the feature overview section mentions productivity.
4. Trigger a rebuild via `curl -X POST http://localhost:4380/api/v1/admin/rebuild` after all Go changes are complete.
