# VibeCtl CLI Documentation

**Binary**: `vibectl`
**Version**: 0.8.0

The `vibectl` CLI provides terminal-native access to all VibeCtl features. Useful for scripting, automation, and quick operations without opening the web UI.

## Installation

```bash
make build-cli
# Produces: ./cli/vibectl
# Add to PATH or use full path
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `VIBECTL_URL` | `http://localhost:4380` | Server base URL |
| `VIBECTL_TOKEN` | (reads `~/.vibectl/token`) | Bearer auth token |

## Authentication

```bash
# First time: set a password
vibectl admin set-password

# Login (saves token to ~/.vibectl/token)
vibectl admin login

# Logout (removes saved token)
vibectl admin logout
```

## Commands

### Global Flags
```
--format json    Output raw JSON (useful for scripting with jq)
```

### admin

```bash
vibectl admin login               # Prompt for password, save token
vibectl admin set-password        # Set or change admin password (min 8 chars)
vibectl admin logout              # Remove saved token
```

### projects

```bash
vibectl projects list
vibectl projects create --name "My App" --code MYAPP \
  --description "My application" \
  --local-path /Users/me/myapp \
  --github-url https://github.com/me/myapp
```

### issues

```bash
# List issues (with optional filters)
vibectl issues list MYAPP
vibectl issues list MYAPP --priority P0
vibectl issues list MYAPP --status open --type bug

# Create an issue
vibectl issues create MYAPP \
  --title "Login fails on mobile" \
  --type bug \
  --priority P1 \
  --description "..." \
  --repro-steps "1. Open on iPhone..."

# View issue detail
vibectl issues view MYAPP-0042

# Transition status
vibectl issues status MYAPP-0042 fixed

# Search
vibectl issues search "authentication timeout"
```

**Bug status flow**: open → fixed | cannot_reproduce → closed
**Feature status flow**: open → approved | backlogged → implemented → closed
**Idea status flow**: open → closed | backlogged

### feedback

```bash
# Submit feedback for a project
vibectl feedback submit MYAPP --content "The login button is hard to find" \
  --source-type manual \
  --submitted-by "jon"

# List pending feedback
vibectl feedback triage --pending

# List all feedback
vibectl feedback triage
```

### health

```bash
# Current health check
vibectl health MYAPP

# 24-hour uptime history
vibectl health history MYAPP
```

### sessions

```bash
vibectl sessions MYAPP
vibectl sessions MYAPP --limit 5
```

### prompts

```bash
# List prompts (project + global)
vibectl prompts list MYAPP

# List global prompts only
vibectl prompts list

# Get prompt body
vibectl prompts get <prompt-id>
```

### dashboard

```bash
vibectl dashboard
```

Prints totals and per-project issue counts.

### generate-md

```bash
# Generate VIBECTL.md for one project
vibectl generate-md MYAPP

# Generate for all projects
vibectl generate-md --all
```

### decisions

```bash
vibectl decisions MYAPP
vibectl decisions MYAPP --limit 50
```

## Scripting Examples

```bash
# Get all open P0 issues as JSON
vibectl issues list MYAPP --priority P0 --status open --format json

# Create issue from script
vibectl issues create MYAPP \
  --title "Automated: DB connection pool exhausted" \
  --type bug --priority P0 \
  --source monitoring \
  --format json | jq .issueKey

# Check health in CI
STATUS=$(vibectl health MYAPP --format json | jq -r '.[0].status')
[ "$STATUS" = "up" ] || echo "WARN: backend health is $STATUS"
```
