package client

import (
	"bufio"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"encoding/json"

	"github.com/jonradoff/vibectl/internal/events"
)

// StartEventRelay connects to the remote server's SSE event stream and
// republishes each event to the local bus. Reconnects automatically on
// disconnect. Call in a goroutine; returns when ctx is done (pass a
// cancellable context to stop it on shutdown).
func StartEventRelay(remoteURL, apiKey string, localBus *events.Bus, stop <-chan struct{}) {
	backoff := 2 * time.Second
	for {
		select {
		case <-stop:
			return
		default:
		}

		if err := connectAndRelay(remoteURL, apiKey, localBus, stop); err != nil {
			slog.Warn("event relay disconnected, reconnecting", "error", err, "backoff", backoff)
		}

		select {
		case <-stop:
			return
		case <-time.After(backoff):
			if backoff < 60*time.Second {
				backoff *= 2
			}
		}
	}
}

func connectAndRelay(remoteURL, apiKey string, localBus *events.Bus, stop <-chan struct{}) error {
	req, err := http.NewRequest(http.MethodGet, remoteURL+"/api/v1/events/stream", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+apiKey)
	req.Header.Set("Accept", "text/event-stream")
	req.Header.Set("Cache-Control", "no-cache")

	client := &http.Client{Timeout: 0} // no timeout for streaming
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	slog.Info("event relay connected to remote server")
	backoff := 2 * time.Second
	_ = backoff

	scanner := bufio.NewScanner(resp.Body)
	done := make(chan struct{})
	go func() {
		defer close(done)
		for scanner.Scan() {
			line := scanner.Text()
			if !strings.HasPrefix(line, "data: ") {
				continue // skip comment/heartbeat lines
			}
			data := strings.TrimPrefix(line, "data: ")
			var e events.Event
			if err := json.Unmarshal([]byte(data), &e); err != nil {
				continue
			}
			if e.Type == "connected" {
				continue // skip the handshake event
			}
			localBus.Publish(e)
		}
	}()

	select {
	case <-stop:
		return nil
	case <-done:
		return scanner.Err()
	}
}
