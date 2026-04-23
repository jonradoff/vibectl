# VibeCtl

**Command-and-control for the agentic coding era.**

VibeCtl is a self-hosted project management system built for the way software is actually made today: AI agents doing the coding, humans directing strategy. It unifies issue tracking, deployment management, health monitoring, productivity analytics, and product feedback into one integrated workflow designed around Claude Code.

> *We're entering software's creator era — where the gap between idea and working product has collapsed. VibeCtl is the cockpit for that new reality.*

---

![VibeCtl Dashboard](docs/screenshot.png)

## Why VibeCtl

Modern agentic development creates a new coordination problem: you're running multiple AI-assisted projects simultaneously, context windows are finite, and the pace is fast. Jira is too heavyweight. Linear doesn't know about your deployments. GitHub Issues doesn't understand your architecture.

VibeCtl provides:
- A **VIBECTL.md** file per project — the single source of truth that agents read before every session
- An **MCP server** that agents use directly, without leaving Claude Code
- **Productivity analytics** that measure developer output by intent, not lines of code — with per-developer attribution
- A **feedback pipeline** that converts user reports into triaged issues and actionable prompts via Claude
- **Flexible deployment modes** — run solo, run a team server, or connect your local dev environment to a central instance
- **Health checks** that know the difference between "frontend is down" and "backend /healthz is degraded"
- **Multi-user access** via GitHub OAuth with role-based permissions per project

---

## Deployment Modes

VibeCtl supports four deployment configurations. Choose the one that fits your workflow:

### Standalone (Solo Developer)

The default mode. Everything runs on one machine against one MongoDB instance. You get the full UI, Claude Code sessions, issue tracking, feedback, analytics — all local.

**Best for:** Individual developers managing multiple projects from a single workstation.

**Setup:** Just `make dev` and go. No special configuration needed.

### Server (Multi-User)

A production deployment (typically on Fly.io or similar) that multiple team members connect to via the web UI. Supports GitHub OAuth for team login, per-project role-based access, and shared data across all users.

**Best for:** Teams where everyone accesses the same VibeCtl instance through a browser. Claude Code sessions run on the server.

**Setup:** Deploy to Fly.io (or any Docker host), configure `MONGODB_URI`, `BASE_URL`, GitHub OAuth credentials, and `ANTHROPIC_API_KEY`.

### Client Mode

A local VibeCtl instance that connects to a remote server for shared data (projects, issues, feedback) while running Claude Code sessions locally. The local instance handles terminals, chat sessions, and file operations against your local filesystem; everything else comes from the server.

**Best for:** Developers who want local Claude Code sessions with their own filesystem access, but share project data with a team server.

**Setup:** Set `VIBECTL_MODE=client`, `REMOTE_SERVER_URL`, and `REMOTE_API_KEY` in `.env`. The local instance runs on port 4385 by default.

### Dev Standalone with Delegation

A full standalone instance that optionally proxies shared data to a remote production server. Unlike client mode, you have your own complete local database — delegation is an overlay that can be toggled on and off from the Settings page.

When delegation is active:
- **Local:** Claude Code sessions, chat history, terminals, code deltas, file operations
- **Proxied to remote:** Issues, feedback, intents (for team aggregation), prompts, activity logs
- **Pushed to remote:** GitHub-swept feedback and extracted intents are automatically pushed to the remote for team visibility
- A "Remote / Local" toggle in the dashboard header lets you switch between viewing remote team data and your local data

When delegation is off, the instance is fully isolated — identical to standalone mode.

**Best for:** Developers who want their own full VibeCtl instance for local development, with the option to share data with a central team server. You keep working if the server goes down.

**Setup:** Run as standalone, then enable delegation in Settings → Delegation with the remote server URL and an API key. No environment variables needed — configuration is stored in MongoDB and survives restarts.

### Mode Comparison

| Capability | Standalone | Server | Client | Dev Standalone + Delegation |
|-----------|-----------|--------|--------|---------------------------|
| Local Claude Code sessions | Yes | Yes (on server) | Yes | Yes |
| Local filesystem access | Yes | No (server fs) | Yes | Yes |
| Shared team data | No | Yes | Yes | Yes (when delegation on) |
| Works offline | Yes | No | No | Yes (delegation off) |
| Own database | Yes | Yes | No | Yes |
| Multiple users | No | Yes | No | No (single user, team data via delegation) |
| GitHub OAuth | Optional | Yes | Via server | Optional |

---

## Features

### Mission Control Dashboard
- Unified grid view: Mission Control, workspace card, and project cards in a draggable/resizable layout
- **Projects tab**: Activity sparklines, health timelines, issue/feedback counts, last prompt timestamps
- **Productivity tab**: Points delivered, intent counts, tokens consumed, and wall-clock time — per project and per developer
- **Analytics tab**: Donut charts (points by category, investment by project), stacked area chart (points over time), tokens-per-point efficiency bars, delivery funnel
- **Usage tab**: Claude API token consumption per login identity with weekly limits and alert thresholds
- Tag-based filtering, time range selection (7d/30d/60d/90d/365d), developer filter
- Progressive loading: grid renders instantly, data fills in progressively

### Intent-Oriented Productivity
- **Zero-input tracking**: When a Claude Code session ends, Haiku automatically analyzes the conversation and extracts developer intents — what was done, categorized and sized
- Each intent has: title, description, category (UI/API/infra/data/test/docs/bugfix/refactor), size (S/M/L/XL with point values), delivery status, tech tags, UX judgment level
- **Per-developer attribution**: Every intent, code delta, and chat history entry tracks which developer did the work
- **Tokens-per-point**: The novel metric — measures AI efficiency by category, revealing where Claude Code adds the most value
- Backfill endpoint for analyzing historical sessions
- Human review: developers confirm delivery via "Mark Complete" in the project card

### Projects & Issues
- Projects with codes (`LCMS`, `MYAPP`, etc.), goals, links, and deployment config
- Issues with types (bug / feature / idea), priorities (P0-P5), and type-specific status workflows
- Issue comments, bulk operations (priority change, archive), full-text global search
- Decision audit log — every status change is recorded
- Project tags for portfolio filtering

### Health Monitoring
- Per-project health check endpoints (dev + prod URLs for frontend and backend)
- Backend uses the [VibeCtl Health Check Protocol](#health-check-protocol) (`/healthz`)
- 24-hour uptime timeline, 7-day history stored in MongoDB
- Auto-polls every 10 minutes; webhook alerts when services go down or recover

### Feedback Pipeline
- Collect feedback from **GitHub comments** (auto-sweep every 15 min), **manual input**, or the **REST API**
- **AI triage**: Claude analyzes feedback and proposes issue title, type, priority, and repro steps
- **Detail modal**: Full content, metadata, AI analysis, and accept/dismiss — with continuous review mode that advances to the next pending item
- Accept → automatically creates a linked issue using the AI proposal
- **Generate Prompt**: Compile accepted feedback into a structured, safety-scanned prompt and dispatch it directly to a project's Claude Code session. Includes a review/edit modal, danger pattern detection, and automatic navigation to the project card.
- Bulk accept/dismiss and batch AI triage for high-volume feedback
- Paginated feedback list (25 per page) with project, status, and source filters
- **External product integration**: `POST /api/v1/feedback` with API key auth, XSS protection, LLM injection isolation, metadata support, and sourceURL deduplication
- Pending feedback badge on each project card; dedicated Feedback page for cross-project review

### Claude Code Integration
- **Embedded terminal**: Claude Code runs in stream-json mode directly in each project card
- **Plan mode**: Claude's plan mode renders inline as markdown with approve/reject controls
- **Session resume**: `/compact` reloads MCPs and resumes context; `/fresh` starts clean
- **Slash commands**: `/mcp`, `/reload`, `/fresh`, `/usage`, `/permissions`
- **VIBECTL.md generation**: Auto-generated context file with open issues, deployment info, decisions, and architecture summary — Claude Code reads this on startup

### Multi-user Access
- Admin signs in with password; team members sign in via **GitHub OAuth**
- Admin pre-authorizes users by GitHub username and global role
- Per-project roles: owner, devops, developer, contributor, reporter, viewer
- API keys for CLI/MCP access (named tokens, revocable)

### CLI (`vibectl`)
- Full project management from the terminal
- Auth, projects, issues, health, sessions, prompts, decisions, feedback, dashboard
- `--format json` for scripting

### MCP Server
- 24 tools covering projects, issues, sessions, health, prompts, decisions, and feedback
- Agents can capture, triage, and resolve feedback without leaving Claude Code
- See [skill.md](skill.md) for full tool reference

---

## Quick Start

### Prerequisites

- **Go 1.21+**
- **Node.js 18+** (frontend build)
- **MongoDB** — MongoDB Atlas free tier works great; local MongoDB also works

### 1. Get MongoDB

**Option A — MongoDB Atlas (recommended)**
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

Open [http://localhost:4370](http://localhost:4370).

On first launch with no users in the database, VibeCtl runs in **open mode** — no login required. Use `vibectl admin set-password` to set a password and enable the auth gate.

### 4. Configure AI features

AI-powered features (intent extraction, feedback triage, PM review) require an Anthropic API key:

```bash
# Add to .env
ANTHROPIC_API_KEY=sk-ant-api03-...
```

This enables:
- **Intent extraction** — automatic analysis of chat sessions into sized, categorized developer intents
- **Feedback AI triage** — Claude proposes issue title, type, priority, and repro steps from raw feedback
- **Feedback prompt generation** — compile accepted feedback into safety-scanned prompts for Claude Code
- **PM review agent** — on-demand project health assessment
- **Architecture agent** — code architecture analysis

Without this key, VibeCtl works fully — you just won't get AI-powered analysis.

### 5. (Optional) Enable GitHub integration

**GitHub OAuth** lets team members sign in with GitHub:

1. Go to **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**
2. Set **Authorization callback URL**: `http://localhost:4380/api/v1/auth/github/callback`
3. Add to `.env`:
   ```
   GITHUB_CLIENT_ID=your_client_id
   GITHUB_CLIENT_SECRET=your_client_secret
   ```
4. In VibeCtl → **Users**, click **Pre-authorize user** and enter their GitHub username

**GitHub comment sweeper** auto-imports issue/PR comments as feedback:

```bash
# Add to .env
GITHUB_TOKEN=ghp_...
```

Link a GitHub repo URL in each project's Settings tab. VibeCtl sweeps new comments every 15 minutes.

---

## Mode-Specific Setup

### Server mode (production deployment)

Deploy to Fly.io or any Docker host. See [Deploying to Fly.io](#deploying-to-flyio) below.

Required configuration:
- `MONGODB_URI` — production MongoDB (Atlas recommended)
- `DATABASE_NAME` — use a unique name per environment (e.g., `vibectl-prod`)
- `BASE_URL` — your public URL (e.g., `https://your-app.fly.dev`)
- `ALLOWED_ORIGINS` — same as BASE_URL for CORS
- `API_KEY_ENCRYPTION_KEY` — 32-char key for encrypting stored API keys
- `ANTHROPIC_API_KEY` — for AI features
- `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` — for team OAuth login

### Client mode

Set in `.env`:
```bash
VIBECTL_MODE=client
REMOTE_SERVER_URL=https://your-vibectl-server.fly.dev
REMOTE_API_KEY=vk_your_api_key_here
```

The client runs on port 4385 by default (frontend on 4375). It stores local session data in `~/.vibectl-client/`. Create an API key on the remote server first (Settings → API Keys).

### Dev standalone with delegation

No special environment variables needed. Run as normal standalone (`make dev`), then:

1. Go to **Settings → Delegation**
2. Enter the remote server URL and an API key from that server
3. Click **Test Connection** to verify
4. Click **Enable Delegation**

Delegation state is stored in MongoDB and restored on restart. Toggle it off anytime to return to fully isolated mode.

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

Update your GitHub OAuth App's callback URL to:
`https://your-app-name.fly.dev/api/v1/auth/github/callback`

### fly.toml reference

```toml
app = "your-app-name"
primary_region = "iad"

[env]
  PORT = "4380"
  DATABASE_NAME = "vibectl-prod"

[http_service]
  internal_port = 4380
  force_https = true
```

---

## Feedback API

External products can submit end-user feedback via REST. Feedback enters the same pipeline as manual and GitHub-sourced feedback: AI triage, human review, prompt generation, issue creation.

```bash
POST /api/v1/feedback
Authorization: Bearer vk_YOUR_API_KEY
Content-Type: application/json

{
  "projectCode": "MYAPP",
  "rawContent": "The export button doesn't work on Safari",
  "sourceType": "feedback_api",
  "submittedBy": "user@example.com",
  "metadata": {
    "browser": "Safari 17.4",
    "page": "/dashboard/reports"
  }
}
```

Create API keys in VibeCtl under your user profile. Keys are prefixed with `vk_` and used as Bearer tokens.

**Batch submission**: `POST /api/v1/feedback/batch` accepts an array.

**Security**: HTML stripping (XSS), LLM injection isolation (`<user-content>` tags), sourceURL deduplication, API key identity recording. Prompt generation includes regex-based safety scanning for shell injection, credential exfiltration, and prompt injection patterns.

**Webhooks**: `feedback_created` and `feedback_triaged` events fire on configured webhook URLs.

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

### Sessions, Prompts & Decisions

```bash
vibectl sessions MYAPP --limit 5
vibectl prompts list MYAPP
vibectl dashboard
vibectl decisions MYAPP --limit 10
vibectl generate-md MYAPP
vibectl generate-md --all
```

### Global Flags

```
--format json      Output raw JSON (for scripting)
```

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

**Privacy Policy:** VibeCtl's MCP server connects directly to your local MongoDB instance. No data is sent to external servers by the MCP server itself. See [https://www.metavert.io/privacy-policy](https://www.metavert.io/privacy-policy).

---

## Configuration Reference

### Core

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MONGODB_URI` | Yes | `mongodb://localhost:27017` | MongoDB connection string |
| `DATABASE_NAME` | No | `vibectl` | Database name — use different names per environment |
| `PORT` | No | `4380` | HTTP port |
| `BASE_URL` | No | `http://localhost:4380` | Public server URL (used for OAuth callbacks) |
| `ALLOWED_ORIGINS` | No | `http://localhost:4370` | CORS + OAuth redirect origin |
| `REPOS_DIR` | No | `/data/repos` | Directory for cloned project repositories |

### AI & Integrations

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | No | — | Enables AI triage, intent extraction, prompt generation, PM review, architecture agents |
| `GITHUB_TOKEN` | No | — | Enables GitHub comment sweeper (auto-imports issue/PR comments as feedback) |
| `GITHUB_CLIENT_ID` | No | — | GitHub OAuth App client ID (for team login) |
| `GITHUB_CLIENT_SECRET` | No | — | GitHub OAuth App client secret |
| `API_KEY_ENCRYPTION_KEY` | No | — | 32-char key for encrypting stored API keys (AES-256-GCM) |

### Client Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBECTL_MODE` | `standalone` | Set to `client` for client mode |
| `REMOTE_SERVER_URL` | — | URL of the remote VibeCtl server |
| `REMOTE_API_KEY` | — | API key for machine-to-machine auth |
| `LOCAL_DATA_DIR` | `~/.vibectl-client` | Directory for local session data |

Dev standalone delegation does not use environment variables — it is configured via the Settings page and stored in MongoDB.

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
  agents/     Claude-backed AI agents (triage, PM review, architecture, prompt generation, safety scanning)
  config/     Environment config loader
  delegation/ Delegation model (proxy, routing, health check)
  handlers/   HTTP request handlers
  ingestion/  GitHub comment sweeper, PR state tracker
  middleware/ Auth, CORS, logging
  models/     MongoDB data models
  mcp/        MCP server + tool handlers
  services/   Business logic (intents, feedback, issues, code deltas, usage, prompt batches)
  terminal/   PTY + WebSocket handlers (chat, shell)

pkg/
  healthz/    Health check protocol implementation (reusable)

frontend/
  src/        React + TypeScript + Vite + Tailwind CSS app
```

---

*VibeCtl is built for solo developers and small teams managing multiple AI-assisted projects. It runs entirely on your infrastructure — your data never leaves your control.*
