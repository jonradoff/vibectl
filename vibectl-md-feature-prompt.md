# Feature: Auto-Maintained VIBECTL.md Per Project

## Overview

Add a new feature to VibeCtl that automatically generates and maintains a `VIBECTL.md` file in each project's local directory (`project.links.localPath`). This file serves as machine-maintained project intelligence — a living document that gives Claude Code sessions instant context about the project's current state, deployment configuration, decision history, and operational details.

The file complements the human-authored `CLAUDE.md` (which contains instructions *to* Claude) by providing automatically-updated context *about* the project.

**Important: `CLAUDE.md` integration.** When VibeCtl generates or updates `VIBECTL.md`, it should also ensure the project's `CLAUDE.md` contains a reference to it. If `CLAUDE.md` exists at the project root, check whether it already contains a reference to `VIBECTL.md`. If not, prepend the following line:

```
Read VIBECTL.md for current project status, deployment details, and issue context before starting work.
```

If `CLAUDE.md` does not exist, create it with that single line. Never overwrite or modify any other content in `CLAUDE.md`.

---

## VIBECTL.md File Format

The file uses clearly delimited Markdown sections. Each section has a marker comment so VibeCtl can surgically update individual sections without rewriting the whole file. The `[Notes]` section is user-owned and must **never** be overwritten.

```markdown
<!-- VIBECTL.md — Auto-maintained by VibeCtl v{version}. Last generated: {ISO 8601 timestamp} -->
<!-- Manual edits in the [Notes] section are preserved. Other sections may be regenerated. -->

# {Project Name} ({Project Code})

## Meta
- **VibeCtl Version:** {version string, e.g. "0.2.0"}
- **Generated:** {ISO 8601 timestamp with timezone, e.g. "2026-03-14T18:30:00Z"}
- **Project ID:** {MongoDB ObjectID hex string}
- **Local Path:** {project.links.localPath}
- **GitHub:** {project.links.githubUrl or "N/A"}

## Status
<!-- vibectl:section:status -->
- **Open Issues:** {total} ({P0 count} P0, {P1 count} P1, {P2 count} P2, {remaining} P3+)
- **Open Bugs:** {count}
- **Open Features:** {count}
- **Open Ideas:** {count}
- **Pending Feedback:** {count} items awaiting triage
- **Last Session:** {summary text from most recent SessionLog, or "No sessions recorded"}
- **Last PM Review:** {date of last PM review, or "Never"}
<!-- vibectl:end:status -->

## Active Focus
<!-- vibectl:section:focus -->
{List all open P0 and P1 issues, one per line, formatted as:}
- **{issueKey}** ({type}, {status}): {title}

{If no P0/P1 issues:}
No critical or high-priority issues open.
<!-- vibectl:end:focus -->

## Goals
<!-- vibectl:section:goals -->
{List each goal from project.goals, one per line:}
- {goal text}

{If no goals defined:}
No project goals defined. Add goals in VibeCtl project settings to enable PM review analysis.
<!-- vibectl:end:goals -->

## Deployment
<!-- vibectl:section:deployment -->
{This section is populated from the project's HealthCheckConfig and any deployment metadata.}

### Environments

**Development:**
- Frontend: {healthCheck.frontend.devUrl or "Not configured"}
- Backend: {healthCheck.backend.devUrl or "Not configured"}

**Production:**
- Frontend: {healthCheck.frontend.prodUrl or "Not configured"}
- Backend: {healthCheck.backend.prodUrl or "Not configured"}

**Monitoring:** {healthCheck.monitorEnv or "Disabled"}

### Health Status
{If health check results are available from the most recent check:}
- {name}: {status} ({url}) — {code or error}

{If no health checks configured:}
Health checks not configured. Add health check URLs in VibeCtl project settings.

### Deployment Commands
{This sub-section is populated from a new field on the Project model — see Data Model Changes below.}

**Start Dev:**
```
{project.deployment.startDev or "Not configured"}
```

**Stop Dev:**
```
{project.deployment.stopDev or "Not configured"}
```

**Deploy Production:**
```
{project.deployment.deployProd or "Not configured"}
```

**Restart Production:**
```
{project.deployment.restartProd or "Not configured"}
```

**View Logs:**
```
{project.deployment.viewLogs or "Not configured"}
```

{If project.deployment.provider is "flyio":}
### Fly.io
- **App Name:** {project.deployment.flyApp}
- **Region:** {project.deployment.flyRegion or "auto"}
- Deploy: `fly deploy`
- Restart: `fly apps restart {flyApp}`
- Logs: `fly logs -a {flyApp}`
- Status: `fly status -a {flyApp}`
- SSH: `fly ssh console -a {flyApp}`

{If project.deployment.notes is not empty:}
### Notes
{project.deployment.notes}
<!-- vibectl:end:deployment -->

## Recent Decisions
<!-- vibectl:section:decisions -->
{Rolling log of the last 20 significant actions, newest first. Each entry is one line:}
- **{ISO date}** — {description of decision}

{Examples of events that generate decision entries:}
- Issue status transitions: "Marked LAST-0012 (data loss on save) as fixed"
- Issue backlogged: "Backlogged LAST-0018 (dark mode) — not aligned with current goals"
- Feedback accepted: "Accepted feedback → created LAST-0024 (rate limiting)"
- Feedback dismissed: "Dismissed feedback #abc123 — duplicate of LAST-0005"
- PM review action: "PM review: created LAST-0025 (missing auth coverage)"
- Issue created: "Created LAST-0026 (P0 bug: auth bypass) from manual report"
- Issue archived: "Archived LAST-0003 (outdated)"

{If no decisions recorded yet:}
No decisions recorded yet.
<!-- vibectl:end:decisions -->

## Recurring Themes
<!-- vibectl:section:themes -->
{AI-generated analysis of patterns in recent feedback and issues. Updated when feedback triage runs.}
{Format as short bullet points:}
- {theme description} ({count} feedback items / {count} related issues in last 30 days)

{If no feedback has been triaged:}
No recurring themes detected yet. Submit and triage feedback to surface patterns.
<!-- vibectl:end:themes -->

## Architecture
<!-- vibectl:section:architecture -->
{AI-generated summary of the project's technical architecture. Updated when a PM review runs or when explicitly triggered.}
{Keep to 3-5 bullet points covering:}
- Primary languages and frameworks
- Key directories and their purpose
- Data storage approach
- Deployment model
- Notable patterns or conventions

{If never generated:}
Architecture summary not yet generated. Run a PM review or trigger VIBECTL.md regeneration to populate.
<!-- vibectl:end:architecture -->

## Notes
<!-- vibectl:section:notes -->
{This section is NEVER overwritten by VibeCtl. Users can add manual notes here.}
{On first generation, include this placeholder:}
_Add your own notes here. This section is preserved across regenerations._
<!-- vibectl:end:notes -->
```

---

## Data Model Changes

### Project Model — Add `Deployment` field

Add a new `Deployment` embedded struct to the Project model:

```go
// In internal/models/project.go

type DeploymentConfig struct {
    Provider    string `json:"provider,omitempty" bson:"provider,omitempty"`       // "flyio", "aws", "vercel", "manual", etc.
    StartDev    string `json:"startDev,omitempty" bson:"startDev,omitempty"`       // command to start dev servers
    StopDev     string `json:"stopDev,omitempty" bson:"stopDev,omitempty"`         // command to stop dev servers
    DeployProd  string `json:"deployProd,omitempty" bson:"deployProd,omitempty"`   // command to deploy to production
    RestartProd string `json:"restartProd,omitempty" bson:"restartProd,omitempty"` // command to restart production
    ViewLogs    string `json:"viewLogs,omitempty" bson:"viewLogs,omitempty"`       // command to view logs
    FlyApp      string `json:"flyApp,omitempty" bson:"flyApp,omitempty"`           // Fly.io app name
    FlyRegion   string `json:"flyRegion,omitempty" bson:"flyRegion,omitempty"`     // Fly.io region
    Notes       string `json:"notes,omitempty" bson:"notes,omitempty"`             // free-text deployment notes (markdown)
}
```

Add to the `Project` struct:
```go
Deployment *DeploymentConfig `json:"deployment,omitempty" bson:"deployment,omitempty"`
```

Add to `UpdateProjectRequest`:
```go
Deployment *DeploymentConfig `json:"deployment,omitempty"`
```

### Project Model — Add `VibectlMdVersion` tracking

Add a field to track when VIBECTL.md was last written, so we can avoid unnecessary writes:

```go
// On Project struct:
VibectlMdGeneratedAt *time.Time `json:"vibectlMdGeneratedAt,omitempty" bson:"vibectlMdGeneratedAt,omitempty"`
```

### Decision Log Model

Create a new model for tracking decisions:

```go
// In internal/models/decision.go

type Decision struct {
    ID        bson.ObjectID `json:"id" bson:"_id,omitempty"`
    ProjectID bson.ObjectID `json:"projectId" bson:"projectId"`
    Timestamp time.Time     `json:"timestamp" bson:"timestamp"`
    Action    string        `json:"action" bson:"action"`       // e.g. "status_change", "feedback_accepted", "pm_review", "issue_created", "issue_archived"
    Summary   string        `json:"summary" bson:"summary"`     // human-readable one-liner
    IssueKey  string        `json:"issueKey,omitempty" bson:"issueKey,omitempty"`
    Metadata  bson.M        `json:"metadata,omitempty" bson:"metadata,omitempty"` // flexible extra data
}
```

### Decision Service

```go
// In internal/services/decision_service.go

type DecisionService struct {
    db *mongo.Database
}

func NewDecisionService(db *mongo.Database) *DecisionService

// Record logs a new decision.
func (s *DecisionService) Record(ctx context.Context, projectID bson.ObjectID, action, summary, issueKey string) error

// ListRecent returns the last N decisions for a project, sorted newest first.
func (s *DecisionService) ListRecent(ctx context.Context, projectID string, limit int) ([]models.Decision, error)

// EnsureIndexes creates indexes on {projectId, timestamp}.
func (s *DecisionService) EnsureIndexes(ctx context.Context) error
```

---

## VIBECTL.md Generator Service

Create a new service that assembles and writes the VIBECTL.md file:

```go
// In internal/services/vibectlmd_service.go

type VibectlMdService struct {
    projects     *ProjectService
    issues       *IssueService
    feedback     *FeedbackService
    sessions     *SessionService
    decisions    *DecisionService
    healthRecords *HealthRecordService
    version      string // VibeCtl version string, passed in from config or build var
}

func NewVibectlMdService(
    projects *ProjectService,
    issues *IssueService,
    feedback *FeedbackService,
    sessions *SessionService,
    decisions *DecisionService,
    healthRecords *HealthRecordService,
    version string,
) *VibectlMdService
```

### Key Methods

```go
// Generate assembles the full VIBECTL.md content for a project.
// It reads the existing file first to preserve the [Notes] section.
func (s *VibectlMdService) Generate(ctx context.Context, projectID string) (string, error)

// WriteToProject generates VIBECTL.md and writes it to the project's localPath.
// Returns an error if the project has no localPath configured.
// Also ensures CLAUDE.md references VIBECTL.md.
func (s *VibectlMdService) WriteToProject(ctx context.Context, projectID string) error

// RegenerateAll regenerates VIBECTL.md for all projects that have a localPath.
func (s *VibectlMdService) RegenerateAll(ctx context.Context) (int, error)

// UpdateSection regenerates only a specific section of an existing VIBECTL.md.
// Used for lightweight updates that don't need full regeneration.
func (s *VibectlMdService) UpdateSection(ctx context.Context, projectID string, sectionName string) error
```

### Section Generation Logic

Each section between `<!-- vibectl:section:{name} -->` and `<!-- vibectl:end:{name} -->` markers is generated independently. When updating, the service:

1. Reads the existing file from `{localPath}/VIBECTL.md`
2. Parses it into sections by the marker comments
3. Regenerates the requested section(s)
4. Preserves the `notes` section exactly as-is
5. Updates the top-level timestamp and version in the header comment
6. Writes the file back

### Notes Section Preservation

When generating, if a `VIBECTL.md` already exists at the project path:
1. Read the file
2. Extract content between `<!-- vibectl:section:notes -->` and `<!-- vibectl:end:notes -->`
3. Carry that content forward into the new generation
4. If the markers are missing (user deleted them), treat the entire old file's notes section as the preserved content

### CLAUDE.md Integration

In `WriteToProject`, after writing `VIBECTL.md`:
1. Check if `{localPath}/CLAUDE.md` exists
2. If yes, read it and check if it contains the string `VIBECTL.md`
3. If the reference is missing, prepend: `Read VIBECTL.md for current project status, deployment details, and issue context before starting work.\n\n`
4. If `CLAUDE.md` doesn't exist, create it with just that line
5. Never modify or remove any existing content in `CLAUDE.md`

---

## Trigger Events

VIBECTL.md should be updated (relevant sections only) in response to these events. Wire these into the existing service/handler code:

### Full Regeneration Triggers
- **Manual trigger:** New API endpoint `POST /api/v1/projects/{id}/vibectl-md/generate`
- **PM review completion:** After `PMReviewAgent.Review()` returns, regenerate the full file (the PM review produces data for the architecture section too)
- **CLI command:** `vibectl generate-md {projectCode}` or `vibectl generate-md --all`

### Partial (Section) Update Triggers

| Event | Sections to update | Where to wire it |
|---|---|---|
| Issue created | `status`, `focus` | `IssueService.Create()` or `issueHandler.Create()` |
| Issue status changed | `status`, `focus`, `decisions` | `IssueService.UpdateStatus()` |
| Issue archived | `status`, `focus`, `decisions` | `IssueService.Archive()` |
| Feedback triage batch | `status`, `themes` | `TriageAgent` completion in `feedbackHandler.TriageBatch()` |
| Feedback accepted → issue | `status`, `focus`, `decisions` | `feedbackHandler.ReviewFeedback()` when action=accept |
| Feedback dismissed | `decisions` | `feedbackHandler.ReviewFeedback()` when action=dismiss |
| Session ended/summarized | `status` (last session) | `SessionService.Update()` when summary is set |
| Project settings changed | `goals`, `deployment`, `meta` | `projectHandler.Update()` |
| Health check recorded | `deployment` (health status) | `HealthCheckHandler.Check()` or the background recorder |

### Implementation Notes for Triggers

- All trigger writes should be **asynchronous** — launch a goroutine so the API response isn't delayed by filesystem I/O. The generator should acquire a per-project mutex to prevent concurrent writes to the same file.
- If the project has no `localPath`, skip silently. Don't error.
- Record a Decision entry for each event that modifies the `decisions` section. The Decision is recorded in MongoDB first, then the section is regenerated from the DB.
- Keep a per-project write mutex in the VibectlMdService to prevent concurrent file writes:

```go
type VibectlMdService struct {
    // ...existing fields...
    writeMu sync.Map // keyed by project ID string → *sync.Mutex
}

func (s *VibectlMdService) projectMu(projectID string) *sync.Mutex {
    v, _ := s.writeMu.LoadOrStore(projectID, &sync.Mutex{})
    return v.(*sync.Mutex)
}
```

---

## Recurring Themes (AI-Generated Section)

When feedback triage runs (batch), after all items are triaged, collect the analysis results and generate a themes summary. This requires a call to the Anthropic API:

```
You are analyzing patterns in user feedback for the project "{project.name}".

Here are the recent feedback items (last 30 days) with their triage analysis:
{list of feedback items with aiAnalysis}

Here are the current open issues:
{list of open issues}

Identify 3-5 recurring themes — patterns where multiple pieces of feedback or issues cluster around the same area. For each theme, note:
- A concise description (one sentence)
- How many feedback items relate to it
- Which existing issues (by key) are related

Return as JSON array:
[{ "theme": "...", "feedbackCount": N, "relatedIssues": ["LAST-0001"] }]
```

Store the result in a new field on the Project document:
```go
RecurringThemes []RecurringTheme `json:"recurringThemes,omitempty" bson:"recurringThemes,omitempty"`

type RecurringTheme struct {
    Theme         string   `json:"theme" bson:"theme"`
    FeedbackCount int      `json:"feedbackCount" bson:"feedbackCount"`
    RelatedIssues []string `json:"relatedIssues" bson:"relatedIssues"`
    UpdatedAt     time.Time `json:"updatedAt" bson:"updatedAt"`
}
```

When generating the `themes` section, read from this stored data rather than re-calling the API.

---

## Architecture Section (AI-Generated)

When a PM review runs, also generate an architecture summary. Add this to the PM review agent flow or as a separate call:

```
You are analyzing the technical architecture of the project at "{localPath}".

Look at the directory structure and key files to determine:
- Primary languages and frameworks
- Key directories and what they contain
- Data storage approach
- Deployment model
- Notable patterns or conventions

Keep the summary to 3-5 concise bullet points.

Directory listing:
{output of `ls -R` or similar, limited to 2 levels deep, excluding node_modules/.git/vendor}
```

Store the result on the Project:
```go
ArchitectureSummary string    `json:"architectureSummary,omitempty" bson:"architectureSummary,omitempty"`
ArchitectureUpdatedAt *time.Time `json:"architectureUpdatedAt,omitempty" bson:"architectureUpdatedAt,omitempty"`
```

**Important:** This requires reading the filesystem, so it can only run for projects where the server has access to `localPath`. If the path is not accessible, skip the architecture section and note "Architecture summary unavailable — local path not accessible from server."

---

## API Endpoints

Add these routes:

```
POST /api/v1/projects/{id}/vibectl-md/generate    — Full regeneration
GET  /api/v1/projects/{id}/vibectl-md              — Return current VIBECTL.md content (reads from filesystem)
GET  /api/v1/projects/{id}/vibectl-md/preview      — Generate and return content without writing to disk
GET  /api/v1/projects/{id}/decisions               — List recent decisions (supports ?limit=N, default 20)
```

### Handler

```go
// In internal/handlers/vibectlmd.go

type VibectlMdHandler struct {
    vibectlMdService *services.VibectlMdService
    decisionService  *services.DecisionService
}

func NewVibectlMdHandler(v *services.VibectlMdService, d *services.DecisionService) *VibectlMdHandler
```

Wire into the router under `/api/v1/projects/{id}/`:
```go
r.Post("/vibectl-md/generate", vibectlMdHandler.Generate)
r.Get("/vibectl-md", vibectlMdHandler.GetCurrent)
r.Get("/vibectl-md/preview", vibectlMdHandler.Preview)
r.Get("/decisions", vibectlMdHandler.ListDecisions)
```

---

## CLI Commands

Add to the CLI tool:

```bash
vibectl generate-md LAST              # Regenerate VIBECTL.md for project LAST
vibectl generate-md --all             # Regenerate for all projects with local paths
vibectl decisions LAST                # List recent decisions for project LAST
vibectl decisions LAST --limit 50     # List last 50 decisions
```

The `generate-md` command should call the API endpoint, not generate locally, so it uses the same logic.

---

## MCP Server — Add Tools

Add these tools to the MCP server so Claude Code sessions can interact with VIBECTL.md:

```
get_vibectl_md
  params: { projectCode: string }
  → returns: current VIBECTL.md content as string

regenerate_vibectl_md
  params: { projectCode: string }
  → triggers full regeneration, returns success/error

get_decisions
  params: { projectCode: string, limit?: number }
  → returns: recent decisions list

record_decision
  params: { projectCode: string, summary: string, issueKey?: string }
  → records a manual decision entry (for Claude Code sessions to log their own decisions)

get_deployment_info
  params: { projectCode: string }
  → returns: deployment config including all commands and health status
```

The `record_decision` tool is particularly important — it lets a Claude Code session log significant decisions it makes during development, which then appear in VIBECTL.md on next regeneration.

---

## Frontend Changes

### Project Settings Tab — Deployment Section

Add a "Deployment" section to the existing `ProjectSettings` component (`frontend/src/components/projects/ProjectSettings.tsx`):

- **Provider** dropdown: Fly.io, AWS, Vercel, Manual, Other
- **Commands** text inputs: Start Dev, Stop Dev, Deploy Production, Restart Production, View Logs
- **Fly.io specific fields** (shown when provider=flyio): App Name, Region
- **Deployment Notes** textarea (markdown)

These fields map to the `DeploymentConfig` on the Project model.

### Project Page — New VIBECTL.md Tab (or Section)

Add a way to view and manage VIBECTL.md from the project page. Options:

**Option A: Add to Settings tab** — Add a "VIBECTL.md" section at the bottom of project settings with:
- "View Current" button → opens a modal/panel showing the rendered Markdown
- "Regenerate" button → calls the generate endpoint
- Last generated timestamp
- Status indicator (file exists / needs update / no local path)

**Option B: Dedicated tab** — Add a "Docs" or "Memory" tab to the project page with:
- Rendered VIBECTL.md content
- Regenerate button
- Inline editor for the Notes section only (saves directly to the file's notes section)
- Decision log below the file content

Go with Option B if there's room in the tab bar, otherwise Option A. The tab should also show the `CLAUDE.md` content (read-only) so users can see both files side by side.

### Decision Log in UI

Show the decision log somewhere accessible — either in the new tab above, or as a collapsible section in the project detail header. Display as a reverse-chronological list with date, action icon, and summary text.

---

## Version String

The VibeCtl version should be defined as a build-time variable:

```go
// In internal/config/config.go or a dedicated version.go
var Version = "0.2.0" // updated manually or via ldflags at build time
```

Set via ldflags in the Makefile:
```makefile
VERSION ?= 0.2.0
LDFLAGS = -ldflags "-X github.com/jonradoff/vibectl/internal/config.Version=$(VERSION)"

build:
	cd cmd/server && go build $(LDFLAGS) -o ../../vibectl-server .
	cd cmd/cli && go build $(LDFLAGS) -o ../../vibectl .
	cd cmd/mcp && go build $(LDFLAGS) -o ../../vibectl-mcp .
```

This version appears in the VIBECTL.md header and meta section.

---

## Implementation Order

1. **Data model changes:** Add `DeploymentConfig` to Project, create `Decision` model, add `RecurringThemes` and `ArchitectureSummary` fields to Project, add version config
2. **Decision service:** Implement `DecisionService` with Record/ListRecent/EnsureIndexes
3. **Wire decision recording:** Add `DecisionService.Record()` calls into existing handlers for issue status changes, feedback accept/dismiss, PM review actions, issue creation, issue archiving
4. **VibectlMd service:** Implement the generator — section parsing, assembly, file writing, CLAUDE.md integration, Notes preservation
5. **API endpoints:** Add the handler and routes
6. **Trigger wiring:** Add async VIBECTL.md updates to existing event flows
7. **CLI commands:** Add `generate-md` and `decisions` subcommands
8. **MCP tools:** Add the five new tools to the MCP server
9. **Frontend — Settings:** Add Deployment section to ProjectSettings
10. **Frontend — VIBECTL.md tab:** Add the viewing/regeneration UI
11. **Recurring themes:** Wire the AI analysis into feedback triage completion
12. **Architecture summary:** Wire the AI analysis into PM review or standalone trigger
13. **Testing:** Verify end-to-end — create project, add issues, change statuses, run PM review, check that VIBECTL.md reflects all changes
