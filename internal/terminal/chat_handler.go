package terminal

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os/exec"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ChatWSMessage is the envelope for chat WebSocket messages.
type ChatWSMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// ChatLaunchMessage carries parameters to start a chat session.
type ChatLaunchMessage struct {
	ProjectID string `json:"projectId"`
	LocalPath string `json:"localPath"`
}

// ChatUserMessage carries a user message to send to claude.
type ChatUserMessage struct {
	Text string `json:"text"`
}

// PromptLogger is called when a user sends a prompt to Claude Code.
type PromptLogger func(projectID, text string)

// PlanLogger is called when Claude Code enters plan mode or the user responds to a plan.
type PlanLogger func(projectID, requestID, planText string)

// PlanResponseLogger is called when the user accepts or rejects a plan.
type PlanResponseLogger func(projectID, requestID, status, feedback string)

// CodeDeltaSnapshot is called at the start of a prompt to record baseline state.
type CodeDeltaSnapshot func(projectID, localPath string)

// CodeDeltaRecord is called after a prompt completion to capture changes since snapshot.
type CodeDeltaRecord func(projectID, localPath, sessionID string)

// ChatWebSocketHandler handles WebSocket connections for chat mode.
type ChatWebSocketHandler struct {
	manager            *ChatManager
	upgrader           websocket.Upgrader
	promptLogger       PromptLogger
	planLogger         PlanLogger
	planResponseLogger PlanResponseLogger
	codeDeltaSnapshot  CodeDeltaSnapshot
	codeDeltaRecord    CodeDeltaRecord
	// RoleChecker is an optional function called before starting a new chat session.
	// If it returns role "none" or an error, the launch is rejected.
	// Leave nil to skip the check (standalone mode).
	RoleChecker func(ctx context.Context, projectID string) (string, error)
}

// NewChatWebSocketHandler creates a handler with the given chat manager.
func NewChatWebSocketHandler(manager *ChatManager, promptLogger PromptLogger) *ChatWebSocketHandler {
	return &ChatWebSocketHandler{
		manager:      manager,
		promptLogger: promptLogger,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin: func(r *http.Request) bool {
				return true
			},
		},
	}
}

// extractPlanText tries known field names to find the plan content from a tool input map.
func extractPlanText(input map[string]interface{}) string {
	for _, key := range []string{"plan", "prompt", "content", "text", "message", "description", "plan_text"} {
		if pt, ok := input[key].(string); ok && pt != "" {
			return pt
		}
	}
	// Fallback: serialize the whole input
	if b, err := json.Marshal(input); err == nil {
		return string(b)
	}
	return ""
}

// SetPlanLoggers configures callbacks for plan mode event logging.
func (h *ChatWebSocketHandler) SetPlanLoggers(planLogger PlanLogger, planResponseLogger PlanResponseLogger) {
	h.planLogger = planLogger
	h.planResponseLogger = planResponseLogger
}

// SetCodeDeltaCallbacks configures callbacks for capturing code changes between prompts.
func (h *ChatWebSocketHandler) SetCodeDeltaCallbacks(snapshot CodeDeltaSnapshot, record CodeDeltaRecord) {
	h.codeDeltaSnapshot = snapshot
	h.codeDeltaRecord = record
}

// HandleConnection upgrades to WebSocket and handles chat I/O.
func (h *ChatWebSocketHandler) HandleConnection(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("chat websocket upgrade failed", "error", err)
		return
	}

	slog.Info("chat websocket connection established", "remote", r.RemoteAddr)

	conn.SetReadLimit(maxMessageSize)
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	var wsMu sync.Mutex
	stopCh := make(chan struct{})
	var readerDone chan struct{}
	var unsubscribe chan struct{}

	sendRaw := func(data []byte) error {
		wsMu.Lock()
		defer wsMu.Unlock()
		conn.SetWriteDeadline(time.Now().Add(writeWait))
		return conn.WriteMessage(websocket.TextMessage, data)
	}

	sendJSON := func(msgType string, data interface{}) error {
		var rawData json.RawMessage
		if data != nil {
			b, err := json.Marshal(data)
			if err != nil {
				return err
			}
			rawData = b
		}
		msg := ChatWSMessage{Type: msgType, Data: rawData}
		b, err := json.Marshal(msg)
		if err != nil {
			return err
		}
		return sendRaw(b)
	}

	sendStatus := func(status string) {
		if err := sendJSON("status", map[string]string{"status": status}); err != nil {
			slog.Error("failed to send chat status", "status", status, "error", err)
		}
	}

	var activeProjectID string

	// startReader subscribes to claude's stdout stream and forwards events.
	startReader := func(sess *ChatSession) chan struct{} {
		outputCh, unsub := sess.Subscribe()
		unsubscribe = unsub

		done := make(chan struct{})
		go func() {
			defer close(done)
			for {
				select {
				case <-stopCh:
					return
				case <-sess.Exited():
					sendStatus("exited")
					return
				case data, ok := <-outputCh:
					if !ok {
						sendStatus("exited")
						return
					}
					// Intercept plan mode events for logging.
					// Plans arrive as assistant messages with tool_use blocks named EnterPlanMode/ExitPlanMode,
					// OR as control_request events.
					if h.planLogger != nil && activeProjectID != "" {
						var evt struct {
							Type      string `json:"type"`
							RequestID string `json:"request_id"`
							Request   struct {
								Subtype  string                 `json:"subtype"`
								ToolName string                 `json:"tool_name"`
								Input    map[string]interface{} `json:"input"`
							} `json:"request"`
							Message struct {
								Content []struct {
									Type  string                 `json:"type"`
									ID    string                 `json:"id"`
									Name  string                 `json:"name"`
									Input map[string]interface{} `json:"input"`
								} `json:"content"`
							} `json:"message"`
						}
						if json.Unmarshal(data, &evt) == nil {
							// Check control_request events
							if evt.Type == "control_request" {
								if evt.Request.Subtype == "plan_mode_respond" || evt.Request.ToolName == "EnterPlanMode" || evt.Request.ToolName == "ExitPlanMode" {
									planText := extractPlanText(evt.Request.Input)
									go h.planLogger(activeProjectID, evt.RequestID, planText)
								}
							}
							// Check assistant messages with plan tool_use blocks
							if evt.Type == "assistant" {
								for _, block := range evt.Message.Content {
									if block.Type == "tool_use" && (block.Name == "EnterPlanMode" || block.Name == "ExitPlanMode" || block.Name == "ExitPlan") {
										planText := extractPlanText(block.Input)
										go h.planLogger(activeProjectID, block.ID, planText)
									}
								}
							}
							// Capture code deltas on prompt completion (result events)
							if evt.Type == "result" && h.codeDeltaRecord != nil && activeProjectID != "" {
								lp := ""
								if s := h.manager.GetSession(activeProjectID); s != nil {
									lp = s.LocalPath
								}
								if lp != "" {
									go h.codeDeltaRecord(activeProjectID, lp, sess.SessionID)
								}
							}
						}
					}
					// Forward the raw JSON event from claude directly
					if err := sendRaw(data); err != nil {
						slog.Debug("failed to send chat event", "error", err)
						return
					}
				}
			}
		}()
		return done
	}

	// Ping ticker
	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				wsMu.Lock()
				conn.SetWriteDeadline(time.Now().Add(writeWait))
				err := conn.WriteMessage(websocket.PingMessage, nil)
				wsMu.Unlock()
				if err != nil {
					return
				}
			case <-stopCh:
				return
			}
		}
	}()

	// Listen for global broadcast messages (e.g. server_restarting).
	broadcastCh := GetGlobalBroadcast().Subscribe()
	go func() {
		defer GetGlobalBroadcast().Unsubscribe(broadcastCh)
		for {
			select {
			case msgType := <-broadcastCh:
				sendJSON(msgType, nil)
			case <-stopCh:
				return
			}
		}
	}()


	defer func() {
		close(stopCh)
		if unsubscribe != nil {
			close(unsubscribe)
		}
		conn.Close()
		if readerDone != nil {
			<-readerDone
		}
		slog.Info("chat websocket connection closed", "remote", r.RemoteAddr)
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Error("chat websocket read error", "error", err)
			}
			return
		}

		var msg ChatWSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			slog.Error("invalid chat websocket message", "error", err)
			continue
		}

		switch msg.Type {
		case "launch":
			var launch ChatLaunchMessage
			if err := json.Unmarshal(msg.Data, &launch); err != nil {
				slog.Error("invalid chat launch message", "error", err)
				sendStatus("error")
				continue
			}

			slog.Info("chat launch requested", "projectID", launch.ProjectID, "localPath", launch.LocalPath)

			// Skip role check for workspace session.
			if h.RoleChecker != nil && launch.ProjectID != "__workspace__" {
				role, err := h.RoleChecker(r.Context(), launch.ProjectID)
				if err != nil || role == "none" {
					errMsg := "insufficient permissions for project"
					if err != nil {
						errMsg = err.Error()
					}
					conn.WriteJSON(map[string]interface{}{
						"type": "error",
						"data": map[string]string{"message": errMsg},
					})
					return
				}
			}

			// Check for existing live session (reconnection).
			if sess := h.manager.GetSession(launch.ProjectID); sess != nil && sess.IsAlive() {
				slog.Info("reconnecting to existing chat session", "projectID", launch.ProjectID)
				activeProjectID = launch.ProjectID

				// Replay buffered messages.
				for _, m := range sess.Messages() {
					if err := sendRaw(m); err != nil {
						slog.Error("failed to replay chat message", "error", err)
						return
					}
				}

				sendStatus("reconnected")
				readerDone = startReader(sess)
				continue
			}

			// Check for a resumable persisted session (from a previous server run).
			if h.manager.ChatSessionService != nil {
				state, dbErr := h.manager.ChatSessionService.GetResumable(r.Context(), launch.ProjectID)
				if dbErr != nil {
					slog.Error("failed to check for resumable session", "error", dbErr)
				} else if state != nil {
					slog.Info("resuming persisted chat session",
						"projectID", launch.ProjectID,
						"claudeSessionID", state.ClaudeSessionID,
					)

					sess, resumeErr := h.manager.ResumeSession(
						state.ProjectCode,
						state.LocalPath,
						state.ClaudeSessionID,
						state.Messages,
					)
					if resumeErr != nil {
						slog.Error("failed to resume chat session, starting fresh",
							"error", resumeErr,
						)
						// Fall through to start a new session
					} else {
						activeProjectID = launch.ProjectID

						// Replay saved messages to the frontend
						for _, m := range state.Messages {
							if err := sendRaw(m); err != nil {
								slog.Error("failed to replay saved message", "error", err)
								return
							}
						}

						sendStatus("resumed")
						readerDone = startReader(sess)
						continue
					}
				}
			}

			// Start new session.
			sess, err := h.manager.StartSession(launch.ProjectID, launch.LocalPath)
			if err != nil {
				slog.Error("failed to start chat session", "error", err)
				sendJSON("error", map[string]string{"message": err.Error()})
				continue
			}

			activeProjectID = launch.ProjectID
			sendStatus("started")
			readerDone = startReader(sess)

		case "user_message":
			var userMsg ChatUserMessage
			if err := json.Unmarshal(msg.Data, &userMsg); err != nil {
				slog.Error("invalid user message", "error", err)
				continue
			}

			if activeProjectID == "" {
				slog.Warn("user_message received but no active session")
				continue
			}

			sess := h.manager.GetSession(activeProjectID)
			if sess == nil {
				slog.Warn("user_message for unknown session", "projectID", activeProjectID)
				continue
			}

			// Snapshot code state before sending prompt
			if h.codeDeltaSnapshot != nil && sess.LocalPath != "" {
				go h.codeDeltaSnapshot(activeProjectID, sess.LocalPath)
			}

			if err := sess.SendMessage(userMsg.Text); err != nil {
				slog.Error("failed to send message to claude", "projectID", activeProjectID, "error", err)
				sendJSON("error", map[string]string{"message": err.Error()})
			} else if h.promptLogger != nil {
				go h.promptLogger(activeProjectID, userMsg.Text)
			}

		case "interrupt":
			// Send SIGINT to gracefully stop the running claude process.
			if activeProjectID == "" {
				continue
			}
			if intSess := h.manager.GetSession(activeProjectID); intSess != nil {
				if err := intSess.Interrupt(); err != nil {
					slog.Error("failed to interrupt chat session", "projectID", activeProjectID, "error", err)
				} else {
					slog.Info("chat session interrupted", "projectID", activeProjectID)
				}
			}

		case "kill":
			if activeProjectID == "" {
				continue
			}

			if unsubscribe != nil {
				close(unsubscribe)
				unsubscribe = nil
			}

			if err := h.manager.KillSession(activeProjectID); err != nil {
				slog.Error("failed to kill chat session", "projectID", activeProjectID, "error", err)
			} else {
				sendStatus("killed")
			}

			if readerDone != nil {
				<-readerDone
				readerDone = nil
			}
			activeProjectID = ""

		case "restart":
			// Restart the session — used for compacting (resume) or changing permission mode.
			if activeProjectID == "" {
				continue
			}

			var restartMsg struct {
				SkipPermissions bool `json:"skipPermissions"`
			}
			if msg.Data != nil {
				json.Unmarshal(msg.Data, &restartMsg)
			}

			slog.Info("chat restart requested", "projectID", activeProjectID, "skipPermissions", restartMsg.SkipPermissions)

			// Unsubscribe from old session
			if unsubscribe != nil {
				close(unsubscribe)
				unsubscribe = nil
			}
			if readerDone != nil {
				<-readerDone
				readerDone = nil
			}

			// Get the current session's info before killing
			oldSess := h.manager.GetSession(activeProjectID)
			var claudeSessionID string
			var localPath string
			var savedMessages []json.RawMessage
			if oldSess != nil {
				claudeSessionID = oldSess.SessionID
				localPath = oldSess.LocalPath
				savedMessages = oldSess.Messages()
			}

			// Kill old session (but don't mark dead — we'll resume it)
			if oldSess != nil {
				oldSess.Close()
			}
			h.manager.RemoveSession(activeProjectID)

			// Update permission mode
			h.manager.SetSkipPermissions(restartMsg.SkipPermissions)

			// Resume if we have a session ID, otherwise start fresh
			var newSess *ChatSession
			var startErr error
			if claudeSessionID != "" {
				newSess, startErr = h.manager.ResumeSession(activeProjectID, localPath, claudeSessionID, savedMessages)
			} else {
				newSess, startErr = h.manager.StartSession(activeProjectID, localPath)
			}

			if startErr != nil {
				slog.Error("failed to restart chat session", "error", startErr)
				sendJSON("error", map[string]string{"message": startErr.Error()})
				activeProjectID = ""
				continue
			}

			sendStatus("restarted")
			readerDone = startReader(newSess)

		case "fresh_start":
			// Start a completely new session, discarding all context.
			if activeProjectID == "" {
				continue
			}

			var freshMsg struct {
				SkipPermissions bool `json:"skipPermissions"`
			}
			if msg.Data != nil {
				json.Unmarshal(msg.Data, &freshMsg)
			}

			slog.Info("fresh start requested", "projectID", activeProjectID)

			// Unsubscribe from old session
			if unsubscribe != nil {
				close(unsubscribe)
				unsubscribe = nil
			}
			if readerDone != nil {
				<-readerDone
				readerDone = nil
			}

			var localPath string
			if oldSess := h.manager.GetSession(activeProjectID); oldSess != nil {
				localPath = oldSess.LocalPath
				oldSess.Close()
			}
			h.manager.RemoveSession(activeProjectID)
			h.manager.SetSkipPermissions(freshMsg.SkipPermissions)

			// Start fresh — no resume, no session ID
			newSess, startErr := h.manager.StartSession(activeProjectID, localPath)
			if startErr != nil {
				slog.Error("failed to fresh start chat session", "error", startErr)
				sendJSON("error", map[string]string{"message": startErr.Error()})
				activeProjectID = ""
				continue
			}

			sendStatus("restarted")
			readerDone = startReader(newSess)

		case "control_response":
			// Forward permission approval/denial to Claude's stdin.
			if activeProjectID == "" {
				continue
			}
			var ctrlMsg struct {
				RequestID string          `json:"requestId"`
				Response  json.RawMessage `json:"response"`
			}
			if err := json.Unmarshal(msg.Data, &ctrlMsg); err != nil {
				slog.Error("invalid control_response message", "error", err)
				continue
			}
			sess := h.manager.GetSession(activeProjectID)
			if sess == nil {
				continue
			}
			if err := sess.SendControlResponse(ctrlMsg.RequestID, ctrlMsg.Response); err != nil {
				slog.Error("failed to send control response", "error", err)
				sendJSON("error", map[string]string{"message": err.Error()})
			}

			// Log plan responses (accept/reject)
			if h.planResponseLogger != nil {
				var resp struct {
					Behavior string `json:"behavior"`
					Message  string `json:"message"`
				}
				if json.Unmarshal(ctrlMsg.Response, &resp) == nil {
					if resp.Behavior == "allow" || resp.Behavior == "deny" {
						status := "accepted"
						if resp.Behavior == "deny" {
							status = "rejected"
						}
						go h.planResponseLogger(activeProjectID, ctrlMsg.RequestID, status, resp.Message)
					}
				}
			}

		case "set_project_token":
			// Set a per-project Claude OAuth token and restart/launch the session with the new account.
			var tokenMsg struct {
				Token     string `json:"token"`
				ProjectID string `json:"projectId"`
				LocalPath string `json:"localPath"`
			}
			if err := json.Unmarshal(msg.Data, &tokenMsg); err != nil {
				slog.Error("invalid set_project_token message", "error", err)
				continue
			}

			// Determine which project this is for
			pid := activeProjectID
			if pid == "" {
				pid = tokenMsg.ProjectID
			}
			if pid == "" {
				slog.Warn("set_project_token: no project ID available")
				continue
			}

			h.manager.SetProjectToken(pid, tokenMsg.Token)
			slog.Info("per-project Claude token set", "projectID", pid)

			// Tear down old session if one exists
			if unsubscribe != nil {
				close(unsubscribe)
				unsubscribe = nil
			}
			oldSess := h.manager.GetSession(pid)
			lp := tokenMsg.LocalPath
			if oldSess != nil {
				if lp == "" {
					lp = oldSess.LocalPath
				}
				oldSess.Close()
			}
			if readerDone != nil {
				<-readerDone
				readerDone = nil
			}
			h.manager.RemoveSession(pid)

			// Start fresh session (new account = new session, don't resume)
			newSess, startErr := h.manager.StartSession(pid, lp)
			if startErr != nil {
				slog.Error("failed to restart with new token", "error", startErr)
				sendJSON("error", map[string]string{"message": startErr.Error()})
				activeProjectID = ""
				continue
			}
			activeProjectID = pid
			sendStatus("restarted")
			readerDone = startReader(newSess)

		case "login_start":
			// Start PKCE OAuth flow: generate params, open browser, return params to frontend.
			// Does NOT touch the keychain — token is stored per-project in memory only.
			var loginMsg struct {
				ProjectID string `json:"projectId"`
				LocalPath string `json:"localPath"`
			}
			if msg.Data != nil {
				json.Unmarshal(msg.Data, &loginMsg)
			}

			params := generatePKCELogin()
			if params == nil {
				sendJSON("login_status", map[string]string{"status": "error", "message": "Failed to generate login parameters"})
				continue
			}

			// Open browser on macOS
			if err := exec.Command("open", params.AuthURL).Start(); err != nil {
				slog.Error("failed to open browser", "error", err, "url", params.AuthURL[:80])
			}

			sendJSON("login_params", map[string]string{
				"authUrl":      params.AuthURL,
				"codeVerifier": params.CodeVerifier,
				"clientId":     params.ClientID,
				"redirectUri":  params.RedirectURI,
				"state":        params.State,
			})

		case "login_exchange":
			// Exchange an OAuth code for a token and set it per-project.
			var exchangeMsg struct {
				Code         string `json:"code"`
				CodeVerifier string `json:"codeVerifier"`
				ClientID     string `json:"clientId"`
				RedirectURI  string `json:"redirectUri"`
				ProjectID    string `json:"projectId"`
				LocalPath    string `json:"localPath"`
			}
			if err := json.Unmarshal(msg.Data, &exchangeMsg); err != nil {
				sendJSON("login_status", map[string]string{"status": "error", "message": "Invalid exchange message"})
				continue
			}

			token, exchangeErr := exchangeCodeForToken(exchangeMsg.Code, exchangeMsg.CodeVerifier, exchangeMsg.ClientID, exchangeMsg.RedirectURI)
			if exchangeErr != nil {
				sendJSON("login_status", map[string]string{"status": "error", "message": exchangeErr.Error()})
				continue
			}

			pid := activeProjectID
			if pid == "" {
				pid = exchangeMsg.ProjectID
			}
			if pid == "" {
				sendJSON("login_status", map[string]string{"status": "error", "message": "No project context"})
				continue
			}

			h.manager.SetProjectToken(pid, token)

			// Tear down old session
			if unsubscribe != nil {
				close(unsubscribe)
				unsubscribe = nil
			}
			oldSess := h.manager.GetSession(pid)
			lp := exchangeMsg.LocalPath
			if oldSess != nil {
				if lp == "" {
					lp = oldSess.LocalPath
				}
				oldSess.Close()
			}
			if readerDone != nil {
				<-readerDone
				readerDone = nil
			}
			h.manager.RemoveSession(pid)

			newSess, startErr := h.manager.StartSession(pid, lp)
			if startErr != nil {
				sendJSON("login_status", map[string]string{"status": "error", "message": startErr.Error()})
				activeProjectID = ""
				continue
			}
			activeProjectID = pid
			readerDone = startReader(newSess)
			sendJSON("login_status", map[string]string{"status": "success", "message": "Logged in successfully"})
			sendStatus("restarted")

		default:
			slog.Warn("unknown chat message type", "type", msg.Type)
		}
	}
}
