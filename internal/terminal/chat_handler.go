package terminal

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
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

// ChatWebSocketHandler handles WebSocket connections for chat mode.
type ChatWebSocketHandler struct {
	manager      *ChatManager
	upgrader     websocket.Upgrader
	promptLogger PromptLogger
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

	var activeProjectID string

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

			if h.RoleChecker != nil {
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
						state.ProjectID,
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

		default:
			slog.Warn("unknown chat message type", "type", msg.Type)
		}
	}
}
