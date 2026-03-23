# Claude Code Login on Headless Servers

## Problem

Running Claude Code on a headless server (Docker/Fly.io Alpine container) requires OAuth authentication against the user's Claude subscription. This is fundamentally different from using an Anthropic API key — the OAuth flow uses the user's existing Claude Max/Pro subscription rather than pay-per-token API billing.

## Key Discoveries

### 1. `claude auth login` Cannot Persist Credentials on Alpine

Claude Code stores OAuth tokens in the **system keychain** (macOS Keychain, Linux libsecret/gnome-keyring). Alpine Linux containers have no keychain by default. Even if `claude auth login` successfully completes the OAuth flow, it cannot save the resulting tokens — so the next process launch starts unauthenticated.

Installing `gnome-keyring` + `libsecret` + `dbus` on Alpine creates the keyring infrastructure, but `claude auth login` still has issues with interactive prompts when stdin is piped (it uses Node.js readline which requires a TTY).

### 2. `claude auth login` Stdin Issues

- **Piped stdin doesn't work**: Node.js `readline` in Claude Code detects `!process.stdin.isTTY` and behaves differently. Writing to a pipe connected to stdin doesn't deliver input to the interactive prompt.
- **PTY approach** (via `creack/pty`): Allocating a pseudo-terminal makes Claude think it's interactive. The PTY correctly delivers input with `\r` (carriage return, not `\n`). However, even with PTY, the keychain storage issue remains on Alpine.
- **Auto-newline hazard**: Sending `\n` to stdin early (to dismiss "press Enter" prompts) can be consumed as an empty authorization code, causing the login to fail.

### 3. `CLAUDE_CODE_OAUTH_TOKEN` Environment Variable

Claude Code accepts OAuth tokens via environment variable:

```
CLAUDE_CODE_OAUTH_TOKEN=<access_token>
```

When set, `claude auth status` reports `loggedIn: true` with `authMethod: "oauth_token"`. This completely bypasses the keychain — no need for `claude auth login` at all.

Other relevant env vars discovered in the CLI source:
- `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`
- `CLAUDE_CODE_OAUTH_CLIENT_ID`
- `CLAUDE_CODE_OAUTH_SCOPES`
- `CLAUDE_CODE_ORGANIZATION_UUID`
- `CLAUDE_CODE_USER_EMAIL`
- `CLAUDE_CODE_SESSION_ACCESS_TOKEN`

### 4. OAuth Token Exchange Endpoints

Claude Code's OAuth PKCE flow uses these endpoints:

| Purpose | URL | Server-accessible? |
|---------|-----|-------------------|
| Authorization | `https://claude.ai/oauth/authorize` | N/A (browser redirect) |
| Code callback | `https://platform.claude.com/oauth/code/callback` | N/A (browser page) |
| Token exchange | `https://platform.claude.com/v1/oauth/token` | **Yes** (returns 400 for bad params, not 403) |
| Token exchange | `https://claude.ai/api/oauth/token` | **No** (Cloudflare JS challenge, returns 403) |

**Critical**: The token exchange endpoint is `platform.claude.com/v1/oauth/token`, NOT `claude.ai/api/oauth/token`. The `claude.ai` domain is behind Cloudflare bot protection and blocks server-side requests with 403.

### 5. CORS Blocks Client-Side Token Exchange

Attempting to call `claude.ai/api/oauth/token` from browser JavaScript (client-side `fetch`) fails with CORS errors — the endpoint doesn't include `Access-Control-Allow-Origin` headers for third-party origins.

### 6. OAuth Client ID and Scopes

Claude Code uses a fixed OAuth client ID (found in the CLI source and OAuth URLs):

```
Client ID: 9d1c250a-e61b-44d9-88ed-5944d1962f5e
Redirect URI: https://platform.claude.com/oauth/code/callback
Scopes: org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload
```

### 7. PKCE Flow Parameters

The OAuth flow uses PKCE (Proof Key for Code Exchange) with S256 challenge method:
- `code_verifier`: 32 random bytes, base64url-encoded (no padding)
- `code_challenge`: SHA-256 hash of code_verifier, base64url-encoded
- `code_challenge_method`: S256

### 8. API Key vs Subscription

- **`ANTHROPIC_API_KEY`**: Pay-per-token API billing. Set as env var. Claude Code uses it directly for inference. No OAuth needed.
- **OAuth token (subscription)**: Uses the user's Claude Max/Pro subscription. Requires OAuth PKCE flow. Token must be stored and refreshed.

These are completely separate billing systems. An API key does NOT use subscription credits.

## Working Solution

### Architecture

1. **Backend generates PKCE params** (`GET /api/v1/admin/claude-login`): Creates `code_verifier`, `code_challenge`, `state`, and builds the full OAuth authorization URL. Returns all params as JSON.

2. **Frontend opens OAuth URL**: The modal auto-opens the authorization URL in a new browser tab. User authenticates with their Claude account.

3. **User pastes authorization code**: After authenticating, Claude's callback page shows an authorization code. User copies it and pastes it into the VibeCtl modal.

4. **Backend exchanges code for token** (`POST /api/v1/admin/claude-login-code`): Receives the code + PKCE verifier from the frontend. Makes a server-side POST to `https://platform.claude.com/v1/oauth/token` to exchange the code for an access token.

5. **Token stored on persistent volume**: The access token is written to `/data/.claude-oauth-token` (Fly.io persistent volume, survives deploys).

6. **Token injected into Claude processes**: When spawning Claude Code processes, the server reads the token file and sets `CLAUDE_CODE_OAUTH_TOKEN` in the process environment.

### Proactive Auth Check

On mount, the Claude Code chat tab calls `GET /api/v1/admin/claude-auth-status` which runs `claude auth status` (with the stored token in env if available). If not logged in, the "Login to Claude" button appears immediately — before the user tries to send a message.

### Token Persistence

The token is stored at `/data/.claude-oauth-token` on Fly.io's persistent volume. The Docker entrypoint symlinks `~/.claude` to `/data/.claude` for any other Claude config files. The token survives container rebuilds and redeployments.

### What Didn't Work

| Approach | Why it failed |
|----------|--------------|
| `claude auth login` with piped stdin | Node.js readline doesn't read from non-TTY stdin |
| `claude auth login` with PTY (`creack/pty`) | Works for input, but no keychain to store the token |
| `claude setup-token` | Requires Ink raw mode TTY, crashes with "Raw mode is not supported" |
| Server-side token exchange with `claude.ai` | Cloudflare JS challenge returns 403 |
| Client-side token exchange via `fetch` | CORS blocks cross-origin POST to `claude.ai` |
| Installing gnome-keyring on Alpine | Keyring runs but `claude auth login` still has TTY/stdin issues |

## Unresolved: Token Exchange Still Fails (400 / 500)

### The Core Problem

Despite sending a well-formed PKCE token exchange request, `platform.claude.com/v1/oauth/token` consistently returns errors:

- **400 "Invalid request format"** — the endpoint doesn't accept our payload
- **500 "Internal server error"** — seen after removing `state` from the payload

The current payload (confirmed correct from Claude Code CLI source inspection):

```json
{
  "grant_type": "authorization_code",
  "code": "<auth code from claude.ai callback>",
  "redirect_uri": "https://platform.claude.com/oauth/code/callback",
  "client_id": "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  "code_verifier": "<pkce verifier>"
}
```

Sent as `Content-Type: application/json` (confirmed from CLI source: Claude Code uses JSON, not form-encoding).

### Hypotheses

#### Hypothesis A: Auth Code Expiration (Most Likely)
OAuth authorization codes are typically valid for **60 seconds**. The manual flow (open browser → authenticate → copy code → switch back to VibeCtl → paste → submit) consistently takes 60–120 seconds. By the time the exchange request is made, the code has expired:
- 400 = server rejecting an expired code as "invalid format" (some implementations)
- 500 = server-side error handling an expired code (implementation-dependent)

**Fix**: Add a visible countdown timer in the login modal. Once the PKCE params are generated (and the auth URL is opened), give the user a 55-second window. If they don't paste the code in time, generate new PKCE params automatically and reopen the auth URL.

#### Hypothesis B: Authorize URL Mismatch
Our authorize URL uses `claude.ai/oauth/authorize`, but the Claude Code CLI source shows:
```
CLAUDE_AI_AUTHORIZE_URL: G7().CONSOLE_AUTHORIZE_URL
```
This suggests the CLI's `CLAUDE_AI_AUTHORIZE_URL` is an alias to the **console** authorize URL (likely `platform.claude.com/oauth/authorize`). If the user authenticates at `claude.ai/oauth/authorize` but the auth server for `platform.claude.com/v1/oauth/token` only accepts codes from `platform.claude.com/oauth/authorize`, the code wouldn't be valid.

However: the user IS successfully landing on `platform.claude.com/oauth/code/callback` after authenticating, suggesting both authorize URLs route to the same OAuth backend.

#### Hypothesis C: Missing/Different Headers
The CLI may send additional headers not in our request:
- `User-Agent: claude-code/<version>`
- `anthropic-client-name: claude-code`
- `anthropic-version: <version>`

Some OAuth servers validate the User-Agent or require Anthropic-specific headers.

#### Hypothesis D: `state` Parameter Side Effects
The state parameter was included in early attempts (causing 400) and removed (then got 500). The state nonce is a CSRF mechanism — it's NOT a token endpoint parameter. It should never be sent to the token endpoint. After removal, the 500 may be a coincidence (expired code) rather than related to the change.

### What Was Tried

| Variation | Result |
|-----------|--------|
| JSON body with `state` included | 400 Invalid request format |
| JSON body without `state` | 500 Internal server error |
| `application/x-www-form-urlencoded` body | 400 Invalid request format |
| Both `claude.ai/api/oauth/token` (original) | 403 Cloudflare block |
| `platform.claude.com/v1/oauth/token` without headers | 400 or 500 |
| Added `User-Agent: claude-code/1.0.0` + `anthropic-client-name` headers | **400 `invalid_grant`: "Invalid 'code' in request."** ← request format now accepted |

The `invalid_grant` error confirms the **request format is now correct** — the new headers resolved the format rejection. The code itself is being rejected, almost certainly due to expiration.

### Potential Solutions

1. **Countdown timer** — Most actionable. Ensure user submits within 55 seconds. The modal should show "Code expires in: 45s" and auto-refresh PKCE params if expired.

2. **Browser-side exchange** — Try doing the token exchange directly from the browser JS (not server-side), making a `fetch` to `platform.claude.com/v1/oauth/token`. The `claude.ai` endpoint has CORS issues, but `platform.claude.com` might allow cross-origin requests. If successful, send the token to the backend for storage.

3. **Add User-Agent header** — Mirror what Claude Code sends:
   ```go
   tokenReq.Header.Set("User-Agent", "claude-code/1.0")
   tokenReq.Header.Set("anthropic-client-name", "claude-code")
   ```

4. **Inspect actual CLI traffic** — Capture network traffic from a real `claude auth login` run to see the exact headers and payload. Would definitively resolve the mystery.

## File Locations

- Token storage: `/data/.claude-oauth-token` (persistent volume)
- Claude config: `/home/vibectl/.claude` → symlink to `/data/.claude`
- Claude Code install: `/usr/local/lib/node_modules/@anthropic-ai/claude-code/`
- Backend login handler: `internal/handlers/admin.go` (ClaudeLogin, ClaudeLoginCode, ClaudeAuthStatus)
- Frontend login modal: `frontend/src/components/chat/ChatView.tsx` (ClaudeLoginModal)
- Token injection: `internal/terminal/chat_session.go` (startProcess reads token file)
- Docker entrypoint: `docker-entrypoint.sh` (symlinks, backup restore)
