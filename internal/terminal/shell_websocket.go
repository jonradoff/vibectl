package terminal

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jonradoff/vibectl/internal/models"
)

// TokenVerifier is satisfied by AuthSessionService (standalone mode) and
// RemoteTokenVerifier (client mode). It verifies a raw bearer token and
// returns the owning user, or nil if the token is invalid.
type TokenVerifier interface {
	Verify(ctx context.Context, rawToken string) (*models.User, error)
}

// ShellWebSocketHandler handles WebSocket connections for per-user shell sessions.
// Auth token is passed as the ?token= query param (browsers can't set custom WS headers).
type ShellWebSocketHandler struct {
	manager      *Manager
	sessionSvc   TokenVerifier
	upgrader     websocket.Upgrader
	// ShellEnabled, if non-nil, is called on each connection to check whether the
	// experimental shell feature is enabled. When it returns false, only super_admins
	// are allowed through; all other users receive 403.
	ShellEnabled func(ctx context.Context) (bool, error)
}

func NewShellWebSocketHandler(manager *Manager, sessionSvc TokenVerifier) *ShellWebSocketHandler {
	return &ShellWebSocketHandler{
		manager:    manager,
		sessionSvc: sessionSvc,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin:     func(r *http.Request) bool { return true },
		},
	}
}

func (h *ShellWebSocketHandler) HandleConnection(w http.ResponseWriter, r *http.Request) {
	// Authenticate via ?token= query param (WS connections can't send custom headers).
	token := r.URL.Query().Get("token")
	if token == "" {
		http.Error(w, "token required", http.StatusUnauthorized)
		return
	}

	user, err := h.sessionSvc.Verify(r.Context(), token)
	if err != nil || user == nil {
		http.Error(w, "invalid token", http.StatusUnauthorized)
		return
	}

	// Enforce experimental-feature gate: non-super-admins are blocked when disabled.
	if h.ShellEnabled != nil {
		enabled, err := h.ShellEnabled(r.Context())
		if err != nil || (!enabled && user.GlobalRole != models.GlobalRoleSuperAdmin) {
			http.Error(w, "shell feature is not enabled", http.StatusForbidden)
			return
		}
	}

	userID := user.ID.Hex()
	projectID := r.URL.Query().Get("projectId")
	if projectID == "" {
		http.Error(w, "projectId required", http.StatusBadRequest)
		return
	}
	// Optional: local directory to use as the shell's working directory.
	// Used in client mode so the shell opens in the user's local project checkout.
	localWorkDir := r.URL.Query().Get("workDir")
	sessionKey := fmt.Sprintf("user:%s:project:%s", userID, projectID)

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("shell ws upgrade failed", "error", err)
		return
	}

	slog.Info("shell ws connected", "userID", userID, "projectID", projectID, "workDir", localWorkDir, "remote", r.RemoteAddr)

	conn.SetReadLimit(maxMessageSize)
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	var wsMu sync.Mutex
	stopCh := make(chan struct{})

	sendMessage := func(msgType string, data interface{}) error {
		var rawData json.RawMessage
		if data != nil {
			b, _ := json.Marshal(data)
			rawData = b
		}
		msg := WSMessage{Type: msgType, Data: rawData}
		wsMu.Lock()
		defer wsMu.Unlock()
		conn.SetWriteDeadline(time.Now().Add(writeWait))
		return conn.WriteJSON(msg)
	}

	sendStatus := func(status string) {
		sendMessage("status", map[string]string{"status": status}) //nolint:errcheck
	}

	// Start or reconnect shell session immediately on connect.
	sess, err := h.manager.StartShellSession(sessionKey, userID, localWorkDir)
	if err != nil {
		slog.Error("failed to start shell session", "userID", userID, "error", err)
		sendMessage("error", map[string]string{"message": err.Error()}) //nolint:errcheck
		conn.Close()
		return
	}

	// Replay ring buffer so the user sees previous output on reconnect.
	buffered := sess.Buffer.Bytes()
	if len(buffered) > 0 {
		sendMessage("output", map[string]string{"data": string(buffered)}) //nolint:errcheck
	}
	sendStatus("started")

	// Subscribe to PTY output and forward to WebSocket.
	outputCh, unsubscribe := sess.Subscribe()
	ptyReaderDone := make(chan struct{})
	go func() {
		defer close(ptyReaderDone)
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
				sess.UpdateActivity()
				if err := sendMessage("output", map[string]string{"data": string(data)}); err != nil {
					slog.Debug("shell ws send failed", "error", err)
					return
				}
			}
		}
	}()

	// Ping ticker.
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

	// Listen for global broadcast (e.g. server_restarting).
	broadcastCh := GetGlobalBroadcast().Subscribe()
	go func() {
		defer GetGlobalBroadcast().Unsubscribe(broadcastCh)
		for {
			select {
			case msgType := <-broadcastCh:
				sendMessage(msgType, nil) //nolint:errcheck
			case <-stopCh:
				return
			}
		}
	}()

	defer func() {
		close(stopCh)
		close(unsubscribe)
		conn.Close()
		<-ptyReaderDone
		slog.Info("shell ws disconnected", "userID", userID)
	}()

	// Main read loop — handle input and resize messages.
	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Error("shell ws read error", "error", err)
			}
			return
		}

		var msg WSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "input":
			var input InputMessage
			if err := json.Unmarshal(msg.Data, &input); err != nil {
				continue
			}
			if _, err := sess.Write([]byte(input.Data)); err != nil {
				slog.Error("shell write failed", "error", err)
				sendStatus("error")
			}

		case "resize":
			var resize ResizeMessage
			if err := json.Unmarshal(msg.Data, &resize); err != nil {
				continue
			}
			if err := h.manager.Resize(sessionKey, resize.Rows, resize.Cols); err != nil {
				slog.Error("shell resize failed", "error", err)
			}
		}
	}
}
