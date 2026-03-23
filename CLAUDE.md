Read VIBECTL.md for current project status, deployment details, and issue context before starting work.

# Build & Restart

VibeCtl is a self-hosted tool that may be running its own Claude Code sessions. When you make changes to Go backend code or frontend code that requires a server restart, use the rebuild endpoint:

```
curl -X POST http://localhost:4380/api/v1/admin/rebuild
```

This will:
1. Broadcast a "server_restarting" event to all connected WebSocket clients (the UI shows a rebuild overlay)
2. Rebuild the Go server binary (`go build -o vibectl-server ./cmd/server/`)
3. Replace the running process with the new binary via `syscall.Exec`

**When to trigger a rebuild:**
- After changing any Go source files (`*.go`) in `cmd/`, `internal/`, or `pkg/`
- The frontend uses Vite with HMR, so `.tsx`/`.ts` changes are picked up automatically — no rebuild needed for frontend-only changes

**When NOT to trigger a rebuild:**
- For frontend-only changes (Vite HMR handles these)
- When only editing non-code files like docs or config

**Self-rebuild flow:**
- `syscall.Exec` replaces the process in-place (same PID, no downtime gap)
- If `syscall.Exec` fails, the process exits and `run-server.sh` (the dev wrapper) automatically rebuilds and restarts
- The frontend shows a "VibeCtl is rebuilding" overlay during this process and auto-reconnects when the server is back
- Your Claude Code session state is persisted and will resume after restart

**Important:** The server MUST be started from the compiled binary (via `make dev` or `./run-server.sh`), NOT via `go run`. The `go run` command spawns a child process that `syscall.Exec` cannot replace.

# Docs Maintenance

Keep the following documentation in sync when making changes:

- **`docs/api.md`** and **`frontend/src/pages/docs/APIDocsPage.tsx`** — Update when adding, removing, or changing any API endpoints.
- **`docs/mcp.md`** and **`frontend/src/pages/docs/MCPDocsPage.tsx`** — Update when adding, removing, or changing any MCP tools.
- **`docs/cli.md`** and **`frontend/src/pages/docs/CLIDocsPage.tsx`** — Update when adding, removing, or changing CLI commands.
- **`skill.md`** — Update when MCP tools change (this is the machine-readable descriptor Claude uses to understand the tool).
- **`CHANGELOG.md`** — Add an entry for every release / significant feature.
- **`README.md`** — Keep the feature overview, CLI reference, and MCP examples up to date.

# Project Script Conventions

VibeCtl expects projects to follow these conventions for deployment automation. When these files exist at the root of a project directory, they are automatically detected and used to pre-configure the project's Deployment Settings.

## `deploy.sh`
Automates the full deployment pipeline to production. Typically wraps steps like building, pushing to a registry, and deploying (e.g., `fly deploy`). Mapped to the **deployProd** command.

## `start.sh`
Starts (or restarts) the local development server. Should be idempotent — safe to run repeatedly. Typically kills any running process on the dev port and starts it fresh. Mapped to the **startDev** command.

Both scripts should be executable (`chmod +x`) and live at the repo root. VibeCtl runs them from the project's local path directory.

When a `fly.toml` is also present, the Fly app name is extracted and used to derive `fly apps start`, `fly apps restart`, and `fly logs` commands for **startProd**, **restartProd**, and **viewLogs** respectively.

Auto-detection is run:
- During project creation (for "Use local path" mode, where the directory already exists)
- As a background step immediately after creation in Clone/New modes
- On demand via the "⚡ Examine fly.toml" and "⚡ Detect start.sh" buttons in project Settings

# UI Conventions

- **No browser dialogs** — Never use `confirm()`, `alert()`, or `prompt()`. Always use a styled React modal instead.

# Tech Stack

- Backend: Go with chi router, MongoDB
- Frontend: React + TypeScript + Vite + Tailwind CSS
- Terminal: xterm.js (PTY mode) and stream-json chat mode
- Build: `make build` (full), `make build-server` (server only), `make check` (type check both)
- Dev: `make dev` (runs `./run-server.sh` — builds + runs binary with auto-restart), `make frontend-dev` (Vite dev server on port 4370)
