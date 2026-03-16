package terminal

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = 30 * time.Second

	// Maximum message size allowed from peer.
	maxMessageSize = 64 * 1024
)

// WSMessage is the envelope for all WebSocket messages.
type WSMessage struct {
	Type string          `json:"type"`
	Data json.RawMessage `json:"data,omitempty"`
}

// InputMessage carries terminal input from the client.
type InputMessage struct {
	Data string `json:"data"`
}

// ResizeMessage carries terminal resize dimensions.
type ResizeMessage struct {
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// LaunchMessage carries parameters to start a new session.
type LaunchMessage struct {
	ProjectID   string `json:"projectId"`
	ProjectCode string `json:"projectCode"`
	LocalPath   string `json:"localPath"`
	Prompt      string `json:"prompt,omitempty"`
}

// WebSocketHandler handles WebSocket connections for terminal I/O.
type WebSocketHandler struct {
	manager  *Manager
	upgrader websocket.Upgrader
}

// NewWebSocketHandler creates a handler with the given terminal manager.
func NewWebSocketHandler(manager *Manager) *WebSocketHandler {
	return &WebSocketHandler{
		manager: manager,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
			CheckOrigin: func(r *http.Request) bool {
				return true // Allow all origins in dev
			},
		},
	}
}

// HandleConnection upgrades to WebSocket and handles terminal I/O.
func (h *WebSocketHandler) HandleConnection(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		slog.Error("websocket upgrade failed", "error", err)
		return
	}

	slog.Info("websocket connection established", "remote", r.RemoteAddr)

	conn.SetReadLimit(maxMessageSize)
	conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	// wsMu protects concurrent writes to the websocket connection.
	var wsMu sync.Mutex
	// stopCh signals goroutines to stop when the connection is closing.
	stopCh := make(chan struct{})
	// Tracks the active PTY reader goroutine for cleanup.
	var ptyReaderDone chan struct{}
	// unsubscribe is closed to detach from the session's output broadcast.
	var unsubscribe chan struct{}

	// sendMessage is a thread-safe helper for writing JSON to the websocket.
	sendMessage := func(msgType string, data interface{}) error {
		var rawData json.RawMessage
		if data != nil {
			b, err := json.Marshal(data)
			if err != nil {
				return err
			}
			rawData = b
		}

		msg := WSMessage{Type: msgType, Data: rawData}
		wsMu.Lock()
		defer wsMu.Unlock()
		conn.SetWriteDeadline(time.Now().Add(writeWait))
		return conn.WriteJSON(msg)
	}

	// sendStatus sends a status message with a text payload.
	sendStatus := func(status string) {
		if err := sendMessage("status", map[string]string{"status": status}); err != nil {
			slog.Error("failed to send status", "status", status, "error", err)
		}
	}

	// startPtyReader subscribes to the session's output broadcast and forwards
	// data to the WebSocket. Returns a channel that is closed when the reader exits.
	startPtyReader := func(sess *TerminalSession) chan struct{} {
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
					sess.UpdateActivity()
					payload := map[string]string{"data": string(data)}
					if sendErr := sendMessage("output", payload); sendErr != nil {
						slog.Debug("failed to send output, closing reader", "error", sendErr)
						return
					}
				}
			}
		}()
		return done
	}

	// Ping ticker to keep the connection alive.
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
				sendMessage(msgType, nil)
			case <-stopCh:
				return
			}
		}
	}()

	// Track the currently connected session's project ID.
	var activeProjectID string

	// Main read loop.
	defer func() {
		close(stopCh)
		// Unsubscribe from session output (does NOT kill the session).
		if unsubscribe != nil {
			close(unsubscribe)
		}
		conn.Close()
		// Wait for PTY reader to finish if active.
		if ptyReaderDone != nil {
			<-ptyReaderDone
		}
		slog.Info("websocket connection closed", "remote", r.RemoteAddr)
	}()

	for {
		_, raw, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				slog.Error("websocket read error", "error", err)
			}
			return
		}

		var msg WSMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			slog.Error("invalid websocket message", "error", err)
			continue
		}

		switch msg.Type {
		case "launch":
			var launch LaunchMessage
			if err := json.Unmarshal(msg.Data, &launch); err != nil {
				slog.Error("invalid launch message", "error", err)
				sendStatus("error")
				continue
			}

			slog.Info("launch requested",
				"projectID", launch.ProjectID,
				"projectCode", launch.ProjectCode,
				"localPath", launch.LocalPath,
			)

			// Check for existing session (reconnection).
			if sess := h.manager.GetSession(launch.ProjectID); sess != nil && sess.IsAlive() {
				slog.Info("reconnecting to existing session", "projectID", launch.ProjectID)
				activeProjectID = launch.ProjectID

				// Replay buffered output.
				buffered := sess.Buffer.Bytes()
				if len(buffered) > 0 {
					payload := map[string]string{"data": string(buffered)}
					if err := sendMessage("output", payload); err != nil {
						slog.Error("failed to replay buffer", "error", err)
						return
					}
				}

				sendStatus("reconnected")
				ptyReaderDone = startPtyReader(sess)
				continue
			}

			// Start a new session.
			sess, err := h.manager.StartSession(launch.ProjectID, launch.ProjectCode, launch.LocalPath, launch.Prompt)
			if err != nil {
				slog.Error("failed to start session", "error", err)
				sendMessage("error", map[string]string{"message": err.Error()})
				continue
			}

			activeProjectID = launch.ProjectID
			sendStatus("started")
			ptyReaderDone = startPtyReader(sess)

		case "input":
			var input InputMessage
			if err := json.Unmarshal(msg.Data, &input); err != nil {
				slog.Error("invalid input message", "error", err)
				continue
			}

			if activeProjectID == "" {
				slog.Warn("input received but no active session")
				continue
			}

			sess := h.manager.GetSession(activeProjectID)
			if sess == nil {
				slog.Warn("input for unknown session", "projectID", activeProjectID)
				continue
			}

			if _, err := sess.Write([]byte(input.Data)); err != nil {
				slog.Error("failed to write to pty", "projectID", activeProjectID, "error", err)
				sendStatus("error")
			}

		case "resize":
			var resize ResizeMessage
			if err := json.Unmarshal(msg.Data, &resize); err != nil {
				slog.Error("invalid resize message", "error", err)
				continue
			}

			if activeProjectID == "" {
				continue
			}

			if err := h.manager.Resize(activeProjectID, resize.Rows, resize.Cols); err != nil {
				slog.Error("failed to resize pty", "projectID", activeProjectID, "error", err)
			}

		case "kill":
			if activeProjectID == "" {
				continue
			}

			// Unsubscribe before killing so we don't race.
			if unsubscribe != nil {
				close(unsubscribe)
				unsubscribe = nil
			}

			if err := h.manager.KillSession(activeProjectID); err != nil {
				slog.Error("failed to kill session", "projectID", activeProjectID, "error", err)
			} else {
				sendStatus("killed")
			}

			// Wait for the PTY reader to exit.
			if ptyReaderDone != nil {
				<-ptyReaderDone
				ptyReaderDone = nil
			}
			activeProjectID = ""

		default:
			slog.Warn("unknown message type", "type", msg.Type)
		}
	}
}
