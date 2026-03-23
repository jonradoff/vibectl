# VibeCtl

**Command-and-control for the agentic coding era.**

VibeCtl is a self-hosted project management system built for the way software is actually made today: AI agents doing the coding, humans directing strategy. It unifies issue tracking, deployment management, health monitoring, and product feedback into one integrated workflow designed around Claude Code and similar agentic tools.

> *We're entering software's creator era — where the gap between idea and working product has collapsed. VibeCtl is the cockpit for that new reality.*

---

## Why VibeCtl

Modern agentic development creates a new coordination problem: you're running multiple AI-assisted projects simultaneously, context windows are finite, and the pace is fast. Jira is too heavyweight. Linear doesn't know about your deployments. GitHub Issues doesn't understand your architecture.

VibeCtl provides:
- A **VIBECTL.md** file per project — the single source of truth that agents read before every session
- An **MCP server** that agents use directly, without leaving Claude Code
- A **CLI** for terminal-native workflows and automation
- A **web UI** for visual project management and monitoring
- **Health checks** that know the difference between "frontend is down" and "backend /healthz is degraded"
- **Feedback triage** backed by Claude — user reports automatically convert to issues
- **Team access** via GitHub OAuth — pre-authorize team members by GitHub username, role-based per project

---

## Features

### Projects & Issues
- Projects with codes (`LCMS`, `MYAPP`, etc.), goals, links, and deployment config
- Issues with types (bug / feature / idea), priorities (P0–P5), and type-specific status workflows
- Issue comments / thread for discussion on each issue
- Bulk operations: change priority or archive multiple issues at once
- Full-text global search across all issues
- Decision audit log — every status change is recorded

### Health Monitoring
- Per-project health check endpoints (dev + prod URLs for frontend and backend)
- Backend uses the [VibeCtl Health Check Protocol](#health-check-protocol) (`/healthz`)
- Frontend uses simple 200-response check (no /healthz required)
- 24-hour uptime timeline, 7-day history stored in MongoDB
- Auto-polls every 10 minutes in the background
- Webhook alerts when a service goes down or comes back up

### VIBECTL.md Generation
- Auto-generates a structured markdown file in your project directory
- Contains: open issues by priority, deployment info, recent decisions, architecture summary
- Claude Code reads this on startup — `include: VIBECTL.md` in `settings.json`
- Configurable auto-regen schedule (hourly / daily / weekly) in Settings

### Webhooks
- Per-project webhook endpoints (any number of URLs per project)
- HMAC-SHA256 signature on every payload (`X-Vibectl-Signature: sha256=...`)
- Events: `p0_issue_created`, `health_check_down`, `health_check_up`, `feedback_triaged`
- See [API docs](docs/api.md) for payload format and signature verification

### Feedback Queue
- Collect feedback from GitHub comments, manual input, or API
- Quick ad-hoc feedback from the project card — no need to leave the dashboard
- AI triage with Claude: analyzes feedback and proposes issue title, type, priority, and repro steps
- Three-column review panel (Pending | Accepted | Dismissed) directly in each project card
- Accept → automatically creates an issue using the AI proposal; linked issue key shown inline
- Bulk accept/dismiss and batch AI triage for high-volume feedback
- Pending feedback badge on each project card for at-a-glance review status
- Recurring theme detection across feedback
- Webhook fires after each AI triage completes

### Sessions & Activity
- Work session tracking — log what was worked on, summaries
- Activity log for all significant events
- Chat history for Claude Code sessions

### Multi-user Access
- Admin signs in with password; team members sign in via **GitHub OAuth**
- Admin pre-authorizes users by GitHub username and global role
- Unauthorized GitHub accounts get a clear "ask your admin" screen
- Per-project roles: owner, devops, developer, contributor, reporter, viewer
- API keys for CLI/MCP access (named tokens, revocable)

### CLI (`vibectl`)
- Full project management from the terminal
- Auth token stored in `~/.vibectl/token`
- `--format json` for scripting

### MCP Server
- Local stdio transport — no HTTP, no port, works directly with Claude Code
- 24 tools covering projects, issues, sessions, health, prompts, decisions, and **feedback**
- Agents can capture, triage, and resolve feedback without leaving Claude Code
- See [skill.md](skill.md) for full tool reference

---

## Quick Start

### Prerequisites

- **Go 1.21+**
- **Node.js 18+** (frontend build)
- **MongoDB** — MongoDB Atlas free tier works great; local MongoDB also works

### 1. Get MongoDB

**Option A — MongoDB Atlas (recommended for first-timers)**
1. Sign up at [cloud.mongodb.com](https://cloud.mongodb.com) — free tier is sufficient
2. Create a cluster, then click **Connect → Drivers** and copy the connection string
3. It looks like: `mongodb+srv://username:password@cluster0.xxxxx.mongodb.net/`

**Option B — Local MongoDB**
```bash
# macOS
brew install mongodb-community && brew services start mongodb-community
# MONGODB_URI=mongodb://localhost:27017
```

### 2. Clone and configure

```bash
git clone https://github.com/jonradoff/vibectl
cd vibectl

cp .env.example .env
# Edit .env — at minimum set MONGODB_URI
```

### 3. Start the server

```bash
make dev          # builds + runs backend on :4380
make frontend-dev # in another terminal — Vite dev server on :4370 with HMR
```

Open [http://localhost:4370](http://localhost:4370) (or :4380 for the production build).

On first launch with no users in the database, VibeCtl runs in **open mode** — no login required. Use `vibectl admin set-password` to set a password and enable the auth gate.

### 4. (Optional) Enable GitHub OAuth for team access

This lets team members sign in with their GitHub accounts instead of needing a shared password.

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Fill in:
   - **Homepage URL**: `http://localhost:4380` (your server URL)
   - **Authorization callback URL**: `http://localhost:4380/api/v1/auth/github/callback`
3. Copy the **Client ID** and generate a **Client Secret**
4. Add to `.env`:
   ```
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```
5. Restart the server
6. In VibeCtl → **Users**, click **Pre-authorize user** and enter their GitHub username

Team members navigate to VibeCtl, click **Continue with GitHub**, and are in. Users not pre-authorized see an "access denied" screen with instructions to ask the admin.

---

## Deploying to Fly.io

```bash
# Create app (first time only)
fly apps create your-app-name --org personal

# Set production secrets
fly secrets set \
  MONGODB_URI="mongodb+srv://..." \
  DATABASE_NAME="vibectl-prod" \
  BASE_URL="https://your-app-name.fly.dev" \
  ALLOWED_ORIGINS="https://your-app-name.fly.dev" \
  API_KEY_ENCRYPTION_KEY="$(openssl rand -hex 16)" \
  ANTHROPIC_API_KEY="sk-ant-..." \
  GITHUB_CLIENT_ID="your_github_client_id" \
  GITHUB_CLIENT_SECRET="your_github_client_secret"

# Deploy
fly deploy
```

**For GitHub OAuth in production**, update your GitHub OAuth App's callback URL to:
`https://your-app-name.fly.dev/api/v1/auth/github/callback`

### fly.toml reference

```toml
app = "your-app-name"
primary_region = "iad"

[env]
  PORT = "4380"
  DATABASE_NAME = "vibectl-prod"   # override per-environment

[http_service]
  internal_port = 4380
  force_https = true
```

---

## CLI Reference

```
vibectl <command> <action> [flags]
```

### Authentication

```bash
vibectl admin set-password        # Set/change the admin password
vibectl admin login               # Authenticate, saves token to ~/.vibectl/token
vibectl admin logout              # Remove saved token
```

### Projects

```bash
vibectl projects list
vibectl projects create --name "My App" --code MYAPP --local-path /code/myapp
```

### Issues

```bash
vibectl issues list MYAPP
vibectl issues list MYAPP --priority P0 --status open
vibectl issues create MYAPP --title "Login fails on mobile" --type bug --priority P1 \
  --repro-steps "Open on iPhone, tap Login"
vibectl issues view MYAPP-0042
vibectl issues status MYAPP-0042 fixed
vibectl issues search "authentication timeout"
```

### Health

```bash
vibectl health MYAPP              # Current health check
vibectl health history MYAPP      # 24-hour uptime history
```

### Sessions & Prompts

```bash
vibectl sessions MYAPP --limit 5
vibectl prompts list MYAPP
vibectl prompts get <id>
```

### Dashboard & Decisions

```bash
vibectl dashboard
vibectl decisions MYAPP --limit 10
vibectl generate-md MYAPP
vibectl generate-md --all
```

### Global Flags

```
--format json      Output raw JSON (for scripting)
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBECTL_URL` | `http://localhost:4380` | Server base URL |
| `VIBECTL_TOKEN` | (reads `~/.vibectl/token`) | Bearer auth token |

---

## Configure MCP in Claude Code

Add to `~/.claude.json` (user scope) or `.mcp.json` (project scope):

```json
{
  "mcpServers": {
    "vibectl": {
      "command": "/path/to/vibectl/vibectl-mcp",
      "args": [
        "--mongodb-uri", "mongodb://localhost:27017",
        "--database", "vibectl"
      ]
    }
  }
}
```

Or with Atlas:
```json
{
  "mcpServers": {
    "vibectl": {
      "command": "/path/to/vibectl/vibectl-mcp",
      "args": ["--mongodb-uri", "mongodb+srv://...", "--database", "vibectl"]
    }
  }
}
```

**Privacy Policy:** VibeCtl's MCP server connects directly to your local MongoDB instance. No data is sent to external servers by the MCP server itself. See [https://www.metavert.io/privacy-policy](https://www.metavert.io/privacy-policy) for full details.

---

## Configuration Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGODB_URI` | Yes | `mongodb://localhost:27017` | MongoDB connection string |
| `DATABASE_NAME` | No | `vibectl` | Database name — use different names per environment |
| `PORT` | No | `4380` | HTTP port |
| `BASE_URL` | No | `http://localhost:4380` | Public server URL (used for OAuth callbacks) |
| `ALLOWED_ORIGINS` | No | `http://localhost:4370` | CORS + OAuth redirect origin |
| `ANTHROPIC_API_KEY` | No | — | Enables AI triage, PM review, architecture agents |
| `GITHUB_TOKEN` | No | — | Enables GitHub comment sweeper |
| `GITHUB_CLIENT_ID` | No | — | GitHub OAuth App client ID |
| `GITHUB_CLIENT_SECRET` | No | — | GitHub OAuth App client secret |
| `API_KEY_ENCRYPTION_KEY` | No | — | 32-char key for encrypting stored API keys |

---

## MCP Working Examples

The MCP server provides 20 tools for Claude Code. Here are 5 working examples:

### 1. Get project status before starting work

```
Use vibectl MCP tool: get_vibectl_md(projectCode: "LCMS")
```

Returns the full VIBECTL.md — open issues by priority, deployment commands, recent decisions, architecture summary, and goals. Claude Code should read this at the start of every session.

### 2. Create a bug after finding a regression

```
Use vibectl MCP tool: create_issue(
  projectCode: "LCMS",
  title: "Upload fails when filename contains spaces",
  description: "File upload returns 400 when the original filename has spaces.",
  type: "bug",
  priority: "P1",
  reproSteps: "1. Pick a file named 'my document.pdf'\n2. Click Upload\n3. See 400"
)
```

### 3. Search for existing issues before filing a new one

```
Use vibectl MCP tool: search_issues(query: "upload filename spaces", projectCode: "LCMS")
```

### 4. Close an issue and log the decision

```
Use vibectl MCP tool: update_issue_status(issueKey: "LCMS-0017", newStatus: "fixed")
Use vibectl MCP tool: record_decision(
  projectCode: "LCMS",
  summary: "Fixed upload filename handling by URL-encoding in the storage layer.",
  issueKey: "LCMS-0017"
)
```

### 5. Check what's broken in production

```
Use vibectl MCP tool: get_deployment_info(projectCode: "LCMS")
Use vibectl MCP tool: get_health_status(projectCode: "LCMS")
```

---

## Health Check Protocol

VibeCtl implements a health check standard for backend services. Add a `/healthz` endpoint that returns:

```json
{
  "status": "healthy",
  "name": "MyApp Backend",
  "version": "1.2.3",
  "uptime": 86400,
  "dependencies": [
    { "name": "mongodb", "status": "healthy" }
  ],
  "kpis": [
    { "name": "active_users", "value": 142, "unit": "count" }
  ]
}
```

**Status values**: `healthy`, `degraded`, `unhealthy`

The `pkg/healthz` package implements this protocol for Go services:

```go
import "github.com/jonradoff/vibectl/pkg/healthz"

checks := map[string]healthz.CheckFunc{
    "mongodb": func() error { return db.Ping(ctx, nil) },
}
r.Get("/healthz", healthz.Handler("1.0.0", checks, nil))
```

---

## Development

```bash
make dev              # Build + run server with auto-restart on crash
make frontend-dev     # Vite dev server on :4370 with HMR
make build            # Full build (server + CLI + MCP binary)
make build-server     # Server binary only
make check            # Type-check (Go + TypeScript)
```

### Rebuild after Go changes

```bash
curl -X POST http://localhost:4380/api/v1/admin/rebuild
```

The server rebuilds itself in-place (same PID, no downtime) and the UI shows a "rebuilding" overlay.

### Project Structure

```
cmd/
  server/     HTTP API server (chi router)
  cli/        vibectl CLI
  mcp/        MCP stdio server

internal/
  agents/     Claude-backed AI agents (triage, PM review, architecture)
  config/     Environment config loader
  handlers/   HTTP request handlers
  middleware/ Auth, CORS, logging
  models/     MongoDB data models
  mcp/        MCP server + tool handlers
  services/   Business logic layer
  terminal/   PTY + WebSocket handlers

pkg/
  healthz/    Health check protocol implementation (reusable)

frontend/
  src/        React + TypeScript + Vite app
```

---

## Roadmap

### v0.9 (current)
- Project, issue, feedback management with AI triage
- Issue comments and bulk operations
- VIBECTL.md generation with configurable auto-regen schedule
- Claude Code MCP integration (20 tools)
- Health check monitoring with webhook alerting
- Multi-user access: GitHub OAuth, role-based permissions (project + global), API keys
- CI tab: commit, push, deploy actions per project
- Admin auth gate: bcrypt password, 30-day token expiry, auto-logout on 401
- Webhooks: HMAC-signed HTTP POST for P0 issues, health transitions, feedback triage
- Global search across all issues
- Settings page
- CLI with full feature parity
- Fly.io one-command deployment

### Next
- Scheduled PM reviews
- Mobile-friendly PWA

---

*VibeCtl is built for solo developers and small teams managing multiple AI-assisted projects. It runs entirely on-premise — your data never leaves your infrastructure.*
